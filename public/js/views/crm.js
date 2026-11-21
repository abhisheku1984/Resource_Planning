/* =========================================================================
   Embedded mini-CRM.
   Lives beside the employee table so supervisors never leave the project.
   Debounced autosave with explicit Saving / Saved / Unsaved states, retry,
   conflict detection and an inline audit history.
   ========================================================================= */
import {
  h, mount, icon, api, state, toast, fmtRelative, fmtDateTime, fmtDate,
  initials, spinner, emptyState, statusBadge, debounce,
} from '../core.js';

const AUTOSAVE_MS = 900;

export function createCrm({ onChanged, getScope }) {
  const el = h('aside', { class: 'crm-panel', 'aria-label': 'Employee CRM panel' });

  let mode = 'list';         // list | detail | create
  let current = null;        // loaded record
  let pending = new Map();   // key -> {value, original}
  let saveState = 'idle';    // idle | unsaved | saving | saved | error
  let saveTimer = null;
  let retryQueue = null;
  let searchTerm = '';
  let people = [];
  let searchSeq = 0;
  let currentInputs = new Map();   // key -> { input, field, type } for the open form

  const stateHost = h('span');
  const headHost = h('div', { class: 'crm-head' });
  const bodyHost = h('div', { class: 'crm-body' });
  const footHost = h('div', { class: 'crm-foot' });

  mount(el, headHost, bodyHost, footHost);

  /* ------------------------------------------------------------ header */
  function renderHead() {
    const titles = {
      list: ['contact', 'Employee CRM'],
      detail: ['contact', current?.values?.name || 'Employee'],
      create: ['plus', 'New person'],
    };
    const [iconName, label] = titles[mode];
    mount(headHost,
      h('div', { class: 'crm-head-row', style: { display: 'flex', alignItems: 'center', gap: '9px', width: '100%' } },
        h('div', { class: 'crm-title grow' }, icon(iconName, 15), label),
        stateHost,
        mode !== 'list'
          ? h('button', {
            class: 'btn btn-ghost btn-icon', title: 'Back to search', 'aria-label': 'Back to search',
            onclick: () => { if (flushPending(true)) { mode = 'list'; render(); } },
          }, icon('arrowLeft', 15))
          : null,
        h('button', {
          class: 'btn btn-ghost btn-icon', title: 'Close panel', 'aria-label': 'Close CRM panel',
          onclick: () => document.dispatchEvent(new CustomEvent('rp:toggle-crm', { detail: { collapsed: true } })),
        }, icon('x', 15)),
      ),
    );
  }

  function renderSaveState() {
    if (!stateHost) return;
    const map = {
      idle: null,
      unsaved: ['unsaved', 'Unsaved'],
      saving: ['saving', 'Saving…'],
      saved: ['saved', 'Saved'],
      error: ['error', 'Not saved'],
    };
    const entry = map[saveState];
    if (!entry) { mount(stateHost); return; }
    mount(stateHost, h('span', { class: `save-state ${entry[0]}` },
      saveState === 'saving' ? spinner() : h('span', { class: 'dot' }),
      entry[1],
    ));
  }

  function setSaveState(s) {
    saveState = s;
    renderSaveState();
  }

  /* ------------------------------------------------------------ list mode */
  function renderList() {
    const searchInput = h('input', {
      class: 'input', type: 'search', placeholder: 'Search name, ID, email or phone…',
      'aria-label': 'Search people', value: searchTerm,
      oninput: debounce((e) => { searchTerm = e.target.value; runSearch(); }, 260),
    });

    const listHost = h('div', { class: 'crm-list' });

    const paintPeople = () => {
      if (!people.length) {
        mount(listHost, searchTerm
          ? emptyState({
            title: 'No match found',
            message: `Nothing matched “${searchTerm}”. You can create a new person instead.`,
            iconName: 'search',
            action: h('button', { class: 'btn btn-primary btn-sm', onclick: enterCreate }, icon('plus', 14), 'Add new person'),
          })
          : emptyState({
            title: 'Search the directory',
            message: 'Find an existing person to view placements, update contact details or add follow-up notes.',
            iconName: 'contact',
            action: h('button', { class: 'btn btn-primary btn-sm', onclick: enterCreate }, icon('plus', 14), 'Add new person'),
          }));
        return;
      }
      mount(listHost, ...people.map((p) => h('button', {
        class: 'crm-person',
        onclick: () => openPerson(p.id),
      },
        h('div', { class: 'avatar avatar-sm' }, initials(p.name)),
        h('div', { class: 'grow', style: { minWidth: '0' } },
          h('div', { class: 'cp-name truncate' }, p.name),
          h('div', { class: 'cp-meta truncate' }, `${p.emp_code}${p.email ? ` · ${p.email}` : ''}`),
        ),
        h('span', { class: 'count-pill', title: `${p.placements} placement(s)` }, p.placements),
      )));
    };

    mount(bodyHost,
      h('div', { class: 'crm-search' },
        h('div', { class: 'search-box' }, icon('search', 15), searchInput),
        h('button', { class: 'btn btn-primary btn-sm', style: { width: '100%', marginTop: '8px' }, onclick: enterCreate }, icon('plus', 14), 'Add new person'),
      ),
      listHost,
    );
    paintPeople();
    mount(footHost,
      h('span', null, `${people.length} result${people.length === 1 ? '' : 's'}`),
      h('span', { class: 'row', style: { gap: '5px' } }, icon('shield', 12), 'Scope: your projects'),
    );

    runSearch(true).then(() => paintPeople()).catch((e) => {
      mount(listHost, emptyState({ title: 'Search unavailable', message: e.message, iconName: 'alert' }));
    });
    setTimeout(() => searchInput.focus(), 60);
    return { paintPeople };
  }

  async function runSearch(initial = false) {
    const seq = ++searchSeq;
    try {
      const res = await api(`/people?q=${encodeURIComponent(searchTerm)}`);
      if (seq !== searchSeq) return;
      people = res.people || [];
    } catch (err) {
      if (seq !== searchSeq) return;
      people = [];
      if (!initial) toast('Search failed', err.message, 'error');
    }
  }

  /* ------------------------------------------------------------ detail */
  async function openPerson(employeeId, assignmentId = null) {
    setSaveState('idle');
    try {
      const res = await api(`/people/${employeeId}`);
      const placements = res.placements || [];
      const chosen = assignmentId
        ? placements.find((p) => p.assignment_id === Number(assignmentId))
        : placements.find((p) => p.project_id === Number(getScope().projectId)) || placements[0];
      if (!chosen) {
        if (!placements.length) {
          mount(bodyHost, emptyState({ title: 'No placements visible', message: 'This person has no placement in your authorized projects.', iconName: 'info' }));
          mode = 'detail';
          renderHead();
          return;
        }
        toast('Placement required', 'Choose a placement to edit.', 'warn');
        return;
      }
      const rec = await api(`/employees/${chosen.assignment_id}`);
      current = { ...rec.record, placements };
      pending.clear();
      mode = 'detail';
      render();
    } catch (err) {
      toast('Could not open person', err.message, 'error');
    }
  }

  async function openAssignment(assignmentId) {
    if (!flushPending(true)) return;
    setSaveState('idle');
    try {
      const rec = await api(`/employees/${assignmentId}`);
      let placements = current?.employeeId === rec.record.employeeId ? current.placements : null;
      if (!placements) {
        try {
          const person = await api(`/people/${rec.record.employeeId}`);
          placements = person.placements || [];
        } catch { placements = []; }
      }
      current = { ...rec.record, placements };
      pending.clear();
      mode = 'detail';
      render();
    } catch (err) {
      toast('Could not open record', err.message, 'error');
    }
  }

  function renderDetail() {
    const rec = current;
    if (!rec) return;
    const v = rec.values || {};
    const columns = rec.columns || [];
    const colMap = new Map(columns.map((c) => [c.key, c]));
    const canEdit = !!state.user && (state.user.isAdmin || state.user.capabilities?.['employee.edit']);

    currentInputs = new Map();

    const fieldControl = (key, { span2 = false, forceEditable = false, forceType = null } = {}) => {
      const field = state.fields.find((f) => f.key === key) || { key, label: key, type: forceType || 'text' };
      const col = colMap.get(key);
      const editable = canEdit && (forceEditable || !col || col.editable);
      const options = col?.options || field.options;
      const label = col?.label || field.label || key;
      const value = v[key] ?? '';
      let input;
      const type = forceType || field.type;
      if (type === 'select') {
        input = h('select', { class: 'select', disabled: !editable },
          h('option', { value: '' }, 'Not set'),
          ...(options || []).map((o) => h('option', { value: o, selected: String(value) === o }, o)),
        );
      } else if (type === 'textarea') {
        input = h('textarea', { class: 'textarea', rows: 3, disabled: !editable }, value);
      } else if (type === 'date') {
        input = h('input', { class: 'input', type: 'date', value: value || '', disabled: !editable });
      } else if (type === 'number') {
        input = h('input', { class: 'input', type: 'number', value: value ?? '', disabled: !editable });
      } else {
        input = h('input', {
          class: 'input',
          type: type === 'email' ? 'email' : type === 'tel' ? 'tel' : 'text',
          value: value ?? '',
          disabled: !editable,
          autocomplete: 'off',
        });
      }
      input.dataset.fieldKey = key;
      currentInputs.set(key, { input, field, type });
      // listener is deferred so the registry is populated by the time it can fire
      setTimeout(() => {
        input.addEventListener('input', () => queueChange(key));
        input.addEventListener('change', () => queueChange(key));
        input.addEventListener('blur', () => { if (pending.size) flushPending(); });
      }, 0);
      return h('div', { class: `field ${span2 ? 'span-2' : ''}` },
        h('label', { class: 'field-label' },
          label,
          col?.required ? h('span', { class: 'req' }, '*') : null,
          !editable ? h('span', { class: 'badge badge-outline', style: { height: '17px', fontSize: '10px', padding: '0 6px' } }, 'read-only') : null,
        ),
        input,
        h('div', { class: 'field-error hidden' }),
      );
    };

    const historyHost = h('div', { class: 'col', style: { gap: '8px' } });
    loadHistory(rec.assignmentId, historyHost);

    const placementSwitcher = rec.placements?.length > 1
      ? h('select', {
        class: 'select', style: { width: '100%', marginTop: '4px' },
        onchange: (e) => openPerson(rec.employeeId, Number(e.target.value)),
      }, ...rec.placements.map((p) => h('option', { value: p.assignment_id, selected: p.assignment_id === rec.assignmentId }, `${p.project_name} · ${p.category_name}`)))
      : null;

    mount(bodyHost,
      h('div', { class: 'crm-form' },
        h('div', { class: 'row', style: { gap: '11px', paddingBottom: '12px', borderBottom: '1px solid var(--line)' } },
          h('div', { class: 'avatar avatar-lg' }, initials(v.name)),
          h('div', { class: 'col grow', style: { minWidth: '0' } },
            h('div', { class: 'truncate', style: { fontWeight: '650', fontSize: '14px' } }, v.name),
            h('div', { class: 'mono subtle', style: { fontSize: '11.5px' } }, v.emp_code),
            h('div', { class: 'row', style: { gap: '5px', marginTop: '4px', flexWrap: 'wrap' } },
              statusBadge(v.status),
              h('span', { class: 'badge badge-outline' }, rec.categoryName),
            ),
          ),
        ),
        h('div', { class: 'crm-section-title' }, 'Identity'),
        h('div', { class: 'crm-grid' },
          fieldControl('emp_code', { forceType: 'text' }),
          fieldControl('name'),
          fieldControl('designation'),
          fieldControl('email'),
          fieldControl('phone'),
        ),
        h('div', { class: 'crm-section-title' }, 'Placement'),
        h('div', { class: 'crm-grid' },
          h('div', { class: 'field span-2' },
            h('label', { class: 'field-label' }, 'Project / subproject / category'),
            h('div', {
              class: 'input',
              style: { display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--surface-3)', height: 'auto', minHeight: '34px', padding: '6px 10px' },
            }, icon('layers', 13), `${rec.projectName} · ${rec.subprojectName} · ${rec.categoryName}`),
            placementSwitcher,
          ),
          fieldControl('supplier'),
        ),
        h('div', { class: 'crm-section-title' }, 'Status & notes'),
        h('div', { class: 'crm-grid' },
          fieldControl('status'),
          ...columns
            .filter((c) => !['emp_code', 'name', 'designation', 'email', 'phone', 'supplier', 'status', 'remarks'].includes(c.key))
            .map((c) => fieldControl(c.key)),
          h('div', { class: 'field span-2' }, h('label', { class: 'field-label' }, 'Remarks & follow-up'),
            (() => {
              const input = h('textarea', { class: 'textarea', rows: 3, disabled: !canEdit }, v.remarks || '');
              input.dataset.fieldKey = 'remarks';
              currentInputs.set('remarks', { input, field: { key: 'remarks', type: 'textarea' }, type: 'textarea' });
              setTimeout(() => {
                input.addEventListener('input', () => queueChange('remarks'));
                input.addEventListener('blur', () => { if (pending.size) flushPending(); });
              }, 0);
              return input;
            })(),
          ),
        ),
        !canEdit ? h('div', { class: 'note warn', style: { marginTop: '12px' } }, icon('shield', 15),
          h('span', null, 'You have read-only access to this project. Ask an administrator for edit permission.')) : null,
        h('div', { class: 'crm-section-title' }, 'Update history'),
        historyHost,
      ),
    );

    mount(footHost,
      h('span', { class: 'row', style: { gap: '5px' } },
        icon('clock', 12), `Updated ${fmtRelative(rec.updatedAt)}`),
      h('div', { class: 'row', style: { gap: '6px' } },
        h('button', {
          class: 'btn btn-ghost btn-xs', title: 'View full record history',
          onclick: () => showHistoryModal(rec),
        }, icon('history', 13), 'History'),
        h('button', {
          class: 'btn btn-xs', title: 'Save now',
          onclick: () => flushPending(true),
        }, icon('save', 13), 'Save'),
      ),
    );
  }

  async function loadHistory(assignmentId, host) {
    mount(host, h('div', { class: 'row' }, spinner(), h('span', { class: 'subtle', style: { fontSize: '12px' } }, 'Loading history…')));
    try {
      const res = await api(`/employees/${assignmentId}/history`);
      const items = (res.history || []).slice(0, 6);
      if (!items.length) {
        mount(host, h('div', { class: 'subtle', style: { fontSize: '12px' } }, 'No changes recorded yet.'));
        return;
      }
      mount(host, h('div', { class: 'timeline' },
        ...items.map((x) => h('div', { class: 'tl-item' },
          h('div', { class: 'tl-dot' }, icon(x.action === 'create' ? 'plus' : 'edit', 11)),
          h('div', { class: 'tl-body' },
            h('div', { class: 'tl-line1' },
              h('span', { class: 'tl-field' }, x.field_label || x.field_key || 'Record'),
              x.old_value ? h('span', { class: 'subtle' }, ': ', h('span', { class: 'tl-old' }, clip(x.old_value)), ' → ', h('span', { class: 'tl-new' }, clip(x.new_value))) : null,
              !x.old_value && x.new_value ? h('span', { class: 'subtle' }, ': ', h('span', { class: 'tl-new' }, clip(x.new_value))) : null,
            ),
            h('div', { class: 'tl-meta' }, `${x.actor_name || 'System'} · ${fmtDateTime(x.at)}`),
          ),
        )),
      ));
    } catch {
      mount(host, h('div', { class: 'subtle', style: { fontSize: '12px' } }, 'History unavailable.'));
    }
  }

  const clip = (s) => { const t = String(s ?? ''); return t.length > 26 ? `${t.slice(0, 24)}…` : t || '—'; };

  /* ------------------------------------------------------------ create */
  function enterCreate() {
    if (!flushPending(true)) return;
    mode = 'create';
    current = null;
    pending.clear();
    setSaveState('idle');
    const scope = getScope();
    const inputs = {};

    const tree = state.tree;
    const projectSelect = h('select', { class: 'select', onchange: onProjectChange },
      h('option', { value: '' }, 'Select project'),
      ...tree.map((p) => h('option', { value: p.id, selected: String(p.id) === String(scope.projectId) }, p.name)),
    );
    const subSelect = h('select', { class: 'select', onchange: onSubChange });
    const catSelect = h('select', { class: 'select' });

    function onProjectChange() {
      const p = tree.find((x) => x.id === Number(projectSelect.value));
      subSelect.replaceChildren(h('option', { value: '' }, p ? 'Select subproject' : 'Select a project first'),
        ...(p ? p.subprojects.map((s) => h('option', { value: s.id, selected: String(s.id) === String(scope.subprojectId) }, s.name)) : []));
      if (p) {
        const matching = p.subprojects.find((s) => s.id === Number(scope.subprojectId)) || p.subprojects[0];
        if (matching) { subSelect.value = matching.id; onSubChange(); }
      } else { catSelect.replaceChildren(); }
    }
    function onSubChange() {
      const p = tree.find((x) => x.id === Number(projectSelect.value));
      const s = p?.subprojects.find((x) => x.id === Number(subSelect.value));
      catSelect.replaceChildren(h('option', { value: '' }, s ? 'Select category' : 'Select a subproject first'),
        ...(s ? s.categories.map((c) => h('option', { value: c.id, selected: String(c.id) === String(scope.categoryId) }, c.name)) : []));
      if (s) {
        const matching = s.categories.find((c) => c.id === Number(scope.categoryId)) || s.categories[0];
        if (matching) catSelect.value = matching.id;
      }
    }
    onProjectChange();

    const text = (key, label, opts = {}) => {
      const input = h('input', { class: 'input', type: opts.type || 'text', placeholder: opts.placeholder || '', autocomplete: 'off' });
      inputs[key] = input;
      return h('div', { class: `field ${opts.span2 ? 'span-2' : ''}` },
        h('label', { class: 'field-label' }, label, opts.req ? h('span', { class: 'req' }, '*') : null),
        input,
      );
    };

    const errHost = h('div', { class: 'hidden' });
    const warnHost = h('div', { class: 'hidden' });

    // live duplicate detection feedback while typing the employee ID
    let checkTimer = null;
    const checkDuplicates = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(async () => {
        const code = inputs.emp_code.value.trim();
        const email = inputs.email.value.trim();
        if (!code && !email) { warnHost.classList.add('hidden'); return; }
        try {
          const res = await api(`/people?q=${encodeURIComponent(code || email)}`);
          const exact = (res.people || []).find((p) =>
            p.emp_code.toLowerCase() === code.toLowerCase() ||
            (email && (p.email || '').toLowerCase() === email.toLowerCase()));
          if (exact) {
            mount(warnHost, h('div', { class: 'note warn' }, icon('alert', 15),
              h('span', null, `A person with this ID or email already exists: ${exact.name} (${exact.emp_code}). Adding them again will link the new placement to the existing record instead of duplicating.`)));
            warnHost.classList.remove('hidden');
          } else {
            warnHost.classList.add('hidden');
          }
        } catch { /* non-blocking */ }
      }, 350);
    };
    setTimeout(() => {
      inputs.emp_code?.addEventListener('input', checkDuplicates);
      inputs.email?.addEventListener('input', checkDuplicates);
    }, 0);

    const saveBtn = h('button', { class: 'btn btn-primary', onclick: submit }, icon('plus', 14), 'Add person');

    async function submit() {
      errHost.classList.add('hidden');
      const body = {
        emp_code: inputs.emp_code.value.trim(),
        name: inputs.name.value.trim(),
        email: inputs.email.value.trim(),
        phone: inputs.phone.value.trim(),
        designation: inputs.designation.value.trim(),
        project_id: Number(projectSelect.value) || null,
        subproject_id: Number(subSelect.value) || null,
        category_id: Number(catSelect.value) || null,
      };
      const problems = [];
      if (!body.emp_code) problems.push('Employee ID is required.');
      if (!body.name) problems.push('Employee Name is required.');
      if (!body.project_id) problems.push('Select a project.');
      if (!body.subproject_id) problems.push('Select a subproject.');
      if (!body.category_id) problems.push('Select a category.');
      if (problems.length) {
        mount(errHost, h('div', { class: 'note warn' }, icon('alert', 15),
          h('div', null, ...problems.map((p) => h('div', null, p)))));
        errHost.classList.remove('hidden');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.replaceChildren(spinner(), 'Saving…');
      try {
        const res = await api('/employees', { method: 'POST', body });
        if (res.needsReview) {
          toast('Add for review', `Saved, but ${res.candidate.name} (${res.candidate.emp_code}) looks similar. An administrator will review the match.`, 'warn', 7000);
        } else if (res.created) {
          toast('Person created', `${body.name} added to ${res.record?.categoryName || 'the category'}.`, 'success');
        } else {
          toast('Placement added', `${body.name} already existed — linked to the new category without duplicating.`, 'success', 5200);
        }
        if (onChanged) onChanged(res.record);
        await openAssignment(res.assignmentId);
      } catch (err) {
        const msgs = err.data?.errors ? Object.values(err.data.errors) : [err.message];
        mount(errHost, h('div', { class: 'note warn' }, icon('alert', 15), h('div', null, ...msgs.map((m) => h('div', null, m)))));
        errHost.classList.remove('hidden');
        saveBtn.disabled = false;
        saveBtn.replaceChildren(h('span', { style: { display: 'inline-flex' } }, icon('plus', 14)), 'Add person');
      }
    }

    mount(bodyHost,
      h('div', { class: 'crm-form' },
        h('div', { class: 'note', style: { marginBottom: '12px' } }, icon('info', 15),
          h('span', null, 'Employee ID is the unique business key. If it already exists the person is linked to the new category instead of being duplicated.')),
        h('div', { class: 'crm-section-title' }, 'Identity'),
        h('div', { class: 'crm-grid' },
          text('emp_code', 'Employee ID', { req: true, placeholder: 'EMP-01234' }),
          text('name', 'Employee Name', { req: true }),
          text('designation', 'Designation'),
          text('email', 'Email Address', { type: 'email' }),
          text('phone', 'Contact Number', { type: 'tel' }),
        ),
        warnHost,
        h('div', { class: 'crm-section-title' }, 'Placement'),
        h('div', { class: 'crm-grid' },
          h('div', { class: 'field span-2' }, h('label', { class: 'field-label' }, 'Project', h('span', { class: 'req' }, '*')), projectSelect),
          h('div', { class: 'field span-2' }, h('label', { class: 'field-label' }, 'Subproject', h('span', { class: 'req' }, '*')), subSelect),
          h('div', { class: 'field span-2' }, h('label', { class: 'field-label' }, 'Category', h('span', { class: 'req' }, '*')), catSelect),
        ),
        errHost,
        h('div', { class: 'row', style: { marginTop: '14px', gap: '8px' } },
          saveBtn,
          h('button', {
            class: 'btn', onclick: () => { mode = 'list'; render(); },
          }, 'Cancel'),
        ),
      ),
    );
    mount(footHost, h('span', null, 'New records are written inside a database transaction.'));
    setTimeout(() => inputs.emp_code?.focus(), 60);
  }

  /* ------------------------------------------------------------ autosave */
  function queueChange(key) {
    const entry = fieldInputsFor(key);
    if (!entry) return;
    const { input, field, type } = entry;
    const value = input.value;
    const errorEl = input.closest('.field')?.querySelector('.field-error');
    const invalid = validate(type, value, field, input);
    if (errorEl) {
      if (invalid) {
        errorEl.textContent = invalid;
        errorEl.classList.remove('hidden');
        input.classList.add('is-error');
        setSaveState('error');
        return;
      }
      errorEl.classList.add('hidden');
      input.classList.remove('is-error');
    }
    pending.set(key, value);
    setSaveState('unsaved');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushPending(), AUTOSAVE_MS);
  }

  function fieldInputsFor(key) { return currentInputs.get(key); }

  function validate(type, value, field, input) {
    if (!value) {
      if (field?.required) return 'This field is required.';
      return null;
    }
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return 'Enter a valid email address.';
    if (type === 'tel' && !/^[+()\-\s0-9]{6,24}$/.test(value)) return 'Enter a valid contact number.';
    if (type === 'number' && Number.isNaN(Number(value))) return 'Enter a valid number.';
    return null;
  }

  /** Flush queued edits. Returns true when nothing is left unsaved. */
  async function flushPending(force = false) {
    clearTimeout(saveTimer);
    if (!current || !pending.size) return true;
    // validate before hitting the network
    for (const [key, value] of pending) {
      const entry = currentInputs.get(key);
      const invalid = entry ? validate(entry.type, value, entry.field, entry.input) : null;
      if (invalid) {
        setSaveState('error');
        toast('Cannot save', `${entry?.field?.label || key}: ${invalid}`, 'error');
        return false;
      }
    }
    const changes = Object.fromEntries(pending);
    const snapshot = new Map(pending);
    pending.clear();
    setSaveState('saving');
    try {
      const res = await api(`/employees/${current.assignmentId}`, {
        method: 'PATCH',
        body: { changes, rev: current.rev, reason: 'CRM autosave' },
      });
      current = { ...res.record, placements: current?.placements };
      setSaveState('saved');
      retryQueue = null;
      setTimeout(() => { if (saveState === 'saved') setSaveState('idle'); }, 3500);
      if (onChanged) onChanged(res.record);
      if (mode === 'detail') renderDetailKeepingFocus();
      return true;
    } catch (err) {
      // restore the fixes so the user can retry safely
      retryQueue = snapshot;
      for (const [k, v] of snapshot) if (!pending.has(k)) pending.set(k, v);
      setSaveState('error');
      if (err.status === 409) {
        toast('Update conflict', 'Someone else saved this record. Latest values loaded — review and save again.', 'warn', 7000);
        if (err.data?.current) {
          current = { ...err.data.current, placements: current?.placements };
          pending.clear();
          retryQueue = null;
          render();
        }
      } else if (err.data?.offline) {
        toast('Offline', 'Your changes are kept locally. They will save once the connection returns.', 'warn', 6000);
        renderRetryBanner();
      } else {
        const msg = err.data?.errors ? Object.values(err.data.errors)[0] : err.message;
        toast('Not saved', msg, 'error', 6000);
        renderRetryBanner();
      }
      return false;
    }
  }

  function renderRetryBanner() {
    let banner = bodyHost.querySelector('.retry-banner');
    if (banner) return;
    banner = h('div', { class: 'note warn retry-banner', style: { margin: '10px 13px 0' } },
      icon('alert', 15),
      h('div', { class: 'grow' },
        h('div', { style: { fontWeight: '600' } }, 'Changes are not saved yet'),
        h('div', { style: { fontSize: '12px' } }, 'Review the values and retry. Nothing is marked saved until the database confirms.'),
      ),
      h('button', {
        class: 'btn btn-sm btn-primary',
        onclick: async (e) => {
          e.target.disabled = true;
          const ok = await flushPending(true);
          banner.remove();
          if (!ok) renderRetryBanner();
          else toast('Saved', 'Your changes were stored successfully.', 'success');
        },
      }, icon('refresh', 13), 'Retry save'),
    );
    bodyHost.prepend(banner);
  }

  /** Re-render the detail form without losing caret position. */
  function renderDetailKeepingFocus() {
    const active = document.activeElement;
    const activeKey = active?.dataset?.fieldKey;
    const selStart = active?.selectionStart;
    renderDetail();
    if (activeKey) {
      const entry = currentInputs.get(activeKey);
      if (entry) {
        entry.input.focus();
        try { entry.input.setSelectionRange(selStart, selStart); } catch { /* ignore */ }
      }
    }
  }

  /* ------------------------------------------------------------ history modal */
  async function showHistoryModal(rec) {
    const { modal } = await import('../core.js');
    const host = h('div', null, h('div', { class: 'row' }, spinner(), 'Loading history…'));
    modal({
      title: 'Update history',
      subtitle: `${rec.values.name} · ${rec.values.emp_code}`,
      size: 'modal-lg',
      body: host,
      footer: h('button', { class: 'btn', onclick: () => document.querySelector('.overlay')?.remove() }, 'Close'),
    });
    try {
      const res = await api(`/employees/${rec.assignmentId}/history`);
      if (!res.history.length) {
        mount(host, emptyState({ title: 'No history yet', message: 'Field changes will appear here as supervisors update the record.', iconName: 'history' }));
        return;
      }
      const table = h('table', { class: 'data' },
        h('thead', null, h('tr', null,
          h('th', null, 'When'), h('th', null, 'Field'), h('th', null, 'From'), h('th', null, 'To'), h('th', null, 'By'),
        )),
        h('tbody', null, ...res.history.map((x) => h('tr', null,
          h('td', { class: 'nowrap cell-muted', style: { fontSize: '11.5px' } }, fmtDateTime(x.at)),
          h('td', { style: { fontWeight: '600' } }, x.field_label || x.field_key || 'Record'),
          h('td', { class: 'tl-old' }, clip(x.old_value)),
          h('td', { class: 'tl-new' }, clip(x.new_value)),
          h('td', { class: 'cell-muted' }, x.actor_name || 'System'),
        ))),
      );
      mount(host, h('div', { class: 'table-wrap', style: { maxHeight: 'none', border: '1px solid var(--line)', borderRadius: '8px' } }, table));
    } catch (err) {
      mount(host, emptyState({ title: 'History unavailable', message: err.message, iconName: 'alert' }));
    }
  }

  /* ------------------------------------------------------------ router */
  function render() {
    renderHead();
    renderSaveState();
    if (mode === 'list') renderList();
    else if (mode === 'create') enterCreate();
    else renderDetail();
  }

  /* ------------------------------------------------------------ public */
  return {
    el,
    showList() { if (flushPending(true)) { mode = 'list'; render(); } },
    showAssignment(id) { openAssignment(id); },
    showEmployee(id, assignmentId) { openPerson(id, assignmentId); },
    newPerson() { enterCreate(); },
    hasUnsaved: () => pending.size > 0,
    save: () => flushPending(true),
    isDetail: () => mode === 'detail',
    currentId: () => (mode === 'detail' ? current?.assignmentId : null),
  };
}

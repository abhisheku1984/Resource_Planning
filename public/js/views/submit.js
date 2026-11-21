/* =========================================================================
   Supervisor update panel.

   Every change saves itself. You type, the field says "Saving…", then "Saved",
   and the value is already in the database - there is no separate export step
   and nothing is held in the browser. The whole set of changed fields is still
   written in ONE transaction, so a half-typed screen never lands half-applied.
   The Submit button remains as an optional "save now" for a whole batch; a
   closed tab, a lost connection or a forgotten click cannot lose work.
   ========================================================================= */
import {
  h, mount, icon, api, state, toast, fmtDate, fmtRelative, spinner,
  emptyState, statusBadge, initials,
} from '../core.js';

/**
 * The panel is deliberately a short, ordered list, not the whole record: the
 * person (Employee ID + name) and the workbook's supervisor columns from Leader
 * Input Last Week through Giga Project Name. Submit writes them in one
 * transaction; the next export carries the new value plus who changed it.
 *
 * The list comes from the server (`state.crmKeys`, admin-configurable), so this
 * constant is only the fallback for an old cached page.
 */
const FALLBACK_KEYS = [
  'leader_input_last_week', 'leader_input_this_week', 'leader_input_pid_account',
  'billing_start_date', 'billing_end_date', 'pid_awaited_account',
  'pid_awaited_blocked_date', 'opp_id', 'account_owner', 'allocation_closure_eta',
  'role_of_month', 'role_of_responses', 'detail_comments', 'block_status',
  'account_name', 'interviewed_by', 'demand_number',
];

export function createSubmitPanel({ onSaved, getScope }) {
  const el = h('aside', { class: 'card crm-panel submit-panel', 'aria-label': 'Update employee record' });
  const headHost = h('div', { class: 'submit-head' });
  const bodyHost = h('div', { class: 'submit-body' });
  const footHost = h('div', { class: 'submit-foot' });
  mount(el, headHost, bodyHost, footHost);

  let record = null;
  let inputs = new Map();     // key -> { input, field, type, original }
  let saving = false;
  let savedAt = null;
  let saveTimer = null;       // debounce handle
  let savePromise = null;     // in-flight write, awaited before leaving
  let lastError = null;
  const AUTOSAVE_MS = 900;

  /* ---------------------------------------------------------------- head */
  function renderHead() {
    mount(headHost,
      h('div', { class: 'grow', style: { minWidth: '0' } },
        h('div', { class: 'card-title' }, icon('edit', 15), 'Update record'),
        h('div', { class: 'card-sub' }, record
          ? `${record.values.emp_code} · ${record.values.name}`
          : 'Select a row to update'),
      ),
      h('button', {
        class: 'btn btn-ghost btn-icon', title: 'Close panel', 'aria-label': 'Close panel',
        onclick: () => el.dispatchEvent(new CustomEvent('rp:close-panel', { bubbles: true })),
      }, icon('x', 15)),
    );
  }

  function dirty() {
    const out = {};
    for (const [key, entry] of inputs) {
      const now = entry.input.value;
      if (String(now ?? '') !== String(entry.original ?? '')) out[key] = now;
    }
    return out;
  }

  function renderFoot() {
    const changes = dirty();
    const count = Object.keys(changes).length;
    mount(footHost,
      h('div', { class: 'col', style: { minWidth: '0' } },
        h('div', { style: { fontSize: '12px', fontWeight: '600', color: count ? 'var(--warn)' : 'var(--text-2)' } },
          saving
          ? 'Saving…'
          : count ? `${count} change${count === 1 ? '' : 's'} pending — saving automatically` : 'All changes saved'),
        lastError
          ? h('div', { style: { fontSize: '11px', color: 'var(--danger)' } }, `Not saved — ${lastError}. Retrying…`)
          : savedAt
            ? h('div', { class: 'subtle', style: { fontSize: '11px' } }, `Saved to the database ${fmtRelative(savedAt)} · ${state.user?.name || 'you'} · visible to the admin immediately`)
            : h('div', { class: 'subtle', style: { fontSize: '11px' } }, 'Changes save themselves as you type, into the database'),
      ),
      h('div', { class: 'row', style: { gap: '6px' } },
        count
          ? h('button', { class: 'btn btn-sm', onclick: () => resetForm() }, 'Reset')
          : null,
        h('button', {
          class: 'btn btn-primary btn-sm',
          disabled: !count || saving || !canEdit(),
          onclick: () => submit(),
        }, saving ? spinner() : icon('check', 14), saving ? 'Saving…' : 'Save now'),
      ),
    );
  }

  function canEdit() {
    const scope = getScope();
    if (!state.user) return false;
    if (state.user.isAdmin) return true;
    if (!state.user.capabilities?.['employee.edit']) return false;
    const grant = state.user.projects?.find((p) => p.id === Number(scope.projectId));
    return grant ? !!grant.can_edit : true;
  }

  /* ---------------------------------------------------------------- form */
  function renderForm() {
    if (!record) {
      mount(bodyHost, emptyState({
        title: 'Nothing selected',
        message: 'Pick an employee from the table. You can edit their allocation plan, PID/OPID, dates, ETA and notes here, then Submit.',
        iconName: 'edit',
      }));
      renderHead();
      renderFoot();
      return;
    }

    inputs = new Map();
    const v = record.values || {};
    const canEditNow = canEdit();

    // Exactly the configured CRM columns, in that order. A column the category
    // does not list still resolves through the catalogue, so a category created
    // by an import gets the same form as a seeded one.
    const byKey = new Map((record.columns || []).map((c) => [c.key, c]));
    const catalogue = new Map((state.fields || []).map((f) => [f.key, f]));
    const wanted = (state.crmKeys && state.crmKeys.length ? state.crmKeys : FALLBACK_KEYS);
    const submitCols = wanted
      .map((k) => byKey.get(k) || catalogue.get(k))
      .filter(Boolean)
      .map((c) => ({ ...c, submitField: true }));
    const orderedGroups = submitCols.length ? [['Supervisor update', submitCols]] : [];

    const buildField = (col) => {
      const original = v[col.key] ?? '';
      const id = `sf-${col.key}`;
      let input;
      const common = { id, disabled: !canEditNow };
      if (col.type === 'select') {
        input = h('select', { class: 'select', ...common },
          h('option', { value: '' }, 'Not set'),
          ...(col.options || []).map((o) => h('option', { value: o, selected: String(original) === o }, o)),
        );
      } else if (col.type === 'textarea') {
        input = h('textarea', { class: 'textarea', rows: 3, ...common }, original);
      } else if (col.type === 'date') {
        input = h('input', { class: 'input', type: 'date', value: original, ...common });
      } else if (col.type === 'number') {
        input = h('input', { class: 'input', type: 'number', value: original, ...common });
      } else if (col.type === 'email') {
        input = h('input', { class: 'input', type: 'email', value: original, ...common });
      } else if (col.type === 'tel') {
        input = h('input', { class: 'input', type: 'tel', value: original, ...common });
      } else {
        input = h('input', { class: 'input', type: 'text', value: original, ...common });
      }
      input.dataset.fieldKey = col.key;
      const wrap = h('div', { class: 'field submit-field' },
        h('label', { class: 'field-label', for: id }, col.label,
          col.required ? h('span', { class: 'req' }, '*') : null),
        input,
        h('div', { class: 'field-error hidden' }),
      );
      inputs.set(col.key, { input, field: col, type: col.type, original, wrap });

      const sync = () => {
        const changed = String(input.value ?? '') !== String(original ?? '');
        wrap.classList.toggle('is-changed', changed);
        renderFoot();
        const err = wrap.querySelector('.field-error');
        const problem = validate(col, input.value);
        if (problem) {
          err.textContent = problem;
          err.classList.remove('hidden');
          input.classList.add('is-error');
        } else {
          err.classList.add('hidden');
          input.classList.remove('is-error');
        }
      };
      input.addEventListener('input', () => { sync(); scheduleSave(); });
      input.addEventListener('change', () => { sync(); scheduleSave(); });
      // leaving the field saves it at once instead of waiting for the debounce
      input.addEventListener('blur', () => { if (dirty()[col.key] !== undefined) flushSave(); });
      return wrap;
    };

    const summary = h('div', { class: 'submit-summary' },
      summaryItem('Employee ID', v.emp_code || '—'),
      summaryItem('Project', record.projectName),
      summaryItem('Category', record.categoryName),
      summaryItem('Bench category', v.bench_category || '—'),
    );

    mount(bodyHost,
      h('div', { class: 'row', style: { gap: '11px', marginBottom: '12px' } },
        h('div', { class: 'avatar' }, initials(v.name || '')),
        h('div', { class: 'col grow', style: { minWidth: '0' } },
          h('div', { class: 'truncate', style: { fontWeight: '650', fontSize: '13.5px' } }, v.name),
          h('div', { class: 'row', style: { gap: '5px', marginTop: '2px' } },
            statusBadge(v.bench_category),
            h('span', { class: 'mono subtle', style: { fontSize: '11px' } }, v.emp_code),
          ),
        ),
      ),
      summary,
      !canEditNow
        ? h('div', { class: 'note warn', style: { marginBottom: '12px' } }, icon('shield', 15),
          h('span', null, 'You have read-only access here. The Submit button is disabled.'))
        : null,
      ...orderedGroups.map(([title, fields]) => h('div', { class: 'submit-group' },
        h('div', { class: 'submit-group-title' }, title),
        ...fields.map(buildField),
      )),
      submitCols.length === 0
        ? h('div', { class: 'note' }, icon('info', 15),
          h('span', null, 'No fields are marked as supervisor-editable for this category. An administrator can configure them under Data model.'))
        : null,
    );

    renderHead();
    renderFoot();
  }

  function summaryItem(label, value) {
    return h('div', { class: 'submit-summary-item' },
      h('span', { class: 'submit-summary-label' }, label),
      h('span', { class: 'submit-summary-value' }, value || '—'),
    );
  }

  function validate(col, value) {
    if (col.required && !value) return 'This field is required.';
    if (col.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return 'Enter a valid email.';
    if (col.type === 'number' && value && Number.isNaN(Number(value))) return 'Enter a number.';
    if (col.key === 'allocation_percentage' && value !== '' && value !== null) {
      const n = Number(value);
      if (n < 0 || n > 100) return 'Allocation % must be between 0 and 100.';
    }
    return null;
  }

  /* ---------------------------------------------------------------- save */
  /**
   * Autosave. Typing schedules a write; the debounce keeps one keystroke burst
   * to a single transaction. Only valid fields are sent, and a field that fails
   * validation is left alone until it is fixed - so an incomplete date never
   * blocks the rest of the form from saving.
   */
  function scheduleSave() {
    if (!record || !canEdit()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, AUTOSAVE_MS);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (saving) return savePromise || Promise.resolve();
    const changes = dirty();
    const keys = Object.keys(changes).filter((k) => {
      const entry = inputs.get(k);
      if (!entry) return false;
      const problem = validate(entry.field, entry.input.value);
      if (problem) {
        const err = entry.wrap.querySelector('.field-error');
        if (err) { err.textContent = problem; err.classList.remove('hidden'); }
        entry.input.classList.add('is-error');
        return false;
      }
      return true;
    });
    if (!keys.length) { renderFoot(); return Promise.resolve(); }
    const body = {};
    for (const k of keys) body[k] = changes[k];
    saving = true;
    renderFoot();
    savePromise = (async () => {
      try {
        const res = await api(`/employees/${record.assignmentId}/submit`, {
          method: 'POST',
          body: { changes: body, rev: record.rev, reason: 'Supervisor autosave' },
        });
        record = res.record;
        savedAt = new Date().toISOString();
        lastError = null;
        // the saved values are now the baseline: the fields are no longer dirty
        for (const k of keys) {
          const entry = inputs.get(k);
          if (!entry) continue;
          entry.original = entry.input.value;
          entry.wrap.classList.remove('is-changed');
        }
        saving = false;
        renderFoot();
        if (onSaved) onSaved(res.record, res.changed);
        // anything typed while the request was in flight goes next
        if (Object.keys(dirty()).length) scheduleSave();
      } catch (err) {
        saving = false;
        if (err.status === 409) {
          // someone else saved this record first: keep the user's text, reload
          // the baseline, and retry theirs on top of the newer revision
          lastError = 'someone else saved this record first';
          toast('Someone else saved first', 'Your text is kept. Reloading the latest values and saving yours again.', 'warn', 7000);
          const mine = dirty();
          if (err.data?.current) {
            record = err.data.current;
            const keep = new Map(Object.entries(mine));
            renderForm();
            for (const [k, val] of keep) {
              const entry = inputs.get(k);
              if (entry) { entry.input.value = val; entry.wrap.classList.add('is-changed'); }
            }
            renderFoot();
            scheduleSave();
          }
        } else {
          lastError = err.data?.errors ? Object.values(err.data.errors)[0] : err.message;
          toast('Not saved', lastError, 'error', 6000);
          renderFoot();
          // keep trying: a dropped connection should not silently lose the edit
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, 4000);
        }
      } finally {
        savePromise = null;
      }
    })();
    return savePromise;
  }

  /** The button is now just "save this batch right now". */
  async function submit() {
    await flushSave();
    const left = Object.keys(dirty()).length;
    if (!left) toast('Saved to the database', 'Every change on this form is already stored.', 'success', 4000);
  }

  /** Awaited before the panel changes person or closes, so nothing is lost. */
  async function settle() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (savePromise) { try { await savePromise; } catch { /* reported already */ } }
    if (Object.keys(dirty()).length) { try { await flushSave(); } catch { /* reported already */ } }
  }

  function resetForm() {
    if (!record) return;
    for (const [, entry] of inputs) {
      entry.input.value = entry.original ?? '';
      entry.wrap.classList.remove('is-changed');
    }
    renderFoot();
  }

  /* ---------------------------------------------------------------- api */
  return {
    el,
    async show(assignmentId) {
      // switching person must not drop an unsaved edit on the previous one
      if (record && record.assignmentId !== Number(assignmentId)) await settle();
      if (!assignmentId) {
        record = null;
        renderForm();
        return;
      }
      mount(bodyHost, h('div', { class: 'row', style: { padding: '20px' } }, spinner(), h('span', { class: 'muted' }, 'Loading record…')));
      try {
        const res = await api(`/employees/${assignmentId}`);
        record = res.record;
        savedAt = null;
        renderForm();
      } catch (err) {
        mount(bodyHost, emptyState({ title: 'Could not open record', message: err.message, iconName: 'alert' }));
      }
    },
    clear() { record = null; inputs = new Map(); lastError = null; renderForm(); },
    settle,
    hasUnsaved: () => saving || Object.keys(dirty()).length > 0,
    currentId: () => record?.assignmentId || null,
  };
}

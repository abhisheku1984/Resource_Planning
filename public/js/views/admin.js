/* =========================================================================
   Administration — the per-category column layout, the CRM panel columns, and
   users & access control.

   There is deliberately no project-hierarchy editor, no supplier register and
   no employee-group register: the workbook has no such tabs, and a second
   place to maintain people and partners is a second place to get out of date.
   Users are created here, with their project grants and capabilities assigned
   in the same step.
   ========================================================================= */
import {
  h, mount, icon, api, state, toast, modal, spinner, emptyState,
  closeModal, confirmDialog, initials, setRouteFromHash,
} from '../core.js';

const TABS = [
  { key: 'columns', label: 'Data model', icon: 'columns' },
  { key: 'crm', label: 'CRM panel', icon: 'contact' },
  { key: 'access', label: 'Users & access', icon: 'shield' },
];

// Shared by Data model and New user, independently of which tab is open.
let fieldId = 0;
function field(label, control, hint) {
  control.id = `admin-field-${++fieldId}`;
  if (hint) control.setAttribute('aria-describedby', `${control.id}-hint`);
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: control.id }, label), control,
    hint ? h('div', { class: 'field-help', id: `${control.id}-hint` }, hint) : null,
  );
}

export async function renderAdmin(content, ctx) {
  if (!state.user?.isAdmin) {
    mount(content, h('div', { class: 'page' }, emptyState({
      title: 'Administrator only',
      message: 'This area configures the column layouts and access control. Ask an administrator if you need changes.',
      iconName: 'shield',
    })));
    return;
  }
  let tab = TABS.some((t) => t.key === ctx.tab) ? ctx.tab : 'columns';
  const bodyHost = h('div', { id: 'admin-body' });
  const tabHost = h('div', { class: 'tabs', style: { borderRadius: '10px 10px 0 0', border: '1px solid var(--line)', background: 'var(--surface)' } });

  function paintTabs() {
    mount(tabHost, ...TABS.map((t) => h('button', {
      class: `tab ${tab === t.key ? 'active' : ''}`,
      onclick: () => {
        tab = t.key;
        history.replaceState(null, '', `#/${t.key === 'access' ? 'access' : 'admin'}${t.key === 'access' ? '' : `?tab=${t.key}`}`);
        setRouteFromHash();
        paintTabs();
        paint();
      },
    }, icon(t.icon, 14), t.label)));
  }

  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, 'Administration'),
        h('div', { class: 'page-sub' }, 'Choose which columns each category shows, and decide who can see and change what.'),
      ),
    ),
    tabHost,
    h('div', { style: { marginTop: '14px' } }, bodyHost),
  ));

  function paint() {
    // An older tab's response must never overwrite the tab just selected.
    const panel = h('div');
    mount(bodyHost, panel);
    if (tab === 'columns') return renderDataModel(panel);
    if (tab === 'crm') return renderCrmColumns(panel);
    return renderAccess(panel);
  }

  paintTabs();
  return paint();
}

/* ============================================================ CRM panel */
/**
 * Choose which columns the CRM / Update panel offers, and in what order.
 * These are the columns a supervisor edits and submits; the export carries the
 * same list in the same order, plus who changed each value and when.
 */
async function renderCrmColumns(host) {
  mount(host, h('div', { class: 'row', style: { padding: '16px' } }, spinner(), h('span', { class: 'muted' }, 'Loading panel columns…')));

  let current;
  try {
    current = await api('/settings/crm-fields');
  } catch (err) {
    mount(host, emptyState({ title: 'Could not load the panel columns', message: err.message, iconName: 'alert' }));
    return;
  }

  // ordered list of the chosen keys, plus everything else available
  let keys = [...current.keys];
  const byKey = new Map(current.available.map((f) => [f.key, f]));
  const label = (k) => byKey.get(k)?.label || k;

  const listHost = h('div', { class: 'col', style: { gap: '6px' } });
  const addSelect = h('select', { class: 'select', style: { maxWidth: '260px' } },
    h('option', { value: '' }, 'Add a column…'),
    ...current.available.filter((f) => !keys.includes(f.key)).map((f) => h('option', { value: f.key }, f.label)));
  addSelect.addEventListener('change', () => {
    if (!addSelect.value) return;
    keys.push(addSelect.value);
    addSelect.value = '';
    paintList();
  });

  function paintList() {
    mount(listHost, ...keys.map((k, i) => h('div', {
      class: 'row',
      style: { gap: '8px', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: '8px', background: 'var(--surface)' },
    },
      h('span', { class: 'mono subtle', style: { fontSize: '11px', width: '22px' } }, String(i + 1)),
      h('span', { class: 'grow', style: { fontSize: '12.5px' } }, label(k)),
      h('div', { class: 'row', style: { gap: '2px' } },
        h('button', {
          class: 'btn btn-ghost btn-xs', title: 'Move up', disabled: i === 0,
          onclick: () => { const [x] = keys.splice(i, 1); keys.splice(i - 1, 0, x); paintList(); },
        }, icon('chevronDown', 12)),
        h('button', {
          class: 'btn btn-ghost btn-xs', title: 'Move down', disabled: i === keys.length - 1,
          onclick: () => { const [x] = keys.splice(i, 1); keys.splice(i + 1, 0, x); paintList(); },
        }, icon('chevronDown', 12)),
        h('button', {
          class: 'btn btn-ghost btn-xs', title: 'Remove from the panel',
          onclick: () => { keys = keys.filter((x) => x !== k); paintList(); },
        }, icon('x', 12)),
      ),
    )));
    if (!keys.length) mount(listHost, h('div', { class: 'subtle' }, 'No columns selected — the panel will fall back to its default list.'));
  }
  paintList();

  const save = h('button', { class: 'btn btn-primary' }, icon('check', 14), 'Save panel columns');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const res = await api('/settings/crm-fields', { method: 'PUT', body: { keys } });
      state.crmKeys = res.keys;
      toast('CRM panel updated', `${res.keys.length} columns. Supervisors see them immediately; the export uses the same order.`, 'success', 5000);
    } catch (err) {
      toast('Not saved', err.message, 'error');
    } finally {
      save.disabled = false;
    }
  });

  mount(host, h('div', { class: 'card', style: { padding: '16px' } },
    h('div', { class: 'card-title', style: { marginBottom: '4px' } }, icon('contact', 15), 'CRM / Update panel columns'),
    h('div', { class: 'card-sub', style: { marginBottom: '12px' } },
      'Employee ID and the name are always shown at the top. Everything below is what a supervisor can edit and submit — keep it to what they own.'),
    listHost,
    h('div', { class: 'row', style: { gap: '8px', marginTop: '12px' } },
      addSelect,
      h('div', { class: 'grow' }),
      h('button', {
        class: 'btn',
        onclick: () => { keys = [...current.keys]; paintList(); },
      }, 'Reset'),
      save,
    ),
    h('div', { class: 'note', style: { marginTop: '12px' } }, icon('info', 15),
      h('span', null, 'Submitted values are written in one transaction, audited with the supervisor\'s name, and appear in the next Excel export alongside a per-field "who changed it and when" column.')),
  ));
}

/* ================================================================= data model */
async function renderDataModel(host, initialCategory = null) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const startCat = initialCategory || Number(params.get('category')) || null;

  mount(host, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading data model…'))));

  try {
    state.fields = (await api('/fields')).fields;
  } catch (err) {
    mount(host, emptyState({ title: 'Could not load the data model', message: err.message, iconName: 'alert',
      action: h('button', { class: 'btn', onclick: () => renderDataModel(host, startCat) }, 'Retry') }));
    return;
  }
  const tree = state.tree;

  // flatten categories for the picker
  const cats = [];
  for (const p of tree) for (const s of p.subprojects) for (const c of s.categories) {
    cats.push({ ...c, projectName: p.name, subprojectName: s.name });
  }
  let selected = startCat && cats.some((c) => c.id === startCat) ? startCat : cats[0]?.id;

  const picker = h('select', {
    class: 'select', style: { maxWidth: '420px' },
    onchange: (e) => {
      selected = Number(e.target.value);
      history.replaceState(null, '', `#/admin?tab=columns&category=${selected}`);
      setRouteFromHash();
      paintMatrix();
    },
  }, ...cats.map((c) => h('option', { value: c.id, selected: c.id === selected }, `${c.projectName} › ${c.subprojectName} › ${c.name}`)));

  const matrixHost = h('div');

  mount(host,
    h('div', { class: 'grid', style: { marginBottom: '14px', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: '14px' } },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', null,
            h('div', { class: 'card-title' }, icon('columns', 15), 'Category column layout'),
            h('div', { class: 'card-sub' }, 'Visible columns, editability and required validation are stored per category.'),
          ),
          h('button', { class: 'btn btn-sm', onclick: () => addField() }, icon('plus', 14), 'New field'),
        ),
        h('div', { class: 'card-body' }, cats.length
          ? h('div', { class: 'col', style: { gap: '12px' } },
            field('Category', picker),
            matrixHost,
          )
          : emptyState({ title: 'No categories yet', message: 'Create projects, subprojects and categories first.', iconName: 'layers' })),
      ),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', null,
            h('div', { class: 'card-title' }, icon('sliders', 15), 'Field catalogue'),
            h('div', { class: 'card-sub' }, 'Fields are shared across categories; layouts decide what each category shows.'),
          ),
        ),
        h('div', { class: 'card-body', style: { padding: '6px' } },
          ...state.fields.map((f) => h('div', { class: 'list-item' },
            h('div', { class: 'grow', style: { minWidth: '0' } },
              h('div', { class: 'row', style: { gap: '6px' } },
                h('span', { class: 'li-name' }, f.label),
                f.core ? h('span', { class: 'badge badge-brand', style: { height: '17px', fontSize: '10px', padding: '0 6px' } }, 'core') : null,
              ),
              h('div', { class: 'li-meta' }, `${f.key} · ${f.type}${f.options ? ` · ${f.options.length} options` : ''}`),
            ),
            h('button', { class: 'btn btn-ghost btn-xs', title: 'Edit field', onclick: () => editField(f) }, icon('edit', 12)),
          )),
        ),
      ),
    ),
  );

  async function paintMatrix() {
    const categoryId = selected;
    const slot = h('div', { class: 'col', style: { gap: '10px' } });
    mount(matrixHost, slot);
    mount(slot, h('div', { class: 'row' }, spinner(), h('span', { class: 'muted' }, 'Loading layout…')));
    let res;
    try { res = await api(`/categories/${categoryId}/columns`); } catch (err) {
      mount(slot, emptyState({ title: 'Could not load layout', message: err.message, iconName: 'alert' }));
      return;
    }
    const rows = res.fields;

    const table = h('table', { class: 'matrix-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Field'),
        h('th', null, 'Type'),
        h('th', { class: 'center' }, 'Visible'),
        h('th', { class: 'center' }, 'Editable'),
        h('th', { class: 'center' }, 'Required'),
        h('th', { class: 'center' }, 'Order'),
      )),
      h('tbody', null, ...rows.map((r) => {
        const cbVisible = h('input', { type: 'checkbox', 'aria-label': `Visible: ${r.label}`, checked: r.visible, disabled: r.system, onchange: () => { r.visible = cbVisible.checked; rowSync(); } });
        const cbEditable = h('input', { type: 'checkbox', 'aria-label': `Editable: ${r.label}`, checked: r.editable, onchange: () => { r.editable = cbEditable.checked; } });
        const cbRequired = h('input', { type: 'checkbox', 'aria-label': `Required: ${r.label}`, checked: r.required, onchange: () => { r.required = cbRequired.checked; } });
        const order = h('input', { class: 'input', type: 'number', 'aria-label': `Order: ${r.label}`, value: r.sort_order, style: { width: '70px', height: '26px', fontSize: '12px' }, onchange: () => { r.sort_order = Number(order.value); } });
        const tr = h('tr', { class: r.visible ? '' : 'is-hidden-row' },
          h('td', null, h('div', { class: 'row', style: { gap: '6px' } },
            h('span', { style: { fontWeight: '600' } }, r.label),
            r.core ? h('span', { class: 'badge badge-brand', style: { height: '16px', fontSize: '9.5px', padding: '0 5px' } }, 'core') : null,
          ), h('div', { class: 'subtle mono', style: { fontSize: '10.5px' } }, r.key)),
          h('td', { class: 'cell-muted', style: { fontSize: '11.5px' } }, r.type),
          h('td', { class: 'center' }, cbVisible),
          h('td', { class: 'center' }, cbEditable),
          h('td', { class: 'center' }, cbRequired),
          h('td', { class: 'center' }, order),
        );
        function rowSync() {
          tr.classList.toggle('is-hidden-row', !r.visible);
          cbEditable.disabled = cbRequired.disabled = !r.visible;
        }
        rowSync();
        return tr;
      })),
    );

    const saveBtn = h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        saveBtn.disabled = true;
        saveBtn.replaceChildren(spinner(), 'Saving…');
        try {
          await api(`/categories/${categoryId}/columns`, {
            method: 'PUT',
            body: { fields: rows.map((r) => ({ field_id: r.id, visible: r.visible, editable: r.editable, required: r.required, sort_order: r.sort_order })) },
          });
          toast('Layout saved', 'Supervisors will see this column set for the category.', 'success');
          saveBtn.disabled = false;
          saveBtn.replaceChildren(icon('check', 14), 'Save layout');
        } catch (err) {
          toast('Could not save layout', err.message, 'error');
          saveBtn.disabled = false;
          saveBtn.replaceChildren('Save layout');
        }
      },
    }, icon('check', 14), 'Save layout');

    mount(slot,
      h('div', { class: 'note' }, icon('info', 15),
        h('span', null, 'Unchecked fields disappear from the employee table and CRM form for this category. "Editable" controls whether supervisors can change the value.')),
      h('div', { class: 'matrix' }, table),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } },
        h('button', { class: 'btn', onclick: () => paintMatrix() }, 'Reset'),
        saveBtn,
      ),
    );
  }

  function addField() {
    const key = h('input', { class: 'input', placeholder: 'e.g. visa_status' });
    const label = h('input', { class: 'input', placeholder: 'e.g. Visa Status' });
    const type = h('select', { class: 'select' },
      ...['text', 'textarea', 'number', 'date', 'select', 'email', 'tel'].map((t) => h('option', { value: t }, t)));
    const options = h('input', { class: 'input', placeholder: 'Comma separated (select fields only)' });
    modal({
      title: 'New field',
      subtitle: 'Adds a configurable column to the catalogue.',
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Field key', key, 'Lowercase, used internally. Cannot be changed later.'),
        field('Label', label),
        field('Type', type),
        field('Options', options, 'Only used for dropdown fields.'),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const opts = options.value.trim() ? options.value.split(',').map((s) => s.trim()).filter(Boolean) : null;
            try {
              await api('/fields', { method: 'POST', body: { key: key.value, label: label.value, type: type.value, options: opts } });
              closeModal(); toast('Field created', 'Enable it per category in the layout matrix.', 'success');
              await renderDataModel(host, selected);
            } catch (err) { toast('Could not create field', err.message, 'error'); }
          },
        }, 'Create field'),
      ),
    });
  }

  function editField(f) {
    const label = h('input', { class: 'input', value: f.label });
    const options = h('input', { class: 'input', value: (f.options || []).join(', ') });
    modal({
      title: 'Edit field', subtitle: f.key,
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Label', label),
        f.type === 'select' ? field('Options', options) : h('div', { class: 'field-help' }, 'Options apply to dropdown fields only.'),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const body = { label: label.value };
            if (f.type === 'select') body.options = options.value.split(',').map((s) => s.trim()).filter(Boolean);
            try {
              await api(`/fields/${f.id}`, { method: 'PATCH', body });
              closeModal(); toast('Field updated', label.value, 'success');
              await renderDataModel(host, selected);
            } catch (err) { toast('Could not save', err.message, 'error'); }
          },
        }, 'Save'),
      ),
    });
  }

  if (selected) await paintMatrix();
}

/* ================================================================= access */
async function renderAccess(host) {
  mount(host, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading users…'))));
  let users; let capabilities; let gigaNames; let gigaCapabilities;
  try {
    const res = await api('/users');
    users = res.users;
    capabilities = res.capabilities;
    gigaNames = res.gigaProjectNames;
    gigaCapabilities = res.gigaCapabilities;
    if (!Array.isArray(gigaNames) || !Array.isArray(gigaCapabilities)) {
      throw new Error('Restart the application server after updating to load Giga project access.');
    }
  } catch (err) {
    mount(host, emptyState({ title: 'Could not load users', message: err.message, iconName: 'alert' }));
    return;
  }

  const CAP_LABELS = {
    'project.view': 'View projects',
    'project.manage': 'Manage projects',
    'employee.edit': 'Edit employee records',
    'employee.create': 'Add employees',
    'crm.use': 'Use the CRM panel',
    'export.data': 'Export to Excel',
    'import.data': 'Import daily datasets',
    'schema.manage': 'Configure columns & fields',
    'users.manage': 'Manage users',
    'audit.view': 'View audit trail',
  };

  const table = h('table', { class: 'data' },
    h('thead', null, h('tr', null,
      h('th', null, 'User'), h('th', null, 'Role'), h('th', null, 'Project scope'), h('th', null, 'Capabilities'), h('th', null, ''),
    )),
    h('tbody', null, ...users.map((u) => h('tr', null,
      h('td', null, h('div', { class: 'row', style: { gap: '9px' } },
        h('div', { class: 'avatar avatar-sm' }, initials(u.name)),
        h('div', { class: 'col', style: { gap: '0' } },
          h('span', { style: { fontWeight: '600' } }, u.name),
          h('span', { class: 'subtle', style: { fontSize: '11px' } }, u.email),
        ),
      )),
      h('td', null, h('span', { class: `badge ${u.role === 'admin' ? 'badge-brand' : 'badge-neutral'}` }, u.role === 'admin' ? 'Administrator' : 'Supervisor')),
      h('td', null, u.role === 'admin'
        ? h('span', { class: 'badge badge-info' }, `All ${u.projects.length} projects`)
        : u.gigaAccess
          ? h('span', { class: 'badge badge-info' }, u.gigaAccess.name ? `Giga: ${u.gigaAccess.name}` : 'No project access')
          : h('div', { class: 'row', style: { gap: '3px', flexWrap: 'wrap', maxWidth: '230px' } },
          u.projects.length ? h('span', { class: 'subtle' }, 'Hierarchy:') : null,
          ...(u.projects.length ? u.projects.map((p) => h('span', {
            class: `badge ${p.can_edit ? 'badge-success' : 'badge-warn'}`, style: { height: '19px', fontSize: '10.5px' },
            title: `${p.can_edit ? 'Edit' : 'Read only'} · ${p.can_export ? 'Export' : 'No export'} · ${p.can_crm ? 'CRM' : 'No CRM'}`,
          }, p.name)) : [h('span', { class: 'subtle' }, 'None')]),
        )),
      h('td', null, u.role === 'admin'
        ? h('span', { class: 'badge badge-brand' }, 'All capabilities')
        : h('span', { class: 'badge badge-outline' }, `${Object.values(u.capabilities).filter(Boolean).length} granted`)),
      h('td', null, h('div', { class: 'row', style: { gap: '4px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn btn-ghost btn-xs', disabled: u.role === 'admin',
          title: u.role === 'admin' ? 'Administrators have unrestricted access' : `Edit access for ${u.name}`,
          onclick: () => openEditor(u) }, icon('edit', 12), 'Edit access'),
        u.id === state.user.id
          ? h('span', { class: 'subtle', title: 'You cannot delete your own account.' }, 'Your account')
          : h('button', { class: 'btn btn-ghost btn-xs', onclick: () => deleteUser(u) }, icon('trash', 12), 'Delete'),
      )),
    ))),
  );

  mount(host, h('div', null,
    h('div', { class: 'note', style: { marginBottom: '14px' } }, icon('shield', 15),
      h('span', null, 'Assign a supervisor one Giga Project Name from the workbook. Use Edit access to change or revoke it.')),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null,
          h('div', { class: 'card-title' }, icon('users', 15), 'Users & access control', h('span', { class: 'count-pill' }, users.length)),
          h('div', { class: 'card-sub' }, 'Project scope and permissions for each account.'),
        ),
        h('button', { class: 'btn btn-sm btn-primary', onclick: newUser }, icon('plus', 14), 'New user'),
      ),
      h('div', { class: 'card-body flush' }, h('div', { class: 'table-wrap', style: { maxHeight: 'none' } }, table)),
    ),
  ));

  function buildAccessControls(user = null) {
    const grants = new Map((user?.projects || []).map((p) => [p.project_id, { ...p }]));
    const caps = { ...user?.capabilities };
    const existing = user?.gigaAccess;
    const legacy = user && !existing;
    let disabled = false;
    let choice = existing ? (existing.name ? `g:${existing.name}` : 'none') : legacy ? 'legacy' : '';
    // Prefix real names so workbook text such as "none" is never a policy flag.
    const picker = h('select', { class: 'select', onchange: () => { choice = picker.value; paint(); } },
      h('option', { value: '', disabled: true }, 'Choose a Giga project…'),
      ...(legacy ? [h('option', { value: 'legacy' }, 'Keep hierarchy-based access')] : []),
      h('option', { value: 'none' }, 'No project access'),
      ...gigaNames.map((name) => h('option', { value: `g:${name}` }, name)),
      existing?.name && !gigaNames.includes(existing.name)
        ? h('option', { value: `g:${existing.name}` }, `${existing.name} (no current rows)`) : null,
    );
    picker.value = choice;
    const hint = h('div', { class: 'field-help' });
    const hierarchyHost = h('div', { class: 'col', style: { gap: '4px' } });
    const grantHost = h('div', { class: 'col', style: { gap: '7px' } }, field('Giga Project Name', picker), hint, hierarchyHost);
    const projectRows = state.tree.map((p) => {
      const g = grants.get(p.id);
      const cb = h('input', { type: 'checkbox', 'aria-label': `Grant access to ${p.name}`, checked: !!g, onchange: () => {
        if (cb.checked) grants.set(p.id, { project_id: p.id, can_edit: true, can_export: true, can_crm: true });
        else grants.delete(p.id);
        paintGrants();
      } });
      return { p, cb };
    });

    function paintGrants() {
      mount(hierarchyHost, ...projectRows.map(({ p, cb }) => {
        const g = grants.get(p.id);
        cb.disabled = disabled;
        const mk = (label, key) => {
          const c = h('input', { type: 'checkbox', checked: g ? !!g[key] : false, disabled: disabled || !g,
            onchange: () => { if (g) g[key] = c.checked; } });
          return h('label', { class: 'checkbox', style: { fontSize: '11.5px' } }, c, label);
        };
        return h('div', { class: 'row', style: { gap: '10px', padding: '7px 0', borderBottom: '1px solid var(--line)' } },
          cb,
          h('div', { class: 'col grow', style: { minWidth: '0' } },
            h('span', { style: { fontSize: '12.5px', fontWeight: '600' } }, p.name),
            h('div', { class: 'row', style: { gap: '10px', marginTop: '2px' } },
              mk('Edit', 'can_edit'), mk('Export', 'can_export'), mk('CRM', 'can_crm'),
            ),
          ),
        );
      }));
    }

    const capHost = h('div', { class: 'crm-grid' });
    function paint() {
      const inHierarchy = choice === 'legacy';
      const selected = choice.startsWith('g:');
      picker.disabled = disabled;
      hint.textContent = disabled ? 'Administrators have full access to all projects.'
        : inHierarchy ? 'This account still uses the hierarchy grants below. Choosing a Giga project replaces them.'
        : choice === 'none' ? 'This account can sign in but cannot see any workforce records.'
        : !gigaNames.length ? 'No Giga project names found. Import rows with Giga Project Name filled in.'
        : 'Only matching workbook rows are accessible. Enable Edit employee records below if this person should update them.';
      if (inHierarchy) paintGrants(); else mount(hierarchyHost);
      mount(capHost, ...(inHierarchy ? capabilities : gigaCapabilities).map((cap) => {
        const fixedView = !inHierarchy && cap === 'project.view';
        const off = !inHierarchy && !selected;
        const c = h('input', { type: 'checkbox', checked: disabled || (!off && (fixedView || !!caps[cap])),
          disabled: disabled || off || fixedView, onchange: () => { caps[cap] = c.checked; } });
        return h('label', { class: 'checkbox', style: { fontSize: '12px' } }, c, CAP_LABELS[cap] || cap);
      }));
    }
    paint();
    return {
      grantHost, capHost,
      setDisabled(v) { disabled = v; paint(); },
      payload() {
        if (disabled) return {}; // administrator role is unrestricted by design
        if (choice === 'legacy') return { projects: [...grants.values()], capabilities: caps };
        if (!choice) throw new Error('Choose a Giga Project Name, or select No project access.');
        const name = choice === 'none' ? null : choice.slice(2);
        return { gigaProjectName: name,
          capabilities: Object.fromEntries(gigaCapabilities.map((cap) => [cap, !!name && (cap === 'project.view' || !!caps[cap])])) };
      },
    };
  }

  function openEditor(u) {
    const controls = buildAccessControls(u);
    modal({
      title: 'Edit access',
      subtitle: `${u.name} · ${u.email}`,
      size: 'modal-lg',
      body: h('div', null,
        h('div', { class: 'crm-section-title' }, 'Project access'),
        controls.grantHost,
        h('div', { class: 'crm-section-title' }, 'Capabilities'),
        controls.capHost,
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await api(`/users/${u.id}/access`, {
                method: 'PUT',
                body: controls.payload(),
              });
              closeModal();
              toast('Access updated', `${u.name}'s permissions are now enforced by the backend.`, 'success', 5000);
              await renderAccess(host);
            } catch (err) { toast('Could not save access', err.message, 'error'); }
            finally { button.disabled = false; }
          },
        }, 'Save access'),
      ),
    });
  }

  function newUser() {
    const name = h('input', { class: 'input', placeholder: 'Full name' });
    const email = h('input', { class: 'input', type: 'email', placeholder: 'name@company.com' });
    const title = h('input', { class: 'input', placeholder: 'Job title (optional)' });
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'At least 8 characters' });

    const controls = buildAccessControls();
    const role = h('select', { class: 'select', onchange: () => controls.setDisabled(role.value === 'admin') },
      h('option', { value: 'supervisor' }, 'Supervisor'), h('option', { value: 'admin' }, 'Administrator'));

    const error = h('div', { class: 'note warn hidden', role: 'alert' });
    modal({
      title: 'New user',
      size: 'modal-lg',
      body: h('div', { class: 'col', style: { gap: '12px' } },
        error, field('Name', name), field('Email', email), field('Title', title), field('Role', role), field('Temporary password', pw),
        h('div', { class: 'crm-section-title' }, 'Project access'),
        controls.grantHost,
        h('div', { class: 'crm-section-title' }, 'Capabilities'),
        controls.capHost,
        h('div', { class: 'note' }, icon('info', 15),
          h('span', null, 'The account and its access are created together. Administrators get full access automatically.')),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            error.classList.add('hidden');
            try {
              await api('/users', {
                method: 'POST',
                body: {
                  name: name.value, email: email.value, title: title.value, role: role.value, password: pw.value,
                  ...controls.payload(),
                },
              });
              closeModal(); toast('User created', `${email.value} can sign in now, with the access you chose.`, 'success', 5000);
              await renderAccess(host);
            } catch (err) {
              error.textContent = err.message;
              error.classList.remove('hidden');
              error.scrollIntoView({ block: 'nearest' });
            } finally { button.disabled = false; }
          },
        }, 'Create user'),
      ),
    });
  }

  async function deleteUser(u) {
    const ok = await confirmDialog({
      title: 'Delete this user?',
      message: `${u.name} (${u.email}) will be removed permanently, along with their project grants, capabilities and active sessions. Their past activity stays in the audit trail. This cannot be undone.`,
      confirmLabel: 'Delete user',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      toast('User deleted', u.email, 'success');
      await renderAccess(host);
    } catch (err) { toast('Could not delete user', err.message, 'error'); }
  }
}

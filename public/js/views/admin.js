/* =========================================================================
   Administration — configurable hierarchy, per-category column layouts,
   suppliers, employee groups, users & access control.
   ========================================================================= */
import {
  h, mount, icon, api, state, toast, modal, spinner, emptyState, fmtNum,
  confirmDialog, initials, fmtRelative,
} from '../core.js';

const TABS = [
  { key: 'hierarchy', label: 'Projects & hierarchy', icon: 'layers' },
  { key: 'columns', label: 'Data model', icon: 'columns' },
  { key: 'suppliers', label: 'Suppliers', icon: 'truck' },
  { key: 'groups', label: 'Employee groups', icon: 'users' },
  { key: 'access', label: 'Users & access', icon: 'shield' },
];

export async function renderAdmin(content, ctx) {
  if (!state.user?.isAdmin) {
    mount(content, h('div', { class: 'page' }, emptyState({
      title: 'Administrator only',
      message: 'This area configures the hierarchy, dynamic columns and access control. Ask an administrator if you need changes.',
      iconName: 'shield',
    })));
    return;
  }
  let tab = ctx.tab || 'hierarchy';
  const bodyHost = h('div', { id: 'admin-body' });
  const tabHost = h('div', { class: 'tabs', style: { borderRadius: '10px 10px 0 0', border: '1px solid var(--line)', background: 'var(--surface)' } });

  function paintTabs() {
    mount(tabHost, ...TABS.map((t) => h('button', {
      class: `tab ${tab === t.key ? 'active' : ''}`,
      onclick: () => {
        tab = t.key;
        history.replaceState(null, '', `#/${t.key === 'access' ? 'access' : 'admin'}${t.key === 'access' ? '' : `?tab=${t.key}`}`);
        paintTabs();
        paint();
      },
    }, icon(t.icon, 14), t.label)));
  }

  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, 'Administration'),
        h('div', { class: 'page-sub' }, 'Configure the project hierarchy, decide which columns each category shows, and control who can see what.'),
      ),
    ),
    tabHost,
    h('div', { style: { marginTop: '14px' } }, bodyHost),
  ));

  function paint() {
    if (tab === 'hierarchy') renderHierarchy(bodyHost);
    else if (tab === 'columns') renderDataModel(bodyHost);
    else if (tab === 'suppliers') renderSuppliers(bodyHost);
    else if (tab === 'groups') renderGroups(bodyHost);
    else renderAccess(bodyHost);
  }

  paintTabs();
  paint();
}

/* ================================================================= hierarchy */
async function renderHierarchy(host) {
  mount(host, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading hierarchy…'))));
  let tree;
  try { tree = (await api('/projects')).projects; } catch (err) {
    mount(host, emptyState({ title: 'Could not load projects', message: err.message, iconName: 'alert' }));
    return;
  }
  state.tree = tree;
  let selectedProject = tree[0]?.id || null;

  const listHost = h('div', { class: 'col', style: { gap: '2px' } });
  const detailHost = h('div');

  const paintList = () => {
    mount(listHost, ...tree.map((p) => h('button', {
      class: `list-item ${p.id === selectedProject ? 'active' : ''}`,
      onclick: () => { selectedProject = p.id; paintList(); paintDetail(); },
    },
      h('div', { class: 'grow', style: { minWidth: '0' } },
        h('div', { class: 'li-name truncate' }, p.name),
        h('div', { class: 'li-meta' }, `${p.code} · ${p.subprojects.length} subprojects`),
      ),
      icon('chevronRight', 14),
    )));
  };

  const paintDetail = () => {
    const p = tree.find((x) => x.id === selectedProject);
    if (!p) { mount(detailHost, emptyState({ title: 'Select a project', iconName: 'folder' })); return; }

    mount(detailHost, h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', null,
            h('div', { class: 'card-title' }, p.name, h('span', { class: 'badge badge-brand' }, p.code)),
            h('div', { class: 'card-sub' }, p.client ? `Client: ${p.client}` : 'Internal project'),
          ),
          h('div', { class: 'row', style: { gap: '6px' } },
            h('button', { class: 'btn btn-sm', onclick: () => editProject(p) }, icon('edit', 14), 'Edit'),
            h('button', { class: 'btn btn-sm btn-primary', onclick: () => addSubproject(p) }, icon('plus', 14), 'Subproject'),
          ),
        ),
        h('div', { class: 'card-body' },
          p.description ? h('p', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '12px' } }, p.description) : null,
          h('div', { class: 'col', style: { gap: '10px' } },
            ...p.subprojects.map((s) => h('div', { style: { border: '1px solid var(--line)', borderRadius: '9px', padding: '12px' } },
              h('div', { class: 'spread', style: { marginBottom: '8px' } },
                h('div', { class: 'row', style: { gap: '8px' } },
                  icon('folder', 15),
                  h('span', { style: { fontWeight: '600', fontSize: '13px' } }, s.name),
                  h('span', { class: 'badge badge-outline' }, s.code),
                  h('span', { class: 'count-pill', title: 'Employees' }, s.employeeCount),
                ),
                h('div', { class: 'row', style: { gap: '4px' } },
                  h('button', { class: 'btn btn-ghost btn-xs', onclick: () => addCategory(p, s) }, icon('plus', 12), 'Category'),
                  h('button', { class: 'btn btn-ghost btn-xs', onclick: () => editSubproject(s) }, icon('edit', 12), 'Edit'),
                ),
              ),
              s.categories.length
                ? h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', paddingLeft: '23px' } },
                  ...s.categories.map((c) => h('button', {
                    class: 'badge badge-neutral',
                    style: { cursor: 'pointer', height: '25px', fontSize: '12px' },
                    title: 'Configure columns for this category',
                    onclick: () => { location.hash = `#/admin?tab=columns&category=${c.id}`; },
                  }, icon('table', 12), c.name)),
                )
                : h('div', { class: 'subtle', style: { fontSize: '11.5px', paddingLeft: '23px' } }, 'No categories yet'),
            )),
            !p.subprojects.length
              ? emptyState({ title: 'No subprojects', message: 'Add the first subproject to start structuring this programme.', iconName: 'folder' })
              : null,
          ),
        ),
      ));
  }

  function editProject(p) {
    const name = h('input', { class: 'input', value: p.name });
    const code = h('input', { class: 'input', value: p.code });
    const client = h('input', { class: 'input', value: p.client || '' });
    const desc = h('textarea', { class: 'textarea', rows: 3 }, p.description || '');
    modal({
      title: 'Edit project', subtitle: p.code,
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Project name', name), field('Project code', code),
        field('Client', client), field('Description', desc),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api(`/projects/${p.id}`, { method: 'PATCH', body: { name: name.value, code: code.value, client: client.value, description: desc.value } });
              close(); toast('Project updated', p.name, 'success');
              await window.__rp.refreshAll();
              renderAdmin(document.getElementById('content'), { tab: 'hierarchy' });
            } catch (err) { toast('Could not save', err.message, 'error'); }
          },
        }, 'Save changes'),
      ),
    });
  }

  function addSubproject(p) {
    const name = h('input', { class: 'input', placeholder: 'e.g. Payment Gateway Rebuild' });
    const code = h('input', { class: 'input', placeholder: 'e.g. PAY-GW' });
    const desc = h('input', { class: 'input', placeholder: 'Optional description' });
    modal({
      title: 'New subproject', subtitle: p.name,
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Subproject name', name), field('Code', code), field('Description', desc),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api('/subprojects', { method: 'POST', body: { project_id: p.id, name: name.value, code: code.value, description: desc.value } });
              close(); toast('Subproject created', name.value, 'success');
              await window.__rp.refreshAll();
              renderAdmin(document.getElementById('content'), { tab: 'hierarchy' });
            } catch (err) { toast('Could not create', err.message, 'error'); }
          },
        }, 'Create subproject'),
      ),
    });
  }

  function editSubproject(s) {
    const name = h('input', { class: 'input', value: s.name });
    const code = h('input', { class: 'input', value: s.code });
    modal({
      title: 'Edit subproject', subtitle: s.code,
      body: h('div', { class: 'col', style: { gap: '12px' } }, field('Name', name), field('Code', code)),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api(`/subprojects/${s.id}`, { method: 'PATCH', body: { name: name.value, code: code.value } });
              close(); toast('Subproject updated', name.value, 'success');
              await window.__rp.refreshAll();
              renderAdmin(document.getElementById('content'), { tab: 'hierarchy' });
            } catch (err) { toast('Could not save', err.message, 'error'); }
          },
        }, 'Save'),
      ),
    });
  }

  function addCategory(p, s) {
    const name = h('input', { class: 'input', placeholder: 'e.g. Training Cohort' });
    const code = h('input', { class: 'input', placeholder: 'e.g. TRN' });
    modal({
      title: 'New category', subtitle: `${p.name} · ${s.name}`,
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Category name', name), field('Code', code),
        h('div', { class: 'note' }, icon('info', 15),
          h('span', null, 'Each category gets its own column layout. New categories start with the default set — refine it under Data model.')),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              const res = await api('/categories', { method: 'POST', body: { subproject_id: s.id, name: name.value, code: code.value } });
              close();
              toast('Category created', 'Now configure its columns.', 'success');
              await window.__rp.refreshAll();
              location.hash = `#/admin?tab=columns&category=${res.category.id}`;
            } catch (err) { toast('Could not create', err.message, 'error'); }
          },
        }, 'Create category'),
      ),
    });
  }

  const close = () => document.querySelector('.overlay')?.remove();

  mount(host, h('div', { class: 'split', style: { gridTemplateColumns: '260px minmax(0,1fr)' } },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'card-title' }, icon('layers', 15), 'Projects'),
        h('button', { class: 'btn btn-ghost btn-xs', onclick: newProject }, icon('plus', 12), 'New'),
      ),
      h('div', { class: 'card-body', style: { padding: '6px' } }, listHost),
    ),
    detailHost,
  ));
  paintList();
  paintDetail();

  function newProject() {
    const name = h('input', { class: 'input', placeholder: 'Project name' });
    const code = h('input', { class: 'input', placeholder: 'e.g. PHOENIX' });
    const client = h('input', { class: 'input', placeholder: 'Client name' });
    const desc = h('textarea', { class: 'textarea', rows: 2, placeholder: 'Short description' });
    modal({
      title: 'New project',
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Project name', name), field('Project code', code), field('Client', client), field('Description', desc),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api('/projects', { method: 'POST', body: { name: name.value, code: code.value, client: client.value, description: desc.value } });
              close(); toast('Project created', name.value, 'success');
              await window.__rp.refreshAll();
              renderAdmin(document.getElementById('content'), { tab: 'hierarchy' });
            } catch (err) { toast('Could not create', err.message, 'error'); }
          },
        }, 'Create project'),
      ),
    });
  }
}

const field = (label, input, hint) => h('div', { class: 'field' },
  h('label', { class: 'field-label' }, label),
  input,
  hint ? h('div', { class: 'field-help' }, hint) : null,
);

/* ================================================================= data model */
async function renderDataModel(host, initialCategory = null) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const startCat = initialCategory || Number(params.get('category')) || null;

  mount(host, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading data model…'))));

  const [fieldsRes] = await Promise.all([api('/fields')]);
  state.fields = fieldsRes.fields;
  const tree = state.tree;

  // flatten categories for the picker
  const cats = [];
  for (const p of tree) for (const s of p.subprojects) for (const c of s.categories) {
    cats.push({ ...c, projectName: p.name, subprojectName: s.name });
  }
  let selected = startCat && cats.some((c) => c.id === startCat) ? startCat : cats[0]?.id;

  const picker = h('select', {
    class: 'select', style: { maxWidth: '420px' },
    onchange: (e) => { selected = Number(e.target.value); paintMatrix(); },
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
            h('div', { id: 'matrix-slot', class: 'col', style: { gap: '10px' } }, matrixHost),
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
    const slot = document.getElementById('matrix-slot');
    if (!slot) return;
    mount(matrixHost, h('div', { class: 'row' }, spinner(), h('span', { class: 'muted' }, 'Loading layout…')));
    let res;
    try { res = await api(`/categories/${selected}/columns`); } catch (err) {
      mount(matrixHost, emptyState({ title: 'Could not load layout', message: err.message, iconName: 'alert' }));
      return;
    }
    const rows = res.fields.map((f) => ({
      ...f,
      visible: f.visible,
      editable: f.editable,
      required: f.required,
    }));

    const table = h('table', { class: 'matrix-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Field'),
        h('th', null, 'Type'),
        h('th', { class: 'center' }, 'Visible'),
        h('th', { class: 'center' }, 'Editable'),
        h('th', { class: 'center' }, 'Required'),
        h('th', { class: 'center' }, 'Order'),
      )),
      h('tbody', null, ...rows.map((r, i) => {
        const cbVisible = h('input', { type: 'checkbox', checked: r.visible, disabled: r.system, onchange: () => { r.visible = cbVisible.checked; rowSync(); } });
        const cbEditable = h('input', { type: 'checkbox', checked: r.editable, onchange: () => { r.editable = cbEditable.checked; rowSync(); } });
        const cbRequired = h('input', { type: 'checkbox', checked: r.required, onchange: () => { r.required = cbRequired.checked; } });
        const order = h('input', { class: 'input', type: 'number', value: (i + 1) * 10, style: { width: '70px', height: '26px', fontSize: '12px' }, onchange: () => { r.sort_order = Number(order.value); } });
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
          if (!r.visible) cbEditable.checked = false;
        }
        return tr;
      })),
    );

    const saveBtn = h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        saveBtn.disabled = true;
        saveBtn.replaceChildren(spinner(), 'Saving…');
        try {
          await api(`/categories/${selected}/columns`, {
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

    mount(matrixHost,
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
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const opts = options.value.trim() ? options.value.split(',').map((s) => s.trim()).filter(Boolean) : null;
            try {
              await api('/fields', { method: 'POST', body: { key: key.value, label: label.value, type: type.value, options: opts } });
              close(); toast('Field created', 'Enable it per category in the layout matrix.', 'success');
              renderAdmin(document.getElementById('content'), { tab: 'columns' });
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
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const body = { label: label.value };
            if (f.type === 'select') body.options = options.value.split(',').map((s) => s.trim()).filter(Boolean);
            try {
              await api(`/fields/${f.id}`, { method: 'PATCH', body });
              close(); toast('Field updated', label.value, 'success');
              renderAdmin(document.getElementById('content'), { tab: 'columns' });
            } catch (err) { toast('Could not save', err.message, 'error'); }
          },
        }, 'Save'),
      ),
    });
  }

  const close = () => document.querySelector('.overlay')?.remove();
  paintMatrix();
}

/* ================================================================= suppliers */
async function renderSuppliers(host) {
  let list;
  try { list = (await api('/suppliers')).suppliers; } catch (err) {
    mount(host, emptyState({ title: 'Could not load suppliers', message: err.message, iconName: 'alert' }));
    return;
  }
  const table = h('table', { class: 'data' },
    h('thead', null, h('tr', null,
      h('th', null, 'Supplier'), h('th', null, 'Code'), h('th', null, 'Contact'),
      h('th', null, 'Email'), h('th', null, 'Phone'), h('th', null, 'Status'), h('th', null, ''),
    )),
    h('tbody', null, ...list.map((s) => h('tr', null,
      h('td', { style: { fontWeight: '600' } }, s.name),
      h('td', { class: 'mono subtle' }, s.code),
      h('td', { class: 'cell-muted' }, s.contact_name || '—'),
      h('td', { class: 'cell-muted' }, s.email || '—'),
      h('td', { class: 'cell-muted' }, s.phone || '—'),
      h('td', null, h('span', { class: `badge ${s.active ? 'badge-success' : 'badge-neutral'}` }, s.active ? 'Active' : 'Inactive')),
      h('td', null, h('button', { class: 'btn btn-ghost btn-xs', onclick: () => editSupplier(s) }, icon('edit', 12), 'Edit')),
    ))),
  );

  mount(host, h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null,
        h('div', { class: 'card-title' }, icon('truck', 15), 'Supplier network', h('span', { class: 'count-pill' }, list.length)),
        h('div', { class: 'card-sub' }, 'Suppliers appear as dropdown options in every category that shows the supplier column.'),
      ),
      h('button', { class: 'btn btn-sm btn-primary', onclick: newSupplier }, icon('plus', 14), 'New supplier'),
    ),
    h('div', { class: 'card-body flush' }, h('div', { class: 'table-wrap', style: { maxHeight: 'none' } }, table)),
  ));

  function newSupplier() {
    const name = h('input', { class: 'input', placeholder: 'Supplier name' });
    const contact = h('input', { class: 'input', placeholder: 'Primary contact' });
    const email = h('input', { class: 'input', type: 'email', placeholder: 'contact@supplier.com' });
    const phone = h('input', { class: 'input', placeholder: '+91 …' });
    modal({
      title: 'New supplier',
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Supplier name', name), field('Contact name', contact), field('Email', email), field('Phone', phone)),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api('/suppliers', { method: 'POST', body: { name: name.value, contact_name: contact.value, email: email.value, phone: phone.value } });
              close(); toast('Supplier added', name.value, 'success');
              await window.__rp.refreshAll();
              renderAdmin(document.getElementById('content'), { tab: 'suppliers' });
            } catch (err) { toast('Could not add', err.message, 'error'); }
          },
        }, 'Add supplier'),
      ),
    });
  }

  function editSupplier(s) {
    const name = h('input', { class: 'input', value: s.name });
    const contact = h('input', { class: 'input', value: s.contact_name || '' });
    const email = h('input', { class: 'input', type: 'email', value: s.email || '' });
    const phone = h('input', { class: 'input', value: s.phone || '' });
    const active = h('input', { type: 'checkbox', checked: !!s.active });
    modal({
      title: 'Edit supplier', subtitle: s.code,
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Supplier name', name), field('Contact name', contact), field('Email', email), field('Phone', phone),
        h('label', { class: 'checkbox' }, active, 'Active'),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api(`/suppliers/${s.id}`, {
                method: 'PATCH',
                body: { name: name.value, contact_name: contact.value, email: email.value, phone: phone.value, active: active.checked ? 1 : 0 },
              });
              close(); toast('Supplier updated', name.value, 'success');
              await window.__rp.refreshAll();
              renderAdmin(document.getElementById('content'), { tab: 'suppliers' });
            } catch (err) { toast('Could not save', err.message, 'error'); }
          },
        }, 'Save'),
      ),
    });
  }

  const close = () => document.querySelector('.overlay')?.remove();
}

/* ================================================================= groups */
async function renderGroups(host) {
  mount(host, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading groups…'))));
  let groups;
  try { groups = (await api('/groups')).groups; } catch (err) {
    mount(host, emptyState({ title: 'Could not load groups', message: err.message, iconName: 'alert' }));
    return;
  }
  mount(host, h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null,
        h('div', { class: 'card-title' }, icon('users', 15), 'Employee groups', h('span', { class: 'count-pill' }, groups.length)),
        h('div', { class: 'card-sub' }, 'Reusable cohorts such as pods, guilds or onboarding batches.'),
      ),
      h('button', { class: 'btn btn-sm btn-primary', onclick: newGroup }, icon('plus', 14), 'New group'),
    ),
    h('div', { class: 'card-body' }, groups.length
      ? h('div', { class: 'grid grid-2' }, ...groups.map((g) => h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', null,
            h('div', { class: 'card-title' }, g.name, h('span', { class: 'count-pill' }, g.members.length)),
            h('div', { class: 'card-sub' }, g.description || 'No description'),
          ),
          h('button', { class: 'btn btn-ghost btn-xs', onclick: () => editMembers(g) }, icon('edit', 12), 'Members'),
        ),
        h('div', { class: 'card-body', style: { paddingTop: '10px' } },
          g.members.length
            ? h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap' } },
              ...g.members.slice(0, 8).map((m) => h('span', { class: 'badge badge-neutral' }, m.name)),
              g.members.length > 8 ? h('span', { class: 'badge badge-outline' }, `+${g.members.length - 8} more`) : null)
            : h('div', { class: 'subtle', style: { fontSize: '12px' } }, 'No members yet'),
        ),
      )))
      : emptyState({ title: 'No groups yet', message: 'Create a group to track a cohort across projects.', iconName: 'users' }),
    ),
  ));

  function newGroup() {
    const name = h('input', { class: 'input', placeholder: 'Group name' });
    const desc = h('input', { class: 'input', placeholder: 'Purpose' });
    modal({
      title: 'New employee group',
      body: h('div', { class: 'col', style: { gap: '12px' } }, field('Name', name), field('Description', desc)),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api('/groups', { method: 'POST', body: { name: name.value, description: desc.value } });
              close(); toast('Group created', name.value, 'success');
              renderAdmin(document.getElementById('content'), { tab: 'groups' });
            } catch (err) { toast('Could not create', err.message, 'error'); }
          },
        }, 'Create'),
      ),
    });
  }

  function editMembers(g) {
    mount(host, h('div'));
    renderAdmin(document.getElementById('content'), { tab: 'groups' });
  }

  const close = () => document.querySelector('.overlay')?.remove();
}

/* ================================================================= access */
async function renderAccess(host) {
  mount(host, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading users…'))));
  let users; let capabilities;
  try {
    const res = await api('/users');
    users = res.users;
    capabilities = res.capabilities;
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
      h('th', null, 'User'), h('th', null, 'Role'), h('th', null, 'Project access'), h('th', null, 'Capabilities'), h('th', null, ''),
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
        ? h('span', { class: 'badge badge-info' }, 'All projects')
        : h('div', { class: 'row', style: { gap: '3px', flexWrap: 'wrap', maxWidth: '230px' } },
          ...(u.projects.length ? u.projects.map((p) => h('span', {
            class: `badge ${p.can_edit ? 'badge-success' : 'badge-warn'}`, style: { height: '19px', fontSize: '10.5px' },
            title: `${p.can_edit ? 'Edit' : 'Read only'} · ${p.can_export ? 'Export' : 'No export'} · ${p.can_crm ? 'CRM' : 'No CRM'}`,
          }, p.name)) : [h('span', { class: 'subtle' }, 'None')]),
        )),
      h('td', null, u.role === 'admin'
        ? h('span', { class: 'badge badge-brand' }, 'All capabilities')
        : h('span', { class: 'badge badge-outline' }, `${Object.values(u.capabilities).filter(Boolean).length} granted`)),
      h('td', null, h('button', { class: 'btn btn-ghost btn-xs', onclick: () => openEditor(u) }, icon('sliders', 12), 'Access')),
    ))),
  );

  mount(host, h('div', null,
    h('div', { class: 'note', style: { marginBottom: '14px' } }, icon('shield', 15),
      h('span', null, 'Every restriction here is enforced by the backend. Hiding a control in the UI never substitutes for a server-side check.')),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null,
          h('div', { class: 'card-title' }, icon('users', 15), 'Users & access control', h('span', { class: 'count-pill' }, users.length)),
          h('div', { class: 'card-sub' }, 'Project grants and capability matrix per person.'),
        ),
        h('button', { class: 'btn btn-sm btn-primary', onclick: newUser }, icon('plus', 14), 'New user'),
      ),
      h('div', { class: 'card-body flush' }, h('div', { class: 'table-wrap', style: { maxHeight: 'none' } }, table)),
    ),
  ));

  function openEditor(u) {
    const grants = new Map((u.projects || []).map((p) => [p.project_id, { ...p }]));
    const caps = { ...u.capabilities };
    const isAdminTarget = u.role === 'admin';

    const projectRows = state.tree.map((p) => {
      const g = grants.get(p.id);
      const cb = h('input', { type: 'checkbox', checked: !!g, disabled: isAdminTarget, onchange: () => {
        if (cb.checked) grants.set(p.id, { project_id: p.id, can_edit: true, can_export: true, can_crm: true });
        else grants.delete(p.id);
        paintGrants();
      } });
      return { p, cb };
    });
    const grantHost = h('div', { class: 'col', style: { gap: '4px' } });

    function paintGrants() {
      mount(grantHost, ...projectRows.map(({ p, cb }) => {
        const g = grants.get(p.id);
        const mk = (label, key) => {
          const c = h('input', { type: 'checkbox', checked: g ? !!g[key] : false, disabled: !g || isAdminTarget,
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
    paintGrants();

    const capHost = h('div', { class: 'crm-grid' });
    mount(capHost, ...capabilities.map((cap) => {
      const c = h('input', { type: 'checkbox', checked: !isAdminTarget && !!caps[cap], disabled: isAdminTarget,
        onchange: () => { caps[cap] = c.checked; } });
      return h('label', { class: 'checkbox', style: { fontSize: '12px' } }, c, CAP_LABELS[cap] || cap);
    }));

    modal({
      title: 'Access control',
      subtitle: `${u.name} · ${u.email}`,
      size: 'modal-lg',
      body: h('div', null,
        isAdminTarget ? h('div', { class: 'note', style: { marginBottom: '12px' } }, icon('info', 15),
          h('span', null, 'Administrators always have full access across every project.')) : null,
        h('div', { class: 'crm-section-title' }, 'Project access'),
        grantHost,
        h('div', { class: 'crm-section-title' }, 'Capabilities'),
        capHost,
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api(`/users/${u.id}/access`, {
                method: 'PUT',
                body: { projects: [...grants.values()], capabilities: caps },
              });
              close();
              toast('Access updated', `${u.name}'s permissions are now enforced by the backend.`, 'success', 5000);
              await window.__rp.refreshAll();
              renderAdmin(document.getElementById('content'), { tab: 'access' });
            } catch (err) { toast('Could not save access', err.message, 'error'); }
          },
        }, 'Save access'),
      ),
    });
  }

  function newUser() {
    const name = h('input', { class: 'input', placeholder: 'Full name' });
    const email = h('input', { class: 'input', type: 'email', placeholder: 'name@company.com' });
    const title = h('input', { class: 'input', placeholder: 'Job title (optional)' });
    const role = h('select', { class: 'select' }, h('option', { value: 'supervisor' }, 'Supervisor'), h('option', { value: 'admin' }, 'Administrator'));
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'At least 8 characters' });
    modal({
      title: 'New user',
      body: h('div', { class: 'col', style: { gap: '12px' } },
        field('Name', name), field('Email', email), field('Title', title), field('Role', role), field('Temporary password', pw),
        h('div', { class: 'note' }, icon('info', 15), h('span', null, 'Assign project access after creating the account.')),
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await api('/users', { method: 'POST', body: { name: name.value, email: email.value, title: title.value, role: role.value, password: pw.value } });
              close(); toast('User created', email.value, 'success');
              renderAdmin(document.getElementById('content'), { tab: 'access' });
            } catch (err) { toast('Could not create user', err.message, 'error'); }
          },
        }, 'Create user'),
      ),
    });
  }

  const close = () => document.querySelector('.overlay')?.remove();
}

/* =========================================================================
   Audit trail — append-only record of every change, scoped by project access.
   ========================================================================= */
import {
  h, mount, icon, api, state, spinner, emptyState, fmtDateTime, fmtNum,
} from '../core.js';

const ENTITIES = [
  { key: '', label: 'All activity' },
  { key: 'assignment', label: 'Employee records' },
  { key: 'employee', label: 'Employee identity' },
  { key: 'import', label: 'Imports' },
  { key: 'project', label: 'Projects' },
  { key: 'supplier', label: 'Suppliers' },
  { key: 'user', label: 'Users' },
  { key: 'export', label: 'Exports' },
];

export async function renderAudit(content, ctx) {
  let entity = '';
  const listHost = h('div');

  const chips = h('div', { class: 'tabs', style: { border: '1px solid var(--line)', borderRadius: '10px 10px 0 0', background: 'var(--surface)' } });

  function paintChips() {
    mount(chips, ...ENTITIES.map((e) => h('button', {
      class: `tab ${entity === e.key ? 'active' : ''}`,
      onclick: () => { entity = e.key; paintChips(); load(); },
    }, e.label)));
  }

  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, 'Audit trail'),
        h('div', { class: 'page-sub' }, 'Immutable record of who changed what. Supervisors see activity tied to their authorized projects.'),
      ),
    ),
    chips,
    h('div', { style: { marginTop: '14px' } }, listHost),
  ));

  async function load() {
    mount(listHost, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading activity…'))));
    try {
      const res = await api(`/audit?limit=120${entity ? `&entity=${entity}` : ''}`);
      const rows = res.activity || [];
      if (!rows.length) {
        mount(listHost, h('div', { class: 'card' }, emptyState({ title: 'No activity recorded', message: 'Changes made by supervisors will appear here.', iconName: 'history' })));
        return;
      }
      const table = h('table', { class: 'data' },
        h('thead', null, h('tr', null,
          h('th', null, 'When'), h('th', null, 'Actor'), h('th', null, 'Entity'), h('th', null, 'Action'),
          h('th', null, 'Field'), h('th', null, 'From'), h('th', null, 'To'), h('th', null, 'Ref'),
        )),
        h('tbody', null, ...rows.map((r) => h('tr', null,
          h('td', { class: 'nowrap cell-muted', style: { fontSize: '11.5px' } }, fmtDateTime(r.at)),
          h('td', { style: { fontWeight: '600' } }, r.actor_name || 'System'),
          h('td', null, h('span', { class: 'badge badge-neutral' }, r.entity)),
          h('td', null, actionBadge(r.action)),
          h('td', { style: { fontWeight: '600' } }, r.field_key || '—'),
          h('td', { class: 'tl-old', style: { maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' } }, r.old_value || '—'),
          h('td', { class: 'tl-new', style: { maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' } }, r.new_value || '—'),
          h('td', { class: 'mono subtle', style: { fontSize: '11px' } }, r.ref || '—'),
        ))),
      );
      mount(listHost, h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', { class: 'card-title' }, icon('history', 15), 'Change log', h('span', { class: 'count-pill' }, fmtNum(rows.length))),
        ),
        h('div', { class: 'card-body flush' }, h('div', { class: 'table-wrap', style: { maxHeight: '620px' } }, table)),
      ));
    } catch (err) {
      mount(listHost, emptyState({ title: 'Could not load activity', message: err.message, iconName: 'alert' }));
    }
  }

  paintChips();
  load();
}

function actionBadge(action) {
  const map = { create: 'success', update: 'info', delete: 'danger', import: 'brand', export: 'neutral', login: 'neutral', resolve: 'warn' };
  return h('span', { class: `badge badge-${map[action] || 'neutral'}` }, action);
}

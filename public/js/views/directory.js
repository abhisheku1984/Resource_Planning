/* =========================================================================
   Employee Directory — cross-project people search with the CRM panel.
   Also hosts the "person card" view: every placement for one person.
   ========================================================================= */
import { h, mount, icon, state, fmtNum } from '../core.js';
import { createTable } from './table.js';
import { createCrm } from './crm.js';
import { createSubmitPanel } from './submit.js';

export function renderDirectory(content, ctx) {
  const scope = { projectId: null, subprojectId: null, categoryId: null };
  const giga = state.user?.gigaAccess;
  const isAdmin = !!state.user?.isAdmin;
  const canCrm = !giga || state.user.capabilities['crm.use'];
  const canCreate = !giga || state.user.capabilities['employee.create'];
  // The 17-column updater doesn't require CRM search permission.
  const updater = canCrm ? null : createSubmitPanel({ getScope: () => scope, onSaved: () => table.refresh() });
  const crm = createCrm({ getScope: () => scope, onChanged: () => table.refresh() });
  const cards = h('section', { class: 'grid grid-kpi', 'aria-label': 'Totals for the current filters', style: { marginBottom: '14px' } });
  const table = createTable({
    onSummary(s) {
      mount(cards,
        miniKpi('users', 'People in scope', s?.people, 'Unique employees matching the filters'),
        miniKpi('table', 'Placements', s?.placements, 'Matching records across all pages'),
        miniKpi('layers', 'Giga projects', s?.gigaProjects, s
          ? `${fmtNum(s.hierarchyProjects)} hierarchy project${s.hierarchyProjects === 1 ? '' : 's'} in view` : 'Named workbook projects'),
        miniKpi('alert', 'Pending reviews', s?.pendingReviews, isAdmin ? 'For people in this view' : 'Administrators only',
          isAdmin ? () => window.__rp.go('datahub') : null),
      );
    },
    onSaved: () => table.refresh(), // an inline edit can move a row out of the selection
    onSelect(row) {
      showPanel(updater?.el || crm.el);
      if (updater) updater.show(row.assignmentId); else crm.showAssignment(row.assignmentId);
    },
    showScope: true,
  });
  let activePanel = updater?.el || crm.el;
  const workspace = h('div', { class: 'workspace' }, table.el, updater?.el, crm.el);
  const toggle = h('button', { class: 'btn', onclick: () => showPanel(activePanel.classList.contains('hidden') ? activePanel : null) });
  function showPanel(panel) {
    if (activePanel !== panel) { updater?.settle(); crm.settle(); }
    if (panel) activePanel = panel;
    crm.el.classList.toggle('hidden', panel !== crm.el);
    updater?.el.classList.toggle('hidden', panel !== updater.el);
    workspace.classList.toggle('crm-collapsed', !panel);
    const name = activePanel === crm.el ? 'CRM' : 'Update';
    toggle.replaceChildren(icon('contact', 15), `${panel ? 'Hide' : 'Show'} ${name}`);
  }
  showPanel(activePanel);

  const projectFilter = h('select', {
    class: 'select', style: { width: '220px' },
    onchange: (e) => {
      scope.projectId = Number(e.target.value) || null;
      table.setScope(scope);
      renderCrumbs();
    },
  }, h('option', { value: '' }, giga ? 'All placements in my Giga project' : 'All my projects'),
    ...state.tree.map((p) => h('option', { value: p.id }, p.name)));

  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, 'Employee directory'),
        h('div', { class: 'page-sub' }, giga ? `Giga Project Name: ${giga.name || 'No project access'}` : 'Every placement across the projects you are authorized to see. Select a row to open the CRM panel for that person.'),
      ),
      h('div', { class: 'page-actions' },
        projectFilter,
        toggle,
        h('button', { class: 'btn btn-primary', disabled: !canCreate, onclick: () => { showPanel(crm.el); crm.newPerson(); } }, icon('plus', 15), 'Add person'),
      ),
    ),
    cards,
    workspace,
  ));

  function renderCrumbs() {
    const p = state.tree.find((x) => x.id === scope.projectId);
    ctx.setCrumbs([
      { label: 'Employee directory', onclick: () => { scope.projectId = null; projectFilter.value = ''; table.setScope(scope); } },
      ...(p ? [{ label: p.name }] : []),
    ]);
  }

  function beforeUnload(event) {
    if (!updater?.hasUnsaved() && !crm.hasUnsaved()) return;
    updater?.settle(); crm.settle();
    event.preventDefault(); event.returnValue = '';
  }
  const close = () => showPanel(null);
  document.addEventListener('rp:close-panel', close);
  document.addEventListener('rp:toggle-crm', close);
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('hashchange', () => {
    updater?.settle(); crm.settle();
    document.removeEventListener('rp:close-panel', close);
    document.removeEventListener('rp:toggle-crm', close);
    window.removeEventListener('beforeunload', beforeUnload);
  }, { once: true });
  renderCrumbs();
  table.setScope(scope);
}

function miniKpi(iconName, label, value, detail, onclick) {
  return h(onclick ? 'button' : 'div', {
    class: 'kpi', style: { textAlign: 'left', cursor: onclick ? 'pointer' : 'default', font: 'inherit' }, onclick,
  },
    h('div', { class: 'kpi-top' },
      h('span', { class: 'kpi-label' }, label),
      h('span', { class: 'kpi-icon' }, icon(iconName, 16)),
    ),
    h('div', { class: 'kpi-value', style: { fontSize: '22px' } }, fmtNum(value)),
    h('div', { class: 'kpi-foot' }, detail),
  );
}

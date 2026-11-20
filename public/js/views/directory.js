/* =========================================================================
   Employee Directory — cross-project people search with the CRM panel.
   Also hosts the "person card" view: every placement for one person.
   ========================================================================= */
import {
  h, mount, icon, api, state, fmtNum, fmtRelative, spinner, emptyState,
  statusBadge, toast, initials,
} from '../core.js';
import { createTable } from './table.js';
import { createCrm } from './crm.js';

export function renderDirectory(content, ctx) {
  const scope = { projectId: null, subprojectId: null, categoryId: null };
  let crmVisible = true;

  const table = createTable({
    onSelect: (row) => crm.showAssignment(row.assignmentId),
    showScope: true,
  });
  const crm = createCrm({
    getScope: () => scope,
    onChanged: () => table.refresh(),
  });
  crm.el.classList.toggle('hidden', !crmVisible);

  const workspace = h('div', { class: `workspace ${crmVisible ? '' : 'crm-collapsed'}` }, table.el, crm.el);

  const projectFilter = h('select', {
    class: 'select', style: { width: '220px' },
    onchange: (e) => {
      scope.projectId = Number(e.target.value) || null;
      table.setScope(scope);
      renderCrumbs();
    },
  }, h('option', { value: '' }, 'All my projects'),
    ...state.tree.map((p) => h('option', { value: p.id }, p.name)));

  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, 'Employee directory'),
        h('div', { class: 'page-sub' }, 'Every placement across the projects you are authorized to see. Select a row to open the CRM panel for that person.'),
      ),
      h('div', { class: 'page-actions' },
        projectFilter,
        h('button', {
          class: 'btn', onclick: () => {
            crmVisible = !crmVisible;
            crm.el.classList.toggle('hidden', !crmVisible);
            workspace.classList.toggle('crm-collapsed', !crmVisible);
          },
        }, icon('contact', 15), crmVisible ? 'Hide CRM' : 'Show CRM'),
        h('button', { class: 'btn btn-primary', onclick: () => crm.newPerson() }, icon('plus', 15), 'Add person'),
      ),
    ),
    h('div', { class: 'grid grid-kpi', style: { marginBottom: '14px' } },
      miniKpi('users', 'People in scope', fmtNum(state.totals?.employees || 0)),
      miniKpi('table', 'Placements', fmtNum(state.totals?.assignments || 0)),
      miniKpi('layers', 'Projects', fmtNum(state.tree.length)),
      miniKpi('alert', 'Pending reviews', fmtNum(state.totals?.pendingReviews || 0), () => window.__rp.go('datahub')),
    ),
    workspace,
  ));

  function renderCrumbs() {
    const p = state.tree.find((x) => x.id === scope.projectId);
    ctx.setCrumbs([
      { label: 'Employee directory', onclick: () => { scope.projectId = null; projectFilter.value = ''; table.setScope(scope); } },
      ...(p ? [{ label: p.name }] : []),
    ]);
  }

  renderCrumbs();
  table.setScope(scope);
}

function miniKpi(iconName, label, value, onclick) {
  return h('button', {
    class: 'kpi', style: { textAlign: 'left', cursor: onclick ? 'pointer' : 'default', font: 'inherit' }, onclick,
  },
    h('div', { class: 'kpi-top' },
      h('span', { class: 'kpi-label' }, label),
      h('span', { class: 'kpi-icon' }, icon(iconName, 16)),
    ),
    h('div', { class: 'kpi-value', style: { fontSize: '22px' } }, value),
  );
}

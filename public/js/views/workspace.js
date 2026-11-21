/* =========================================================================
   Project workspace — the drill-down experience.
   Rail: project -> subproject -> category. Main: dynamic table + embedded CRM.
   Breadcrumbs persist so supervisors can hop between projects without
   returning to the dashboard.
   ========================================================================= */
import {
  h, mount, icon, api, state, fmtNum, spinner, emptyState, statusBadge, toast,
} from '../core.js';
import { createTable } from './table.js';
import { createCrm } from './crm.js';
import { createSubmitPanel } from './submit.js';
import { openExportModal } from './datahub.js';

export function renderWorkspace(content, ctx) {
  const params = ctx.params || {};
  const startProjectId = params.project ? Number(params.project) : null;

  const scope = {
    projectId: startProjectId,
    subprojectId: params.subproject ? Number(params.subproject) : null,
    categoryId: params.category ? Number(params.category) : null,
  };

  const railBody = h('div', { class: 'drill-rail-body' });
  const railHead = h('div', { class: 'drill-rail-head' });
  const mainHost = h('div', { class: 'drill-main' });
  const rail = h('div', { class: 'drill-rail' }, railHead, railBody);

  let crmVisible = !ctx.crmCollapsed;

  // The supervisor's daily job is filling in the update fields and pressing
  // Submit. The fuller CRM panel stays available for people management
  // (contact details, new joiners, histories).
  const submit = createSubmitPanel({
    getScope: () => scope,
    onSaved: () => { table.refresh(); },
  });

  const crm = createCrm({
    getScope: () => scope,
    onChanged: () => { table.refresh(); },
  });
  crm.el.classList.add('hidden');
  let panel = 'submit';   // submit | crm
  const table = createTable({
    onSelect: (row) => {
      if (panel === 'submit') submit.show(row.assignmentId);
      else crm.showAssignment(row.assignmentId);
    },
    onSaved: () => {},
  });
  submit.el.classList.toggle('hidden', !crmVisible);

  const workspace = h('div', { class: `workspace ${crmVisible ? '' : 'crm-collapsed'}` },
    table.el,
    submit.el,
    crm.el,
  );

  function setPanel(next) {
    panel = next;
    const showSubmit = next === 'submit';
    submit.el.classList.toggle('hidden', !crmVisible || !showSubmit);
    crm.el.classList.toggle('hidden', !crmVisible || showSubmit);
    for (const b of workspace.querySelectorAll('.panel-toggle')) {
      b.classList.toggle('active', b.dataset.panel === next);
    }
    if (crmVisible) {
      if (showSubmit) submit.show(table.selectedId?.());
      else crm.showList();
    }
  }

  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, 'Project workspace'),
        h('div', { class: 'page-sub' }, 'Pick a project, then walk down through subprojects and categories. Columns and permissions adapt to each category.'),
      ),
      h('div', { class: 'page-actions' },
        h('div', { class: 'panel-switch', role: 'group', 'aria-label': 'Side panel' },
          h('button', {
            class: 'panel-toggle active', dataset: { panel: 'submit' },
            onclick: () => setPanel('submit'),
          }, icon('edit', 14), 'Update'),
          h('button', {
            class: 'panel-toggle', dataset: { panel: 'crm' },
            onclick: () => setPanel('crm'),
          }, icon('contact', 14), 'CRM'),
        ),
        h('button', {
          class: 'btn',
          onclick: () => {
            crmVisible = !crmVisible;
            submit.el.classList.toggle('hidden', !crmVisible || panel !== 'submit');
            crm.el.classList.toggle('hidden', !crmVisible || panel !== 'crm');
            workspace.classList.toggle('crm-collapsed', !crmVisible);
            ctx.crmCollapsed = !crmVisible;
            if (crmVisible) setPanel(panel);
          },
        }, icon('columns', 15), crmVisible ? 'Hide panel' : 'Show panel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => { setPanel('crm'); crm.newPerson(); },
        }, icon('plus', 15), 'Add person'),
      ),
    ),
    h('div', { class: 'drill' }, rail, mainHost),
  ));

  /* ------------------------------------------------------------- rail */
  function renderRail() {
    const tree = state.tree || [];
    if (!tree.length) {
      mount(railHead, h('div', { class: 'card-title' }, 'Projects'));
      mount(railBody, emptyState({
        title: 'No project access', message: 'An administrator has not granted you access to any project yet.', iconName: 'shield',
      }));
      return;
    }

    const search = h('input', {
      class: 'input', type: 'search', placeholder: 'Filter projects…', style: { height: '30px', fontSize: '12.5px' },
      oninput: (e) => {
        const t = e.target.value.toLowerCase();
        railBody.querySelectorAll('.project-wrap').forEach((el) => {
          el.classList.toggle('hidden', !el.dataset.name.includes(t));
        });
      },
    });

    mount(railHead,
      h('div', { class: 'spread', style: { marginBottom: '8px' } },
        h('span', { class: 'field-label' }, `${tree.length} authorized project${tree.length === 1 ? '' : 's'}`),
        h('button', {
          class: 'btn btn-ghost btn-xs',
          onclick: () => { scope.projectId = null; scope.subprojectId = null; scope.categoryId = null; update(); },
        }, 'Reset'),
      ),
      h('div', { class: 'search-box' }, icon('search', 14), search),
    );

    const nodes = tree.map((p) => {
      const isActive = scope.projectId === p.id;
      const card = h('button', {
        class: `project-card ${isActive ? 'active' : ''}`,
        onclick: () => {
          if (scope.projectId === p.id) {
            scope.projectId = null; scope.subprojectId = null; scope.categoryId = null;
          } else {
            scope.projectId = p.id; scope.subprojectId = null; scope.categoryId = null;
          }
          update();
        },
      },
        h('div', { class: 'pc-name' }, icon(isActive ? 'chevronDown' : 'chevronRight', 13), p.name),
        h('div', { class: 'pc-meta' },
          h('span', { class: 'pc-code' }, p.code),
          h('span', null, `${p.subprojects.length} subproject${p.subprojects.length === 1 ? '' : 's'}`),
          p.grant && !p.grant.can_edit ? h('span', { class: 'badge badge-warn', style: { height: '17px', fontSize: '10px', padding: '0 6px' } }, 'Read only') : null,
        ),
      );

      const children = [];
      if (isActive) {
        for (const s of p.subprojects) {
          const subActive = scope.subprojectId === s.id;
          children.push(h('button', {
            class: `tree-node ${subActive ? 'active' : ''}`,
            style: { marginTop: '4px' },
            onclick: () => {
              if (subActive) { scope.subprojectId = null; scope.categoryId = null; }
              else { scope.subprojectId = s.id; scope.categoryId = null; }
              update();
            },
          },
            h('span', { class: 'node-icon' }, icon(subActive ? 'chevronDown' : 'folder', 14)),
            h('span', { class: 'node-name' }, s.name),
            h('span', { class: 'count-pill' }, s.employeeCount),
          ));
          if (subActive) {
            children.push(h('div', { class: 'tree-child' },
              ...s.categories.map((c) => h('button', {
                class: `tree-node ${scope.categoryId === c.id ? 'active' : ''}`,
                onclick: () => {
                  scope.categoryId = scope.categoryId === c.id ? null : c.id;
                  update();
                },
              },
                h('span', { class: 'node-icon' }, icon('table', 13)),
                h('span', { class: 'node-name' }, c.name),
              )),
            ));
          }
        }
      }

      return h('div', { class: 'project-wrap', dataset: { name: p.name.toLowerCase() } }, card, ...children);
    });

    mount(railBody, ...nodes);
  }

  /* ------------------------------------------------------------- main */
  function currentProject() { return (state.tree || []).find((p) => p.id === scope.projectId) || null; }
  function currentSub() {
    const p = currentProject();
    return p ? p.subprojects.find((s) => s.id === scope.subprojectId) || null : null;
  }
  function currentCat() {
    const s = currentSub();
    return s ? s.categories.find((c) => c.id === scope.categoryId) || null : null;
  }

  function renderMain() {
    const project = currentProject();
    const sub = currentSub();
    const cat = currentCat();

    let header;
    if (!project) {
      header = h('div', { class: 'ws-head' },
        h('div', { class: 'card-head' },
          h('div', null,
            h('div', { class: 'card-title' }, 'All authorized projects'),
            h('div', { class: 'card-sub' }, 'Choose a project on the left to drill down. The table below spans every project you can see.'),
          ),
          h('div', { class: 'row', style: { gap: '6px' }, id: 'overview-badges' }),
        ),
      );
    } else {
      header = h('div', { class: 'ws-head' },
        h('div', { class: 'card-head' },
          h('div', { class: 'grow', style: { minWidth: '0' } },
            h('div', { class: 'row', style: { gap: '9px', flexWrap: 'wrap' } },
              h('span', { class: 'badge badge-brand' }, project.code),
              h('h2', { style: { fontSize: '15px' } }, project.name),
              project.client ? h('span', { class: 'badge badge-outline' }, project.client) : null,
              project.grant && !project.grant.can_edit ? h('span', { class: 'badge badge-warn' }, 'Read only') : null,
            ),
            h('div', { class: 'card-sub', style: { marginTop: '3px' } }, project.description || ''),
          ),
          h('div', { class: 'toolbar-group' },
            h('button', {
              class: 'btn btn-sm', title: 'Export this scope to Excel',
              onclick: () => openExportModal({ projectId: project.id, subprojectId: sub?.id, categoryId: cat?.id }),
            }, icon('download', 14), 'Export'),
            state.user.isAdmin
              ? h('a', { class: 'btn btn-sm btn-ghost', href: '#/admin?tab=columns' }, icon('sliders', 14), 'Layouts')
              : null,
          ),
        ),
        scopeTabs(project, sub, cat),
      );
    }

    // Swap only the header. The table element is reused so in-flight cell
    // edits and scroll position survive navigation between scopes.
    const existing = mainHost.querySelector('.ws-head');
    if (existing) existing.replaceWith(header);
    else mainHost.prepend(header);
    if (table.el.parentElement !== mainHost) mainHost.appendChild(table.el);
    if (!project) refreshBadge();
    updateCrumbs();
  }

  function scopeTabs(project, sub, cat) {
    if (!project) return h('div');
    const tabs = [];
    tabs.push(h('button', {
      class: `tab ${!sub ? 'active' : ''}`,
      onclick: () => { scope.subprojectId = null; scope.categoryId = null; update(); },
    }, icon('folder', 14), 'All subprojects'));
    for (const s of project.subprojects) {
      tabs.push(h('button', {
        class: `tab ${sub?.id === s.id ? 'active' : ''}`,
        onclick: () => { scope.subprojectId = s.id; scope.categoryId = null; update(); },
      }, s.name, h('span', { class: 'count-pill' }, s.employeeCount)));
    }
    const bar = h('div', { class: 'tabs' }, ...tabs);
    let catBar = null;
    if (sub) {
      catBar = h('div', { class: 'tabs', style: { borderTop: 'none', paddingTop: '0' } },
        h('button', {
          class: `tab ${!cat ? 'active' : ''}`,
          onclick: () => { scope.categoryId = null; update(); },
        }, 'All categories'),
        ...sub.categories.map((c) => h('button', {
          class: `tab ${cat?.id === c.id ? 'active' : ''}`,
          onclick: () => { scope.categoryId = c.id; update(); },
        }, icon('table', 13), c.name)),
      );
    }
    return h('div', null, bar, catBar);
  }

  /* ------------------------------------------------------------- update */
  function update() {
    renderRail();
    renderMain();
    // keep the URL shareable / deep-linkable
    const qs = new URLSearchParams();
    if (scope.projectId) qs.set('project', scope.projectId);
    if (scope.subprojectId) qs.set('subproject', scope.subprojectId);
    if (scope.categoryId) qs.set('category', scope.categoryId);
    const next = `#/workspace${qs.toString() ? `?${qs}` : ''}`;
    if (location.hash !== next) history.replaceState(null, '', next);
    ctx.state = scope;
    table.setScope(scope);
  }

  function refreshBadge() {
    const host = mainHost.querySelector('#overview-badges');
    if (host) {
      mount(host, h('span', { class: 'badge badge-neutral' }, `${fmtNum(state.tree.length)} projects`),
        h('span', { class: 'badge badge-outline' }, 'Select a project to drill down'));
    }
  }

  function updateCrumbs() {
    const project = currentProject();
    const sub = currentSub();
    const cat = currentCat();
    const items = [{ label: 'Project workspace', onclick: () => { scope.projectId = null; scope.subprojectId = null; scope.categoryId = null; update(); } }];
    if (project) items.push({ label: project.name, onclick: () => { scope.subprojectId = null; scope.categoryId = null; update(); } });
    if (sub) items.push({ label: sub.name, onclick: () => { scope.categoryId = null; update(); } });
    if (cat) items.push({ label: cat.name });
    if (ctx.setCrumbs) ctx.setCrumbs(items);
  }

  // react to the panel close button inside the CRM
  const closeHandler = (e) => {
    if (e.detail?.collapsed) {
      crmVisible = false;
      crm.el.classList.add('hidden');
      submit.el.classList.add('hidden');
      workspace.classList.add('crm-collapsed');
    }
  };
  document.addEventListener('rp:toggle-crm', closeHandler);
  const cleanup = () => {
    document.removeEventListener('rp:toggle-crm', closeHandler);
    document.removeEventListener('rp:close-panel', closeHandler);
  };
  document.addEventListener('rp:close-panel', closeHandler);
  window.addEventListener('hashchange', cleanup, { once: true });

  renderRail();
  renderMain();
  updateCrumbs();
  table.setScope(scope);

  return cleanup;
}

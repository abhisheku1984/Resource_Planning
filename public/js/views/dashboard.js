import {
  h, mount, icon, api, state, fmtNum, fmtRelative, spinner, emptyState,
  statusBadge, fmtDate, toast,
} from '../core.js';

const PIE_COLORS = ['#1f5fbf', '#0f9d8b', '#a86300', '#7c4dbe', '#b42318', '#4f92ec', '#8494a9'];

export async function renderDashboard(content, ctx) {
  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, `Good ${greeting()}, ${state.user.name.split(' ')[0]}`),
        h('div', { class: 'page-sub' }, state.user.gigaAccess ? `Giga Project Name: ${state.user.gigaAccess.name || 'No project access'}`
          : 'A consolidated view of the workforce you are authorized to see.'),
      ),
      h('div', { class: 'page-actions' },
        h('button', { class: 'btn', onclick: () => window.__rp.go('directory') }, icon('users', 15), 'Employee directory'),
        h('button', { class: 'btn btn-primary', onclick: () => window.__rp.go('workspace') }, icon('layers', 15), 'Open project workspace'),
      ),
    ),
    h('div', { class: 'grid grid-kpi', style: { marginBottom: '14px' } },
      skeletonKpi(), skeletonKpi(), skeletonKpi(), skeletonKpi(),
    ),
    h('div', { id: 'dash-body' }, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading dashboard…')))),
  ));

  let data;
  try {
    data = await api('/dashboard');
  } catch (err) {
    mount(document.getElementById('dash-body'), h('div', { class: 'card' }, emptyState({
      title: 'Dashboard unavailable', message: err.message, iconName: 'alert',
    })));
    return;
  }
  state.dashboard = data;
  if (!document.getElementById('dash-body')) return;
  paint(data);
}

function paint(data) {
  const host = document.getElementById('dash-body');
  if (!host) return;

  const kpis = h('div', { class: 'grid grid-kpi', style: { marginBottom: '14px' } },
    kpi('employees', 'People in scope', fmtNum(data.totals.employees), `${fmtNum(data.totals.assignments)} placements`, 'users', () => window.__rp.go('directory')),
    kpi('layers', state.user.gigaAccess ? 'Hierarchy projects in scope' : 'Projects', fmtNum(data.totals.projects), `${state.tree.reduce((a, p) => a + p.subprojects.length, 0)} subprojects`, 'layers', () => window.__rp.go('workspace')),
    kpi('truck', 'Suppliers', fmtNum(data.totals.suppliers), 'Active partner network', 'truck', () => window.__rp.go('admin')),
    kpi('alert',
      'Needs attention',
      fmtNum((data.attention || []).length + (state.totals?.pendingReviews || 0)),
      state.totals?.pendingReviews ? `${state.totals.pendingReviews} duplicate review${state.totals.pendingReviews > 1 ? 's' : ''}` : 'Status exceptions & unassigned',
      'alert',
      () => window.__rp.go(state.totals?.pendingReviews ? 'datahub' : 'directory')),
  );

  const byStatus = data.byStatus || [];
  const totalStatus = byStatus.reduce((a, s) => a + s.c, 0) || 1;

  const statusCard = h('div', { class: 'card' },
    cardHead('Workforce status', null),
    h('div', { class: 'card-body' },
      byStatus.length
        ? h('div', { class: 'donut-wrap' },
          donut(byStatus, totalStatus),
          h('div', { class: 'donut-legend' },
            ...byStatus.slice(0, 6).map((s, i) => h('div', { class: 'legend-item' },
              h('span', { class: 'legend-swatch', style: { background: PIE_COLORS[i % PIE_COLORS.length] } }),
              h('span', { class: 'truncate' }, s.status),
              h('span', { class: 'legend-value' }, fmtNum(s.c)),
            )),
          ),
        )
        : emptyState({ title: 'No status data', message: 'Assign employees to a category to populate this chart.', iconName: 'pie' }),
    ),
  );

  const projectCard = h('div', { class: 'card' },
    cardHead('Employees by project', 'Placements in your authorized projects'),
    h('div', { class: 'card-body' },
      (data.byProject || []).length
        ? h('div', { class: 'chart-bar' },
          ...data.byProject.map((p) => {
            const max = Math.max(...data.byProject.map((x) => x.c), 1);
            return h('div', {
              class: 'bar-row',
              style: { cursor: 'pointer' },
              onclick: () => { location.hash = `#/workspace?project=${p.id}`; },
              title: `${p.c} placements · ${p.active} active`,
            },
              h('span', { class: 'bar-label' }, p.name),
              h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${(p.c / max) * 100}%` } })),
              h('span', { class: 'bar-value' }, fmtNum(p.c)),
            );
          }),
        )
        : emptyState({ title: 'No projects assigned', message: 'Ask an administrator to grant you project access.', iconName: 'folder' }),
    ),
  );

  const supplierCard = h('div', { class: 'card' },
    cardHead('Supplier mix', 'Top partners by placement count'),
    h('div', { class: 'card-body' },
      (data.bySupplier || []).length
        ? h('div', { class: 'chart-bar' },
          ...data.bySupplier.map((s) => {
            const max = Math.max(...data.bySupplier.map((x) => x.c), 1);
            return h('div', { class: 'bar-row' },
              h('span', { class: 'bar-label' }, s.name),
              h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${(s.c / max) * 100}%`, background: 'linear-gradient(90deg,#0f9d8b,#37bfa9)' } })),
              h('span', { class: 'bar-value' }, fmtNum(s.c)),
            );
          }),
        )
        : emptyState({ title: 'No supplier data', iconName: 'truck' }),
    ),
  );

  const attentionCard = h('div', { class: 'card' },
    cardHead('Needs attention', 'Records with exceptions or missing data'),
    h('div', { class: 'card-body flush' },
      (data.attention || []).length
        ? h('div', null,
          ...data.attention.map((a) => h('button', {
            class: 'list-item',
            style: { borderRadius: '0', borderBottom: '1px solid var(--line)', padding: '10px 16px' },
            onclick: () => { location.hash = `#/workspace?project=${a.project_id || ''}`; },
          },
            h('div', { class: 'grow', style: { minWidth: '0' } },
              h('div', { class: 'row', style: { gap: '7px' } },
                h('span', { style: { fontWeight: '600', fontSize: '12.5px' } }, a.name),
                h('span', { class: 'mono subtle', style: { fontSize: '11px' } }, a.emp_code),
              ),
              h('div', { class: 'subtle', style: { fontSize: '11.5px' } }, `${a.project_name} · ${a.category_name}`),
            ),
            statusBadge(a.status),
          )),
        )
        : emptyState({ title: 'All clear', message: 'No exceptions detected in your projects.', iconName: 'checkCircle' }),
    ),
  );

  const activityCard = h('div', { class: 'card' },
    cardHead('Recent activity', 'Latest changes from supervisors', h('button', {
      class: 'btn btn-ghost btn-xs', onclick: () => window.__rp.go('audit'),
    }, 'View all', icon('chevronRight', 13))),
    h('div', { class: 'card-body' },
      (data.activity || []).length
        ? h('div', { class: 'timeline' },
          ...data.activity.slice(0, 8).map((a) => h('div', { class: 'tl-item' },
            h('div', { class: 'tl-dot' }, icon(a.action === 'create' ? 'plus' : 'edit', 11)),
            h('div', { class: 'tl-body' },
              h('div', { class: 'tl-line1' },
                h('span', { style: { fontWeight: '600' } }, a.actor_name || 'System'),
                ' updated ',
                a.field_key ? h('span', { class: 'tl-field' }, humanField(a.field_key)) : 'a record',
                a.ref ? h('span', { class: 'subtle' }, ` · ${a.ref}`) : null,
              ),
              h('div', { class: 'tl-meta' },
                a.old_value ? h('span', null, h('span', { class: 'tl-old' }, trunc(a.old_value)), ' → ', h('span', { class: 'tl-new' }, trunc(a.new_value))) : trunc(a.new_value || ''),
                ' · ', fmtRelative(a.at),
              ),
            ),
          )),
        )
        : emptyState({ title: 'No recent activity', iconName: 'history' }),
    ),
  );

  mount(host,
    kpis,
    h('div', { class: 'grid grid-dash', style: { marginBottom: '14px' } }, projectCard, statusCard),
    h('div', { class: 'grid grid-dash' },
      h('div', { class: 'col', style: { gap: '14px' } }, attentionCard, supplierCard),
      h('div', { class: 'col', style: { gap: '14px' } }, activityCard,
        h('div', { class: 'card' },
          cardHead('Quick actions'),
          h('div', { class: 'card-body col', style: { gap: '8px' } },
            h('button', { class: 'btn btn-block', style: { justifyContent: 'flex-start' }, onclick: () => window.__rp.go('workspace') }, icon('layers', 15), 'Browse projects & subprojects'),
            h('button', { class: 'btn btn-block', style: { justifyContent: 'flex-start' }, onclick: () => window.__rp.go('datahub') }, icon('download', 15), 'Generate Excel export'),
            h('button', { class: 'btn btn-block', style: { justifyContent: 'flex-start' }, onclick: () => window.__rp.go('directory') }, icon('contact', 15), 'Open contact CRM'),
          ),
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ pieces */
function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening';
}
const trunc = (s) => { const t = String(s || ''); return t.length > 32 ? `${t.slice(0, 30)}…` : t; };
const humanField = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function cardHead(title, sub, extra) {
  return h('div', { class: 'card-head' },
    h('div', null,
      h('div', { class: 'card-title' }, title),
      sub ? h('div', { class: 'card-sub' }, sub) : null,
    ),
    extra || null,
  );
}

function kpi(iconName, label, value, foot, iconKey, onclick) {
  return h('button', {
    class: 'kpi',
    style: { textAlign: 'left', cursor: onclick ? 'pointer' : 'default', font: 'inherit' },
    onclick,
  },
    h('div', { class: 'kpi-top' },
      h('span', { class: 'kpi-label' }, label),
      h('span', { class: 'kpi-icon' }, icon(iconKey, 16)),
    ),
    h('div', { class: 'kpi-value' }, value),
    h('div', { class: 'kpi-foot' }, foot),
  );
}

function skeletonKpi() {
  return h('div', { class: 'kpi' },
    h('div', { class: 'skeleton', style: { width: '40%', height: '12px' } }),
    h('div', { class: 'skeleton', style: { width: '55%', height: '26px' } }),
    h('div', { class: 'skeleton', style: { width: '65%', height: '11px' } }),
  );
}

function donut(items, total) {
  const size = 132;
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const segs = items.slice(0, 6).map((s, i) => {
    const frac = s.c / total;
    const seg = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${PIE_COLORS[i % PIE_COLORS.length]}" stroke-width="15" stroke-dasharray="${frac * c} ${c}" stroke-dashoffset="${-offset * c}" transform="rotate(-90 ${size / 2} ${size / 2})" />`;
    offset += frac;
    return seg;
  }).join('');
  const el = h('div', { class: 'donut', html: `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${segs}<circle cx="${size / 2}" cy="${size / 2}" r="38" fill="white"/></svg>` });
  const label = h('div', {
    style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', pointerEvents: 'none' },
    html: `<div style="text-align:center"><div style="font-size:21px;font-weight:680;letter-spacing:-.03em">${fmtNum(total)}</div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Placements</div></div>`,
  });
  el.style.position = 'relative';
  el.appendChild(label);
  return el;
}

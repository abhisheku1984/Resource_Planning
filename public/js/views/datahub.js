/* =========================================================================
   Data Hub — Excel generation, daily dataset synchronization, duplicate queue.
   The database remains the single source of truth; workbooks are snapshots.
   ========================================================================= */
import {
  h, mount, icon, api, state, toast, spinner, emptyState, modal, fmtNum,
  fmtDateTime, fmtRelative, downloadExport, confirmDialog,
} from '../core.js';

export async function renderDataHub(content, ctx) {
  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, 'Data Hub'),
        h('div', { class: 'page-sub' }, 'Generate an Excel snapshot of the central database at any scope, or apply a daily dataset without disturbing supervisor edits.'),
      ),
      h('div', { class: 'page-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => openExportModal({}) }, icon('download', 15), 'Generate export'),
      ),
    ),
    h('div', { id: 'hub-body' }, h('div', { class: 'card' }, h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading…')))),
  ));

  let imports = [];
  try {
    const res = await api('/imports');
    imports = res.imports || [];
  } catch { /* imports list is non-critical */ }

  const host = document.getElementById('hub-body');
  if (!host) return;

  mount(host,
    h('div', { class: 'grid grid-2', style: { marginBottom: '14px' } },
      exportCard(),
      importCard(imports),
    ),
    h('div', { id: 'dup-host', style: { marginTop: '14px' } }, duplicateCard(imports)),
  );
}

/* ------------------------------------------------------------------ export */
function exportCard() {
  const scopes = [
    { key: 'all', label: 'Consolidated (all authorized projects)', desc: 'Every placement you can see, with the full column set.', icon: 'grid' },
    { key: 'project', label: 'Project-wise', desc: 'Pick one project and export all of its subprojects and categories.', icon: 'folder' },
    { key: 'subproject', label: 'Subproject-wise', desc: 'A single subproject across all of its categories.', icon: 'layers' },
    { key: 'supplier', label: 'Supplier-wise', desc: 'Every placement delivered by one supplier.', icon: 'truck' },
    { key: 'category', label: 'Category-wise', desc: 'A category with exactly its configured columns.', icon: 'table' },
  ];

  const body = h('div', { class: 'col', style: { gap: '8px' } },
    ...scopes.map((s) => h('button', {
      class: 'list-item',
      style: { border: '1px solid var(--line)', padding: '11px 12px' },
      onclick: () => openExportModal({ preset: s.key }),
    },
      h('div', {
        style: {
          width: '30px', height: '30px', borderRadius: '8px', display: 'grid', placeItems: 'center',
          background: 'var(--brand-50)', color: 'var(--brand)', flex: '0 0 auto',
        },
      }, icon(s.icon, 15)),
      h('div', { class: 'grow' },
        h('div', { class: 'li-name' }, s.label),
        h('div', { class: 'li-meta' }, s.desc),
      ),
      icon('chevronRight', 15),
    )),
  );

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null,
        h('div', { class: 'card-title' }, icon('download', 15), 'Excel exports'),
        h('div', { class: 'card-sub' }, 'Generated from the database on demand — never a shared live file.'),
      ),
    ),
    h('div', { class: 'card-body' }, body,
      h('div', { class: 'note', style: { marginTop: '12px' } }, icon('info', 15),
        h('span', null, 'Each workbook contains an Employees sheet with the live snapshot and a Summary sheet grouped by project, subproject and category.')),
    ),
  );
}

export function openExportModal(initial = {}) {
  const scope = {
    projectId: initial.projectId || null,
    subprojectId: initial.subprojectId || null,
    categoryId: initial.categoryId || null,
    supplierId: initial.supplierId || null,
  };
  const preset = initial.preset || (initial.projectId ? 'project' : 'all');

  const projectSel = h('select', { class: 'select', onchange: () => { scope.projectId = Number(projectSel.value) || null; syncSubs(); } },
    h('option', { value: '' }, 'All authorized projects'),
    ...state.tree.map((p) => h('option', { value: p.id, selected: p.id === scope.projectId }, p.name)),
  );
  const subSel = h('select', { class: 'select', onchange: () => { scope.subprojectId = Number(subSel.value) || null; syncCats(); } });
  const catSel = h('select', { class: 'select', onchange: () => { scope.categoryId = Number(catSel.value) || null; } });
  const supSel = h('select', { class: 'select', onchange: () => { scope.supplierId = Number(supSel.value) || null; } },
    h('option', { value: '' }, 'All suppliers'),
    ...(state.suppliers || []).map((s) => h('option', { value: s.id, selected: s.id === scope.supplierId }, s.name)),
  );

  function syncSubs() {
    const p = state.tree.find((x) => x.id === scope.projectId);
    scope.subprojectId = null;
    subSel.replaceChildren(h('option', { value: '' }, p ? 'All subprojects' : 'Select a project first'),
      ...(p ? p.subprojects.map((s) => h('option', { value: s.id }, s.name)) : []));
    syncCats();
  }
  function syncCats() {
    const p = state.tree.find((x) => x.id === scope.projectId);
    const s = p?.subprojects.find((x) => x.id === scope.subprojectId);
    scope.categoryId = null;
    catSel.replaceChildren(h('option', { value: '' }, s ? 'All categories' : 'Select a subproject first'),
      ...(s ? s.categories.map((c) => h('option', { value: c.id }, c.name)) : []));
  }
  syncSubs();

  const previewHost = h('div', { class: 'note', style: { marginTop: '12px' } }, icon('info', 15),
    h('span', null, 'The workbook is built from the current database state and includes who last updated each record.'));

  const btn = h('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      btn.disabled = true;
      btn.replaceChildren(spinner(), 'Generating…');
      try {
        const res = await downloadExport(scope);
        document.querySelector('.overlay')?.remove();
        toast('Export ready', `${res.filename} · ${fmtNum(res.rows)} rows.`, 'success', 5200);
      } catch (err) {
        toast('Export failed', err.message, 'error');
        btn.disabled = false;
        btn.replaceChildren(icon('download', 15), 'Download Excel');
      }
    },
  }, icon('download', 15), 'Download Excel');

  modal({
    title: 'Generate Excel export',
    subtitle: 'Choose the scope. The file reflects the database right now.',
    body: h('div', null,
      h('div', { class: 'crm-grid' },
        h('div', { class: 'field span-2' }, h('label', { class: 'field-label' }, 'Project'), projectSel),
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Subproject'), subSel),
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Category'), catSel),
        h('div', { class: 'field span-2' }, h('label', { class: 'field-label' }, 'Supplier (optional)'), supSel),
      ),
      previewHost,
    ),
    footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
      h('button', { class: 'btn', onclick: () => document.querySelector('.overlay')?.remove() }, 'Cancel'),
      btn,
    ),
  });
}

/* ------------------------------------------------------------------ import */
function importCard(imports) {
  const canImport = state.user.isAdmin || state.user.capabilities?.['import.data'];
  const fileInput = h('input', {
    type: 'file', accept: '.xlsx', class: 'sr-only', id: 'import-file',
    onchange: () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); },
  });
  const dropZone = h('div', {
    class: 'empty',
    style: {
      border: '2px dashed var(--line-strong)', borderRadius: '10px', margin: '0', padding: '26px 16px',
      cursor: canImport ? 'pointer' : 'not-allowed', background: 'var(--surface-2)',
    },
    onclick: () => canImport && fileInput.click(),
    ondragover: (e) => { e.preventDefault(); if (canImport) dropZone.style.borderColor = 'var(--brand)'; },
    ondragleave: () => { dropZone.style.borderColor = 'var(--line-strong)'; },
    ondrop: (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--line-strong)';
      if (!canImport) return;
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
  },
    h('div', { class: 'empty-icon' }, icon('upload', 22)),
    h('div', { class: 'empty-title' }, canImport ? 'Upload a daily dataset' : 'Import not permitted'),
    h('div', { class: 'empty-body' }, canImport
      ? 'Drop an .xlsx file here or click to browse. Rows are matched on Employee ID; supervisor edits are protected.'
      : 'Ask an administrator to grant the import capability.'),
  );

  const historyHost = h('div', { class: 'col', style: { gap: '6px', marginTop: '12px' } },
    imports.length
      ? [
        h('div', { class: 'crm-section-title' }, 'Recent uploads'),
        ...imports.slice(0, 4).map((im) => h('div', { class: 'spread', style: { fontSize: '12px', padding: '5px 0', borderBottom: '1px solid var(--line)' } },
          h('div', { class: 'col', style: { minWidth: '0' } },
            h('span', { class: 'truncate', style: { fontWeight: '600' } }, im.filename),
            h('span', { class: 'subtle', style: { fontSize: '11px' } }, `${fmtRelative(im.uploaded_at)} · ${im.uploaded_by_name || 'system'}`),
          ),
          h('div', { class: 'row', style: { gap: '4px' } },
            im.created ? h('span', { class: 'badge badge-success', style: { height: '18px', fontSize: '10px' } }, `+${im.created}`) : null,
            im.updated ? h('span', { class: 'badge badge-info', style: { height: '18px', fontSize: '10px' } }, `↻${im.updated}`) : null,
            im.protected ? h('span', { class: 'badge badge-warn', style: { height: '18px', fontSize: '10px' }, title: 'Supervisor-edited values kept' }, `🔒${im.protected}`) : null,
            im.flagged ? h('span', { class: 'badge badge-danger', style: { height: '18px', fontSize: '10px' }, title: 'Possible duplicates flagged' }, `!${im.flagged}`) : null,
          ),
        )),
      ]
      : [h('div', { class: 'subtle', style: { fontSize: '12px', marginTop: '10px' } }, 'No uploads yet in this environment.')],
  );

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null,
        h('div', { class: 'card-title' }, icon('upload', 15), 'Dataset synchronization'),
        h('div', { class: 'card-sub' }, 'Upsert by employee ID inside a single transaction.'),
      ),
      h('button', {
        class: 'btn btn-ghost btn-xs', onclick: () => downloadExport({}),
        title: 'Download the current dataset as the import template',
      }, icon('download', 13), 'Template'),
    ),
    h('div', { class: 'card-body' },
      fileInput,
      dropZone,
      h('div', { class: 'note', style: { marginTop: '12px' } }, icon('shield', 15),
        h('span', null, 'Protected fields: if a supervisor edited a value by hand, a daily upload will not silently overwrite it. An administrator can override explicitly.')),
      historyHost,
    ),
  );

  async function handleFile(file) {
    if (!/\.xlsx$/i.test(file.name)) {
      toast('Unsupported file', 'Upload an Excel .xlsx workbook.', 'error');
      return;
    }
    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const modalRef = showImportPreview(file.name, base64);
    fileInput.value = '';
  }
}

function showImportPreview(filename, base64) {
  const host = h('div', null, h('div', { class: 'row' }, spinner(), h('span', { class: 'muted' }, 'Validating workbook…')));
  const ref = modal({
    title: 'Import preview',
    subtitle: filename,
    size: 'modal-lg',
    body: host,
    footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
      h('button', { class: 'btn', onclick: () => document.querySelector('.overlay')?.remove() }, 'Cancel'),
      h('button', { id: 'apply-import', class: 'btn btn-primary', disabled: true }, icon('check', 15), 'Apply import'),
    ),
  });

  (async () => {
    try {
      const res = await api('/import', { method: 'POST', body: { filename, content: base64, dryRun: true } });
      const r = res.result;
      renderReport(host, r, { dryRun: true });
      const applyBtn = document.getElementById('apply-import');
      applyBtn.disabled = false;
      applyBtn.replaceChildren(icon('check', 15), 'Apply import');
      applyBtn.onclick = async () => {
        applyBtn.disabled = true;
        applyBtn.replaceChildren(spinner(), 'Applying…');
        try {
          const out = await api('/import', { method: 'POST', body: { filename, content: base64 } });
          document.querySelector('.overlay')?.remove();
          toast('Import complete',
            `${out.result.created} created · ${out.result.updated} updated · ${out.result.protected} protected`,
            'success', 6500);
          renderDataHub(document.getElementById('content'), {});
        } catch (err) {
          toast('Import failed', err.message, 'error');
          applyBtn.disabled = false;
          applyBtn.replaceChildren(icon('check', 15), 'Retry import');
        }
      };
    } catch (err) {
      mount(host, h('div', { class: 'note warn' }, icon('alert', 15), err.message));
    }
  })();

  return ref;
}

function renderReport(host, r, { dryRun }) {
  const stat = (label, value, kind) => h('div', { class: 'kpi', style: { padding: '11px 13px' } },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value', style: { fontSize: '21px', color: kind === 'warn' ? 'var(--warn)' : kind === 'danger' ? 'var(--danger)' : 'var(--text)' } }, fmtNum(value)),
  );
  mount(host,
    h('div', { class: 'note', style: { marginBottom: '12px' } }, icon('info', 15),
      h('span', null, dryRun
        ? 'This is a preview. Nothing has been written yet — review the counts and row-level issues below.'
        : 'Import applied.')),
    h('div', { class: 'grid grid-kpi', style: { marginBottom: '12px' } },
      stat('New employees', r.created),
      stat('Updated placements', r.updated),
      stat('Protected values', r.protected, 'warn'),
      stat('Flagged for review', r.flagged, r.flagged ? 'warn' : null),
    ),
    (r.errors || []).length
      ? h('div', null,
        h('div', { class: 'crm-section-title' }, 'Rows needing attention'),
        h('div', { class: 'card', style: { maxHeight: '220px', overflow: 'auto' } },
          h('div', { class: 'card-body', style: { padding: '8px 12px' } },
            ...r.errors.map((e) => h('div', { class: 'row', style: { fontSize: '12px', padding: '4px 0', borderBottom: '1px solid var(--line)', gap: '10px' } },
              h('span', { class: 'mono subtle', style: { flex: '0 0 54px' } }, `row ${e.row}`),
              h('span', { class: 'grow' }, e.message),
            )),
          ),
        ),
      )
      : h('div', { class: 'note' }, icon('checkCircle', 15), h('span', null, 'No row-level problems detected.')),
  );
}

/* ------------------------------------------------------------------ duplicates */
function duplicateCard() {
  const host = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null,
        h('div', { class: 'card-title' }, icon('merge', 15), 'Duplicate review queue'),
        h('div', { class: 'card-sub' }, 'Name-only or contact matches are never auto-merged. An administrator decides.'),
      ),
    ),
    h('div', { id: 'dup-body', class: 'card-body' }, h('div', { class: 'row' }, spinner(), h('span', { class: 'muted' }, 'Loading…'))),
  );
  loadDuplicates();
  return host;

  async function loadDuplicates() {
    const body = document.getElementById('dup-body');
    if (!body) return;
    if (!state.user.isAdmin) {
      mount(body, emptyState({
        title: 'Administrator review',
        message: 'Possible duplicates are queued here for an administrator. Your additions are always matched against existing Employee IDs first.',
        iconName: 'shield',
      }));
      return;
    }
    try {
      const res = await api('/duplicates?status=pending');
      const rows = res.reviews || [];
      if (!rows.length) {
        mount(body, emptyState({ title: 'Nothing to review', message: 'No uncertain matches are pending. Imports and CRM additions matched cleanly.', iconName: 'checkCircle' }));
        return;
      }
      const table = h('table', { class: 'data' },
        h('thead', null, h('tr', null,
          h('th', null, 'Incoming'), h('th', null, 'Existing candidate'), h('th', null, 'Signal'), h('th', null, 'Detected'), h('th', { style: { width: '220px' } }, 'Decision'),
        )),
        h('tbody', null, ...rows.map((r) => h('tr', null,
          h('td', null,
            h('div', { style: { fontWeight: '600' } }, r.name || '—'),
            h('div', { class: 'mono subtle', style: { fontSize: '11px' } }, r.emp_code || '—'),
            h('div', { class: 'subtle', style: { fontSize: '11px' } }, r.email || r.phone || ''),
          ),
          h('td', null,
            h('div', { style: { fontWeight: '600' } }, r.candidate_name || '—'),
            h('div', { class: 'mono subtle', style: { fontSize: '11px' } }, r.candidate_code || '—'),
          ),
          h('td', { class: 'cell-muted', style: { fontSize: '11.5px', maxWidth: '220px' } }, r.note || '—'),
          h('td', { class: 'cell-muted nowrap', style: { fontSize: '11.5px' } }, fmtRelative(r.created_at)),
          h('td', null, h('div', { class: 'row', style: { gap: '5px' } },
            h('button', {
              class: 'btn btn-xs', title: 'Keep as a separate person',
              onclick: () => resolve(r.id, 'create', (m) => toast('Resolved', m, 'success')),
            }, icon('plus', 12), 'Separate'),
            h('button', {
              class: 'btn btn-xs', title: 'Link to the existing person',
              onclick: () => resolve(r.id, 'link', (m) => toast('Linked', m, 'success')),
            }, icon('link', 12), 'Link'),
            h('button', {
              class: 'btn btn-ghost btn-xs', title: 'Dismiss this flag',
              onclick: () => resolve(r.id, 'dismiss', (m) => toast('Dismissed', m, 'info')),
            }, 'Dismiss'),
          )),
        ))),
      );
      mount(body, h('div', { class: 'table-wrap', style: { maxHeight: 'none' } }, table));
    } catch (err) {
      mount(body, emptyState({ title: 'Could not load queue', message: err.message, iconName: 'alert' }));
    }
  }

  async function resolve(id, action, done) {
    try {
      const res = await api(`/duplicates/${id}/resolve`, { method: 'POST', body: { action } });
      done(action === 'link' ? 'Record linked to the existing employee.' : action === 'create' ? 'Kept as a separate employee.' : 'Flag dismissed.');
      loadDuplicates();
    } catch (err) {
      toast('Could not resolve', err.message, 'error');
    }
  }
}

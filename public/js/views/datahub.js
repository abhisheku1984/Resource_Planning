/* =========================================================================
   Data Hub — Excel generation, daily dataset synchronization, duplicate queue.
   The database remains the single source of truth; workbooks are snapshots.
   ========================================================================= */
import {
  h, mount, icon, api, state, toast, spinner, emptyState, modal, fmtNum,
  fmtDateTime, fmtRelative, downloadExport, downloadWorkbook, confirmDialog,
} from '../core.js';
import { openRosterReplacement, readWorkbook } from './replace-roster.js';

export async function renderDataHub(content, ctx) {
  const giga = state.user?.gigaAccess;
  const canExport = !giga || state.user.capabilities['export.data'];
  const host = h('div', { id: 'hub-body' }, h('div', { class: 'card' },
    h('div', { class: 'card-body row' }, spinner(), h('span', { class: 'muted' }, 'Loading…'))));
  mount(content, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'page-title' }, 'Data Hub'),
        h('div', { class: 'page-sub' }, giga ? `Giga Project Name: ${giga.name || 'No project access'}` : state.user.isAdmin ? 'Export the current roster, merge changes, or replace it with a complete daily workbook.' : 'Export a workbook or merge permitted updates without disturbing supervisor edits.'),
      ),
      h('div', { class: 'page-actions' },
        state.user.isAdmin && !giga ? h('button', { class: 'btn', onclick: () => openRosterReplacement(placementPicker) }, 'Replace entire roster') : null,
        h('button', { class: 'btn btn-primary', disabled: !canExport, onclick: () => openExportModal({}) }, icon('download', 15), 'Generate export'),
      ),
    ),
    host,
  ));

  if (giga) {
    mount(host, canExport ? exportCard() : emptyState({ title: 'Export not permitted', message: 'Ask your administrator if you need an Excel export of your Giga project.', iconName: 'shield' }));
    return; // master imports and duplicate reviews span Giga projects
  }

  let imports = [];
  try {
    const res = await api('/imports');
    imports = res.imports || [];
  } catch { /* imports list is non-critical */ }

  if (!host.isConnected) return; // a newer visit must own its own queue
  const duplicates = createDuplicateCard();
  mount(host,
    h('div', { class: 'grid grid-2', style: { marginBottom: '14px' } },
      exportCard(),
      importCard(imports),
    ),
    h('div', { id: 'dup-host', style: { marginTop: '14px' } }, duplicates.el),
  );
  await duplicates.load(); // the card is now on the page
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
  // where a file without Project/Subproject/Category columns is filed
  const place = { projectId: '', subprojectId: '', categoryId: '' };
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
      ? state.user.browserDemo ? 'Try the unchanged 1,000-row sample or an unmodified export from this tab. Real workforce files are not accepted.'
        : 'Drop an .xlsx file here or click to browse. Matches Employee IDs and keeps rows not in the file. Supervisor edits are protected.'
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
        class: 'btn btn-ghost btn-xs',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            const { filename } = await downloadWorkbook('/api/import/template', {});
            toast('Template downloaded', `${filename} — your 65 columns plus Project / Subproject / Category.`, 'success', 6000);
          } catch (err) {
            toast('Download failed', err.message, 'error');
          } finally { b.disabled = false; }
        },
        title: 'Download a blank workbook with your own 65 headers, ready to fill in',
      }, icon('download', 13), 'Import template'),
    ),
    h('div', { class: 'card-body' },
      fileInput,
      dropZone,
      canImport ? placementPicker(place) : null,
      h('div', { class: 'note', style: { marginTop: '12px' } }, icon('shield', 15),
        h('span', null, 'Protected fields: if a supervisor edited a value by hand, a daily upload will not silently overwrite it. An administrator can override explicitly.')),
      historyHost,
    ),
  );

  async function handleFile(file) {
    fileInput.value = ''; // allow choosing the same file again, including after Cancel
    const placement = place.categoryId ? { ...place } : {};
    try {
      const content = await readWorkbook(file);
      if (fileInput.isConnected) showImportPreview(file.name, content, placement);
    } catch (err) { toast('Could not read workbook', err.message, 'error'); }
  }
}

/**
 * Your HR master workbook has no Project / Subproject / Category column: a
 * spreadsheet row cannot say where the person sits. Pick it once here and every
 * new row is filed there; rows that do carry the three columns still win.
 */
function placementPicker(place) {
  const projSel = h('select', { class: 'input', onchange: () => sync() }, h('option', { value: '' }, 'Select a project…'));
  const subSel = h('select', { class: 'input', disabled: true }, h('option', { value: '' }, 'Select a project first'));
  const catSel = h('select', { class: 'input', disabled: true }, h('option', { value: '' }, 'Select a subproject first'));
  const summary = h('span', { class: 'subtle', style: { fontSize: '12px' } }, 'Loading projects…');

  function sync() {
    const p = state.tree.find((x) => x.id === Number(projSel.value));
    place.projectId = p ? p.id : '';
    place.subprojectId = '';
    place.categoryId = '';
    subSel.replaceChildren(h('option', { value: '' }, p ? 'Select a subproject…' : 'Select a project first'),
      ...(p ? p.subprojects.map((s) => h('option', { value: s.id }, s.name)) : []));
    subSel.disabled = !p;
    catSel.replaceChildren(h('option', { value: '' }, 'Select a subproject first'));
    catSel.disabled = true;
    describe();
  }
  subSel.addEventListener('change', () => {
    const p = state.tree.find((x) => x.id === Number(projSel.value));
    const s = p?.subprojects.find((x) => x.id === Number(subSel.value));
    place.subprojectId = s ? s.id : '';
    place.categoryId = '';
    catSel.replaceChildren(h('option', { value: '' }, s ? 'Select a category…' : 'Select a subproject first'),
      ...(s ? s.categories.map((c) => h('option', { value: c.id }, c.name)) : []));
    catSel.disabled = !s;
    describe();
  });
  catSel.addEventListener('change', () => { place.categoryId = Number(catSel.value) || ''; describe(); });

  function describe() {
    const p = state.tree.find((x) => x.id === Number(place.projectId));
    const s = p?.subprojects.find((x) => x.id === Number(place.subprojectId));
    const c = s?.categories.find((x) => x.id === Number(place.categoryId));
    summary.textContent = c
      ? `Rows without a Project column will be filed under ${p.name} › ${s.name} › ${c.name}.`
      : 'Optional — only needed if your file has no Project / Subproject / Category columns.';
  }

  projSel.replaceChildren(
    h('option', { value: '' }, 'Select a project…'),
    ...state.tree.map((p) => h('option', { value: p.id }, p.name)),
  );
  describe();

  return h('details', { style: { marginTop: '12px' } },
    h('summary', { style: { cursor: 'pointer', fontSize: '13px', fontWeight: '600' } },
      'Where should new rows go?'),
    h('div', { class: 'note', style: { margin: '8px 0' } }, icon('info', 15),
      h('span', null, 'Only choose a destination if your workbook omits placement columns. Rows with Project, Subproject and Category use the placement in the file.')),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' } },
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Project'), projSel),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Subproject'), subSel),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Category'), catSel),
    ),
    h('div', { style: { marginTop: '6px' } }, summary),
  );
}

function showImportPreview(filename, content, placement = {}) {
  const host = h('div', null, h('div', { class: 'row' }, spinner(), h('span', { class: 'muted' }, 'Validating workbook…')));
  const ref = modal({
    title: 'Import preview',
    subtitle: filename,
    size: 'modal-lg',
    body: host,
    footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
      h('button', { class: 'btn', onclick: () => ref.close() }, 'Cancel'),
      h('button', { id: 'apply-import', class: 'btn btn-primary', disabled: true }, icon('check', 15), 'Apply import'),
    ),
  });

  (async () => {
    try {
      const res = await api('/import', { method: 'POST', body: { filename, content, dryRun: true, ...placement } });
      if (!ref.box.isConnected) return; // a cancelled preview cannot enable Apply on a newer file
      const r = res.result;
      renderReport(host, r, { dryRun: true });
      const applyBtn = ref.box.querySelector('#apply-import');
      applyBtn.disabled = false;
      applyBtn.replaceChildren(icon('check', 15), 'Apply import');
      applyBtn.onclick = async () => {
        applyBtn.disabled = true;
        applyBtn.replaceChildren(spinner(), 'Applying…');
        try {
          const out = await api('/import', { method: 'POST', body: { filename, content, ...placement } });
          if (ref.box.isConnected) ref.close();
          toast('Import complete',
            `${out.result.created} created · ${out.result.updated} updated · ${out.result.protected} protected`,
            'success', 6500);
          document.dispatchEvent(new CustomEvent('rp:data-changed')); // refresh the Directory badge as well as upload history
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
function createDuplicateCard() {
  const body = h('div', { id: 'dup-body', class: 'card-body' });
  const el = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null,
        h('div', { class: 'card-title' }, icon('merge', 15), 'Duplicate review queue'),
        h('div', { class: 'card-sub' }, 'Name-only or contact matches are never auto-merged. An administrator decides.'),
      ),
    ),
    body,
  );
  return { el, load: loadDuplicates };

  async function loadDuplicates() {
    if (!body.isConnected) return;
    if (!state.user?.isAdmin) {
      mount(body, emptyState({
        title: 'Administrator review',
        message: 'Possible duplicates are queued here for an administrator. Your additions are always matched against existing Employee IDs first.',
        iconName: 'shield',
      }));
      return;
    }
    const loading = h('div', { class: 'row muted', role: 'status' }, spinner(), 'Checking for duplicates…');
    mount(body, loading);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const { reviews: rows } = await api('/duplicates?status=pending', { signal: controller.signal });
      if (!loading.isConnected) return; // superseded by navigation, refresh or another read
      if (!Array.isArray(rows)) throw new Error('The server did not return a review list.');
      if (!rows.length) {
        mount(body, emptyState({ title: 'Nothing to review', message: 'No possible duplicates are waiting for a decision.', iconName: 'checkCircle' }));
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
      if (!loading.isConnected) return;
      mount(body, emptyState({
        title: 'Could not load queue', iconName: 'alert',
        message: controller.signal.aborted ? 'The request timed out. Check your connection and retry.'
          : err.status === 0 ? 'Cannot reach the server. Check your connection and retry.' : err.message,
        action: h('button', { class: 'btn', onclick: loadDuplicates }, 'Retry'),
      }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolve(id, action, done) {
    try {
      await api(`/duplicates/${id}/resolve`, { method: 'POST', body: { action } });
      done(action === 'link' ? 'Record linked to the existing employee.' : action === 'create' ? 'Kept as a separate employee.' : 'Flag dismissed.');
      await loadDuplicates();
    } catch (err) {
      toast('Could not resolve', err.message, 'error');
    }
  }
}

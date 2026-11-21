/* =========================================================================
   Dynamic employee data table.
   Columns come from the server per selected category; editable cells post
   individual field changes and reconcile with the returned authoritative row.
   ========================================================================= */
import {
  h, mount, icon, api, state, statusBadge, fmtRelative, fmtDate, spinner,
  emptyState, toast, debounce, fmtNum,
} from '../core.js';
import { createFilterBar } from './filterbar.js';

const STATUS_FIELDS = new Set(['status', 'training_status', 'completion_status', 'billing_status', 'allocation_status']);

export function createTable({ onSelect, onSaved, compact = false, showScope = true, withFilters = true }) {
  const el = h('div', { class: 'card', style: { overflow: 'hidden' } });

  const q = {
    page: 1,
    pageSize: 25,
    sort: 'name',
    dir: 'asc',
    search: '',
    projectId: null,
    subprojectId: null,
    categoryId: null,
    supplierId: null,
    status: '',
    filters: {},
  };

  let data = { rows: [], columns: [], total: 0, totalPages: 1 };
  let loading = false;
  let selectedId = null;
  let controller = null;
  let lastScopeKey = '';
  let facets = [];
  const facetFilters = {};   // key -> [values]
  // §19: supervisors pick a small working set out of the 70-80 imported
  // columns. Choice is remembered per category in localStorage.
  let hiddenCols = new Set(loadHidden());

  function hiddenKey() {
    return `rp.hidden.${state.user?.id || 'anon'}.${q.categoryId || 'all'}`;
  }
  function loadHidden() {
    try {
      return JSON.parse(localStorage.getItem(hiddenKey()) || '[]');
    } catch { return []; }
  }
  function saveHidden() {
    try { localStorage.setItem(hiddenKey(), JSON.stringify([...hiddenCols])); } catch { /* private mode */ }
  }
  function shownColumns() {
    return data.columns.filter((c) => !hiddenCols.has(c.key));
  }

  const filterBar = withFilters
    ? createFilterBar({
      onChange: (next) => {
        for (const k of Object.keys(facetFilters)) delete facetFilters[k];
        for (const [k, vals] of Object.entries(next)) facetFilters[k] = vals;
        q.page = 1;
        load();
      },
      getActive: () => facetFilters,
    })
    : null;

  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search name, ID, supplier, remarks…',
    'aria-label': 'Search employees',
    oninput: debounce((e) => { q.search = e.target.value; q.page = 1; load(); }, 280),
  });

  /**
   * The five value dropdowns. Options come from the facet payload the server
   * already returns, so the lists are the real values in the current scope and
   * the counts are the rows you would get by choosing them.
   */
  const QUICK_FILTERS = [
    { key: 'billing_status', label: 'Billing status', width: '168px' },
    { key: 'bench_category', label: 'Bench category', width: '168px' },
    { key: 'bl_status', label: 'BL status', width: '132px' },
    { key: 'offsite_onsite', label: 'Offsite / Onsite', width: '150px' },
    { key: 'giga_project_name', label: 'Giga project', width: '168px' },
  ];
  const quickSelects = new Map();
  const quickFilterRow = h('div', { class: 'quick-filters' },
    ...QUICK_FILTERS.map((f) => {
      const sel = h('select', {
        class: 'select', style: { width: f.width }, 'aria-label': `Filter by ${f.label}`,
        dataset: { key: f.key },
        onchange: (e) => { setQuick(f.key, e.target.value); },
      }, h('option', { value: '' }, `All ${f.label.toLowerCase()}`));
      quickSelects.set(f.key, sel);
      return sel;
    }),
    h('button', {
      class: 'btn btn-sm btn-ghost', title: 'Clear every filter', onclick: () => clearFilters(),
    }, icon('x', 13), 'Clear'),
  );

  function setQuick(key, value) {
    if (value) facetFilters[key] = [value];
    else delete facetFilters[key];
    if (filterBar) filterBar.setActive(facetFilters);
    q.page = 1;
    load();
  }

  const pageSizeSelect = h('select', {
    class: 'select', style: { width: '96px' }, 'aria-label': 'Rows per page',
    onchange: (e) => { q.pageSize = Number(e.target.value); q.page = 1; load(); },
  }, ...[10, 25, 50, 100].map((n) => h('option', { value: n, selected: n === 25 }, `${n} rows`)));

  const colsBtn = h('button', {
    class: 'btn btn-sm', title: 'Choose visible columns',
    onclick: () => openColumnChooser(),
  }, icon('columns', 14), 'Columns');

  const filterBtn = h('button', {
    class: 'btn btn-sm', title: 'Filter rows by column values',
    onclick: () => openFilterModal(),
  }, icon('filter', 14), 'Filter');

  const exportBtn = h('button', {
    class: 'btn btn-sm', title: 'Export current view to Excel',
    onclick: doExport,
  }, icon('download', 14), 'Export');

  const toolbar = h('div', { class: 'table-toolbar' },
    h('div', { class: 'search-box' }, icon('search', 15), searchInput),
    h('div', { class: 'grow' }),
    filterBtn,
    colsBtn,
    exportBtn,
  );

  const foot = h('div', { class: 'table-foot' });
  const head = h('div', { class: 'card-head' },
    h('div', null,
      h('div', { class: 'card-title' }, 'Employee records', h('span', { class: 'count-pill', id: 'row-count' }, '—')),
      h('div', { class: 'card-sub' }, 'Click any editable cell to update it. Changes save automatically.'),
    ),
  );
  const bodyHost = h('div', { id: 'table-host' });
  const chipsHost = h('div', { class: 'row', style: { padding: '0 14px 10px', gap: '6px', flexWrap: 'wrap', background: 'var(--surface)' } });

  mount(el, head, ...(filterBar ? [filterBar.el] : []), toolbar, quickFilterRow, chipsHost, bodyHost, foot);

  /* ------------------------------------------------------------- loading */
  async function load({ silent = false } = {}) {
    if (controller) controller.abort();
    controller = new AbortController();
    loading = true;
    if (!silent) renderLoading();
    const params = new URLSearchParams();
    params.set('page', q.page);
    params.set('pageSize', q.pageSize);
    params.set('sort', q.sort);
    params.set('dir', q.dir);
    if (q.search) params.set('search', q.search);
    if (q.projectId) params.set('projectId', q.projectId);
    if (q.subprojectId) params.set('subprojectId', q.subprojectId);
    if (q.categoryId) params.set('categoryId', q.categoryId);
    if (q.supplierId) params.set('supplierId', q.supplierId);
    if (q.status) params.set('status', q.status);
    for (const [k, v] of Object.entries(q.filters)) if (v) params.set(k, v);
    for (const [k, vals] of Object.entries(facetFilters)) {
      if (vals && vals.length) params.set(`f_${k}`, vals.join('|'));
    }
    try {
      const res = await api(`/employees?${params}`, { signal: controller.signal });
      data = res;
      // Never blank the dropdowns on a response that lacks facets: that is what
      // left them permanently disabled. Only replace when there is something to
      // show, and keep the last good values otherwise.
      if (Array.isArray(res.facets) && res.facets.length) {
        facets = res.facets;
        if (filterBar) filterBar.setFacets(facets, res.scope?.category?.name || res.scope?.project?.name || '');
      }
      loading = false;
      render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      loading = false;
      mount(bodyHost, h('div', { class: 'card-body' }, emptyState({
        title: 'Could not load records',
        message: err.message,
        iconName: 'alert',
        action: h('button', { class: 'btn btn-primary btn-sm', onclick: () => load() }, 'Try again'),
      })));
      mount(foot);
    }
  }

  function renderLoading() {
    mount(bodyHost, h('div', { style: { padding: '14px' } },
      ...Array.from({ length: 6 }, () => h('div', { class: 'row', style: { padding: '7px 0', gap: '14px' } },
        h('div', { class: 'skeleton', style: { height: '13px', width: `${18 + Math.random() * 12}%` } }),
        h('div', { class: 'skeleton', style: { height: '13px', width: `${14 + Math.random() * 18}%` } }),
        h('div', { class: 'skeleton', style: { height: '13px', width: `${10 + Math.random() * 14}%` } }),
        h('div', { class: 'skeleton', style: { height: '13px', width: `${8 + Math.random() * 10}%` } }),
      )),
    ));
  }

  /* ------------------------------------------------------------- render */
  function render() {
    renderChips();
    renderQuickFilters();
    const countEl = el.querySelector('#row-count');
    if (countEl) countEl.textContent = fmtNum(data.total);

    if (!data.rows.length) {
      mount(bodyHost, emptyState({
        title: hasAnyFilter() ? 'No matching employees' : 'No employees in this selection',
        message: hasAnyFilter()
          ? 'Try a different search term or clear the active filters.'
          : 'Add a person from the CRM panel, or choose a different category in the drill-down.',
        iconName: 'users',
        action: hasAnyFilter()
          ? h('button', { class: 'btn btn-sm', onclick: clearFilters }, 'Clear filters')
          : null,
      }));
      mount(foot);
      return;
    }

    const cols = shownColumns();
    const table = h('table', { class: 'data' });
    const thead = h('thead');
    const tr = h('tr');
    if (showScope && !q.categoryId) {
      tr.appendChild(sortTh('Project', 'project'));
    }
    for (const c of cols) {
      tr.appendChild(sortTh(c.label, c.key, c));
    }
    tr.appendChild(sortTh('Updated', 'updated_at'));
    thead.appendChild(tr);

    const tbody = h('tbody');
    for (const row of data.rows) {
      const trr = h('tr', {
        dataset: { id: String(row.assignmentId) },
        class: row.assignmentId === selectedId ? 'selected' : '',
        onclick: (e) => {
          if (e.target.closest('input, select, textarea, button')) return;
          select(row);
        },
      });
      if (showScope && !q.categoryId) {
        trr.appendChild(h('td', { class: 'cell-muted nowrap' },
          h('div', { style: { fontSize: '12px' } }, row.projectName),
          h('div', { class: 'subtle', style: { fontSize: '11px' } }, row.categoryName),
        ));
      }
      for (const c of cols) {
        const td = h('td');
        td.appendChild(cellFor(row, c));
        trr.appendChild(td);
      }
      trr.appendChild(h('td', { class: 'nowrap cell-muted' },
        h('div', { style: { fontSize: '11.5px' } }, fmtRelative(row.updatedAt)),
        h('div', { class: 'subtle', style: { fontSize: '10.5px' } }, row.updatedBy),
      ));
      tbody.appendChild(trr);
    }

    table.append(thead, tbody);
    mount(bodyHost, h('div', { class: 'table-wrap' }, table));
    renderFoot();
  }

  /**
   * Rebuild each dropdown from the latest facet counts. Labels carry the count
   * so you can see the effect before selecting, and the chosen value is kept
   * even when it is not in the list (e.g. after the data changes).
   */
  function renderQuickFilters() {
    for (const f of QUICK_FILTERS) {
      const sel = quickSelects.get(f.key);
      if (!sel) continue;
      const chosen = (facetFilters[f.key] || [])[0] || '';
      const facet = (facets || []).find((x) => x.key === f.key);
      const values = facet ? facet.values : [];
      const total = facet ? facet.total : 0;
      const opts = [h('option', { value: '' }, `All ${f.label.toLowerCase()} (${fmtNum(total)})`)];
      for (const v of values) {
        opts.push(h('option', { value: v.value, selected: String(v.value) === String(chosen) },
          `${v.value} (${fmtNum(v.count)})`));
      }
      if (chosen && !values.some((v) => String(v.value) === String(chosen))) {
        opts.push(h('option', { value: chosen, selected: true }, `${chosen} (0)`));
      }
      sel.replaceChildren(...opts);
      sel.value = chosen;
      sel.disabled = !facet || !values.length;
      sel.title = sel.disabled
        ? `No ${f.label.toLowerCase()} values in this selection`
        : `${values.length} ${f.label.toLowerCase()} values`;
    }
  }

  function renderChips() {
    const chips = [];
    const add = (label, clear) => chips.push(h('span', { class: 'filter-chip' }, label,
      h('button', { 'aria-label': `Remove ${label}`, onclick: () => { clear(); q.page = 1; load(); } }, icon('x', 11))));
    if (q.search) add(`Search: “${q.search}”`, () => { q.search = ''; searchInput.value = ''; });
    for (const [k, v] of Object.entries(q.filters)) {
      if (!v) continue;
      const col = data.columns.find((c) => c.key === k.slice(2));
      add(`${col ? col.label : k}: ${v}`, () => { delete q.filters[k]; });
    }
    for (const [k, vals] of Object.entries(facetFilters)) {
      if (!vals || !vals.length) continue;
      const facet = (facets || []).find((f) => f.key === k);
      const label = facet ? facet.label : k;
      add(`${label}: ${vals.join(', ')}`, () => { delete facetFilters[k]; if (filterBar) filterBar.setActive(facetFilters); });
    }
    if (chips.length) {
      chips.push(h('button', {
        class: 'btn btn-ghost btn-xs', onclick: clearFilters,
      }, 'Clear all'));
    }
    mount(chipsHost, chips);
    chipsHost.style.display = chips.length ? 'flex' : 'none';
  }

  function hasAnyFilter() {
    return !!(q.search || Object.keys(facetFilters).length || Object.keys(q.filters).length);
  }

  function clearFilters() {
    q.search = '';
    q.status = '';
    q.supplierId = null;
    q.filters = {};
    for (const k of Object.keys(facetFilters)) delete facetFilters[k];
    if (filterBar) filterBar.setActive({});
    q.page = 1;
    searchInput.value = '';
    renderQuickFilters();
    load();
  }

  function renderFoot() {
    const start = (data.page - 1) * data.pageSize + 1;
    const end = Math.min(data.page * data.pageSize, data.total);
    const pages = [];
    const total = data.totalPages;
    const cur = data.page;
    const push = (n) => pages.push(h('button', {
      class: `page-num ${n === cur ? 'active' : ''}`,
      onclick: () => { q.page = n; load(); },
    }, n));
    if (total <= 7) { for (let i = 1; i <= total; i++) push(i); }
    else {
      push(1);
      if (cur > 3) pages.push(h('span', { class: 'subtle', style: { padding: '0 2px' } }, '…'));
      for (let i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) push(i);
      if (cur < total - 2) pages.push(h('span', { class: 'subtle', style: { padding: '0 2px' } }, '…'));
      push(total);
    }
    mount(foot,
      h('div', { class: 'row', style: { gap: '12px' } },
        h('span', null, data.total ? `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(data.total)}` : 'No records'),
        h('div', { class: 'divider-v' }),
        pageSizeSelect,
      ),
      h('div', { class: 'pager' },
        h('button', {
          class: 'btn btn-sm btn-icon', 'aria-label': 'Previous page', disabled: cur === 1,
          onclick: () => { q.page = Math.max(1, cur - 1); load(); },
        }, icon('chevronLeft', 14)),
        ...pages,
        h('button', {
          class: 'btn btn-sm btn-icon', 'aria-label': 'Next page', disabled: cur === total,
          onclick: () => { q.page = Math.min(total, cur + 1); load(); },
        }, icon('chevronRight', 14)),
      ),
    );
  }

  function sortTh(label, key, col) {
    const sorted = q.sort === key;
    const th = h('th', {
      class: `sortable ${sorted ? 'sorted' : ''}`,
      onclick: () => {
        if (q.sort === key) q.dir = q.dir === 'asc' ? 'desc' : 'asc';
        else { q.sort = key; q.dir = 'asc'; }
        q.page = 1;
        load();
      },
      title: col?.help || `Sort by ${label}`,
    },
      label,
      h('span', { class: 'sort-ind' }, icon(sorted ? (q.dir === 'asc' ? 'sortAsc' : 'sortDesc') : 'chevronsUpDown', 11)),
    );
    return th;
  }

  /* ------------------------------------------------------------- cells */
  function cellFor(row, col) {
    const raw = row.values[col.key];

    if (col.key === 'emp_code') {
      return h('span', { class: 'mono', style: { color: 'var(--text-2)' } }, raw || '—');
    }
    if (!col.editable) {
      return staticView(col, raw);
    }
    return editableCell(row, col, raw);
  }

  /** Read-only presentation for a value, styled per column type. */
  function staticView(col, raw) {
    if (col.type === 'select') return statusBadge(raw);
    if (col.type === 'date') return h('span', { class: 'cell-muted nowrap' }, raw ? fmtDate(raw) : '—');
    if (col.key === 'name') return h('span', { class: 'emp-name' }, raw || '—');
    if (col.type === 'textarea') {
      return h('span', {
        class: 'cell-muted',
        style: { display: 'block', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: raw || '',
      }, raw || '—');
    }
    return h('span', { class: 'cell-readonly' }, raw === null || raw === undefined || raw === '' ? '—' : raw);
  }

  /** The click target that turns a cell into an editor, styled to match its type. */
  function displayFor(col, value) {
    if (col.type === 'select') {
      if (!value) return h('span', { class: 'cell-edit is-empty' }, 'Set status…');
      const badge = statusBadge(value);
      badge.classList.add('cell-edit-badge');
      badge.title = `Edit ${col.label}`;
      return badge;
    }
    if (col.type === 'date') {
      return h('span', { class: `cell-edit ${value ? '' : 'is-empty'} nowrap` }, value ? fmtDate(value) : 'Set date…');
    }
    if (col.type === 'textarea') {
      return h('span', {
        class: `cell-edit ${value ? '' : 'is-empty'}`,
        style: { display: 'block', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: value || `Edit ${col.label}`,
      }, value || 'Add remark…');
    }
    return h('span', { class: `cell-edit ${value ? '' : 'is-empty'}` }, value || '—');
  }

  function editableCell(row, col, raw) {
    const value = raw === null || raw === undefined || raw === '' ? null : String(raw);
    const view = displayFor(col, value);
    view.setAttribute('role', 'button');
    view.setAttribute('tabindex', '0');
    view.title = `Edit ${col.label}`;
    view.addEventListener('click', (e) => { e.stopPropagation(); beginEdit(); });
    view.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); beginEdit(); } });

    function beginEdit() {
      const original = rawValue(row, col.key);
      let input;
      if (col.type === 'select') {
        input = h('select', { class: 'cell-input' },
          h('option', { value: '' }, '—'),
          ...(col.options || []).map((o) => h('option', { value: o, selected: String(original ?? '') === o }, o)),
        );
      } else if (col.type === 'date') {
        input = h('input', { class: 'cell-input', type: 'date', value: original || '' });
      } else if (col.type === 'number') {
        input = h('input', { class: 'cell-input', type: 'number', value: original ?? '' });
      } else if (col.type === 'textarea') {
        input = h('input', { class: 'cell-input', type: 'text', value: original ?? '', placeholder: 'Add a remark…' });
      } else {
        input = h('input', {
          class: 'cell-input',
          type: col.type === 'email' ? 'email' : col.type === 'tel' ? 'tel' : 'text',
          value: original ?? '',
        });
      }
      view.replaceWith(input);
      input.focus();
      if (input.select) { try { input.select(); } catch { /* ignore */ } }

      let finished = false;
      const restore = () => { if (!finished) { finished = true; input.replaceWith(view); } };

      const commit = async () => {
        if (finished) return;
        const next = input.value;
        const prev = original ?? '';
        if (String(next ?? '') === String(prev)) { finished = true; input.replaceWith(view); return; }
        finished = true;
        input.disabled = true;
        input.classList.remove('is-error');
        await saveCell(row, col, next, {
          input,
          onError: (msg) => {
            input.classList.add('is-error');
            input.disabled = false;
            finished = false;
            input.title = msg;
            toast('Not saved', msg, 'error');
          },
        });
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); restore(); }
        if (e.key === 'Tab') { commit(); }
      });
      input.addEventListener('change', () => { if (col.type === 'select' || col.type === 'date') commit(); });
    }
    return view;
  }

  function rawValue(row, key) {
    const v = row.values[key];
    return v === null || v === undefined ? '' : String(v);
  }

  /** Optimistic-ish save: show pending state, then reconcile with server truth. */
  async function saveCell(row, col, value, { input, onError }) {
    setRowPending(row.assignmentId, true);
    try {
      const res = await api(`/employees/${row.assignmentId}`, {
        method: 'PATCH',
        body: { changes: { [col.key]: value }, rev: row.rev, reason: 'Inline table edit' },
      });
      applyServerRow(res.record);
      setRowPending(row.assignmentId, false);
      if (res.record.values[col.key] === undefined) {
        toast('Saved', `${col.label} updated.`, 'success', 1800);
      } else {
        const label = res.record.values[col.key];
        toast('Saved', `${col.label} set to ${label === null || label === '' ? 'blank' : label}.`, 'success', 1800);
      }
      if (onSaved) onSaved(res.record);
    } catch (err) {
      setRowPending(row.assignmentId, false);
      if (input) input.remove();
      if (err.status === 409) {
        toast('Update conflict', 'Someone else changed this record. Showing the latest values — please retry.', 'warn', 6000);
        if (err.data?.current) applyServerRow(err.data.current);
      } else if (err.data?.errors) {
        const field = Object.keys(err.data.errors)[0];
        onError?.(err.data.errors[field] || err.message);
        if (err.data.current) applyServerRow(err.data.current, { skipRender: true });
      } else {
        onError?.(err.message);
      }
      render();
    }
  }

  function setRowPending(id, pending) {
    const tr = data.rows.length ? el.querySelector(`tr[data-id="${id}"]`) : null;
    if (!tr) return;
    tr.style.opacity = pending ? '0.62' : '1';
    tr.style.transition = 'opacity .12s';
  }

  function applyServerRow(record) {
    const row = data.rows.find((r) => r.assignmentId === record.assignmentId);
    if (!row) return;
    // keep the column set stable, refresh values + revision stamp
    row.values = { ...row.values, ...record.values };
    row.updatedAt = record.updatedAt;
    row.rev = record.rev || record.updatedAt;
    const tr = el.querySelector(`tr[data-id="${row.assignmentId}"]`);
    if (tr) {
      // rebuild just the value cells for accuracy
      const cells = tr.querySelectorAll('td');
      let idx = (showScope && !q.categoryId) ? 1 : 0;
      for (const c of data.columns) {
        const fresh = cellFor(row, c);
        cells[idx].replaceChildren(fresh);
        idx++;
      }
    }
    if (selectedId === row.assignmentId && onSelect) onSelect(row);
  }

  /* ------------------------------------------------------------- select */
  function select(row) {
    selectedId = row.assignmentId;
    for (const tr of el.querySelectorAll('tbody tr')) tr.classList.toggle('selected', tr.dataset.id === String(selectedId));
    if (onSelect) onSelect(row);
  }

  /* ------------------------------------------------------------- filters */
  async function openFilterModal() {
    const { modal } = await import('../core.js');
    const cols = data.columns.filter((c) => c.type !== 'textarea');
    if (!cols.length) {
      toast('No filters available', 'Select a category first so column filters can be offered.', 'info');
      return;
    }
    const picked = h('select', { class: 'select' },
      h('option', { value: '' }, 'Choose a column'),
      ...cols.map((c) => h('option', { value: c.key }, c.label)));
    const valueHost = h('div', { class: 'field' });
    let activeKey = null;
    let activeField = null;

    const paintValue = () => {
      activeKey = picked.value || null;
      activeField = cols.find((c) => c.key === activeKey);
      if (!activeField) { mount(valueHost); return; }
      const current = q.filters[`f_${activeKey}`] || '';
      const { input } = buildFilterInput(activeField, current);
      mount(valueHost, h('label', { class: 'field-label' }, `Value for ${activeField.label}`), input);
    };
    picked.addEventListener('change', paintValue);
    paintValue();

    function buildFilterInput(col, current) {
      if (col.type === 'select') {
        const sel = h('select', { class: 'select' },
          h('option', { value: '' }, 'Any value'),
          ...(col.options || []).map((o) => h('option', { value: o, selected: o === current }, o)));
        return { input: sel };
      }
      const type = col.type === 'date' ? 'date' : col.type === 'number' ? 'number' : 'text';
      return { input: h('input', { class: 'input', type, value: current, placeholder: 'Exact match' }) };
    }

    modal({
      title: 'Filter rows',
      subtitle: 'Filters combine with search, status and supplier.',
      body: h('div', { class: 'col', style: { gap: '12px' } },
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Column'), picked),
        valueHost,
        Object.keys(q.filters).length
          ? h('div', null,
            h('div', { class: 'crm-section-title' }, 'Active filters'),
            ...Object.entries(q.filters).filter(([, v]) => v).map(([k, v]) =>
              h('div', { class: 'row', style: { fontSize: '12px', padding: '4px 0' } },
                h('span', { class: 'badge badge-neutral' }, k.slice(2)),
                h('span', { class: 'mono' }, v),
                h('button', {
                  class: 'btn btn-ghost btn-xs', style: { marginLeft: 'auto' },
                  onclick: () => { delete q.filters[k]; q.page = 1; load(); document.querySelector('.overlay')?.remove(); },
                }, icon('x', 11), 'Remove'),
              )))
          : null,
      ),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        h('button', { class: 'btn', onclick: () => document.querySelector('.overlay')?.remove() }, 'Close'),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => {
            if (!activeKey) return;
            const input = valueHost.querySelector('input, select');
            const v = input ? input.value : '';
            if (v) q.filters[`f_${activeKey}`] = v; else delete q.filters[`f_${activeKey}`];
            q.page = 1;
            document.querySelector('.overlay')?.remove();
            load();
          },
        }, 'Apply filter'),
      ),
    });
  }

  /* ------------------------------------------------------------- export */
  async function doExport() {
    exportBtn.disabled = true;
    const original = exportBtn.innerHTML;
    exportBtn.replaceChildren(spinner(), 'Generating…');
    try {
      const { downloadExport } = await import('../core.js');
      const res = await downloadExport({
        projectId: q.projectId || '',
        subprojectId: q.subprojectId || '',
        categoryId: q.categoryId || '',
        supplierId: q.supplierId || '',
        // the five dropdowns are value filters, so they travel as f_ params
        ...Object.fromEntries(Object.entries(facetFilters)
          .filter(([, vals]) => vals && vals.length)
          .map(([k, vals]) => [`f_${k}`, vals.join('|')])),
      });
      toast('Export ready', `${res.filename} · ${fmtNum(res.rows)} rows generated from the database.`, 'success', 5000);
    } catch (err) {
      if (err.status === 403) toast('Export not permitted', 'Your role does not allow exports for this scope.', 'error');
      else toast('Export failed', err.message, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.innerHTML = original;
    }
  }

  /* ------------------------------------------------------------- columns */
  async function openColumnChooser() {
    const { modal } = await import('../core.js');
    const all = data.columns.length
      ? data.columns
      : (state.fields || []).map((f) => ({ ...f, key: f.key }));
    if (!all.length) {
      toast('Columns still loading', 'Reload the table and try again.', 'warn');
      return;
    }
    const boxes = new Map();
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search columns…' });
    const list = h('div', { class: 'col', style: { gap: '2px' } });

    const renderList = (term) => {
      const t = term.trim().toLowerCase();
      const rows = all.filter((c) => !t || c.label.toLowerCase().includes(t) || c.key.includes(t));
      mount(list, ...(rows.length ? rows.map((c) => {
        const cb = h('input', {
          type: 'checkbox',
          checked: !hiddenCols.has(c.key),
          onchange: () => { cb.checked ? hiddenCols.delete(c.key) : hiddenCols.add(c.key); },
        });
        boxes.set(c.key, cb);
        return h('label', { class: 'list-item', style: { cursor: 'pointer' } }, cb,
          h('div', { class: 'grow' },
            h('div', { class: 'li-name' }, c.label),
            h('div', { class: 'li-meta' }, [c.key, c.type, c.group].filter(Boolean).join(' · ')),
          ),
          c.submitField ? h('span', { class: 'pill', style: { fontSize: '10px' } }, 'editable') : null,
        );
      }) : [h('div', { class: 'subtle', style: { padding: '10px' } }, 'No columns match.')]));
    };
    renderList('');
    search.addEventListener('input', debounce(() => renderList(search.value), 120));

    const countLabel = h('div', { class: 'subtle', style: { fontSize: '11.5px' } });
    const syncCount = () => {
      countLabel.textContent = `${all.length - hiddenCols.size} of ${all.length} columns visible`;
    };
    syncCount();
    list.addEventListener('change', syncCount);

    const preset = (keys) => {
      hiddenCols = new Set(all.map((c) => c.key).filter((k) => !keys.includes(k)));
      for (const [k, cb] of boxes) cb.checked = !hiddenCols.has(k);
      syncCount();
    };

    modal({
      title: 'Columns to show',
      subtitle: data.scope?.category ? `Category: ${data.scope.category.name}` : 'Your working set',
      size: 'lg',
      body: h('div', null,
        h('div', { class: 'note', style: { marginBottom: '10px' } }, icon('info', 15),
          h('span', null, 'The imported file has 78 columns. Pick the handful you actually use — your choice is remembered on this computer.')),
        h('div', { class: 'row', style: { gap: '6px', marginBottom: '10px', flexWrap: 'wrap' } },
          h('button', { class: 'btn btn-sm', onclick: () => preset(['emp_code', 'name', 'designation', 'bench_category', 'allocation_percentage', 'allocation_start_date', 'allocation_end_date', 'eta_available']) }, 'Bench working set'),
          h('button', { class: 'btn btn-sm', onclick: () => preset(['emp_code', 'name', 'supplier', 'bench_category', 'allocation_plan', 'pid', 'opid', 'eta_available', 'risk_flag']) }, 'Planning set'),
          h('button', { class: 'btn btn-sm', onclick: () => preset(all.map((c) => c.key)) }, 'Show all'),
          h('span', { class: 'grow' }),
          countLabel,
        ),
        search,
        h('div', { class: 'col', style: { gap: '2px', maxHeight: '46vh', overflowY: 'auto', marginTop: '8px' } }, list),
      ),
      footer: h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px', width: '100%' } },
        state.user?.isAdmin && data.scope?.category
          ? h('a', {
            class: 'btn btn-ghost btn-sm',
            href: `#/admin?tab=columns&category=${data.scope.category.id}`,
            onclick: () => document.querySelector('.overlay')?.remove(),
          }, icon('sliders', 14), 'Set defaults for everyone')
          : null,
        h('button', { class: 'btn', onclick: () => document.querySelector('.overlay')?.remove() }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => {
            saveHidden();
            document.querySelector('.overlay')?.remove();
            render();
            toast('Columns updated', `${all.length - hiddenCols.size} columns shown.`, 'success', 2600);
          },
        }, 'Apply'),
      ),
    });
  }

  /* ------------------------------------------------------------- api */
  return {
    el,
    load,
    getState: () => q,
    refresh: () => load({ silent: true }),
    setScope(scope) {
      const key = JSON.stringify(scope);
      q.projectId = scope.projectId || null;
      q.subprojectId = scope.subprojectId || null;
      q.categoryId = scope.categoryId || null;
      if (key !== lastScopeKey) {
        lastScopeKey = key;
        q.page = 1;
        q.filters = {};
        for (const k of Object.keys(facetFilters)) delete facetFilters[k];
        if (filterBar) filterBar.setActive({});
        hiddenCols = new Set(loadHidden());
      }
      return load();
    },
    clearSelection() {
      selectedId = null;
      for (const tr of el.querySelectorAll('tbody tr')) tr.classList.remove('selected');
    },
    selectById(id) {
      const row = data.rows.find((r) => r.assignmentId === Number(id));
      if (row) select(row);
    },
    getRow: (id) => data.rows.find((r) => r.assignmentId === Number(id)),
    getFacets: () => facets,
    selectedId: () => selectedId,
    setFacetFilters(next) {
      for (const k of Object.keys(facetFilters)) delete facetFilters[k];
      for (const [k, vals] of Object.entries(next || {})) facetFilters[k] = vals;
      if (filterBar) filterBar.setActive(facetFilters);
      q.page = 1;
      return load();
    },
    focusSearch() { searchInput.focus(); },
  };
}

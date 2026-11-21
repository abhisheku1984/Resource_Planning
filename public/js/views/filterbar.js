/* =========================================================================
   Facet filter bar — the "space filter" from the brief.
   Renders one chip row per filterable column (bench category first) with counts,
   so a supervisor narrows 12,000 rows to their slice in one click.
   ========================================================================= */
import { h, mount, icon, fmtNum } from '../core.js';

const PRIMARY_KEYS = ['bench_category', 'allocation_status', 'billing_status', 'training_status'];
const MAX_OPEN = 3;

export function createFilterBar({ onChange, getActive }) {
  const el = h('div', { class: 'filterbar' });
  let facets = [];
  let active = {};        // key -> Set(values)
  let expanded = new Set(PRIMARY_KEYS);
  let scopeLabel = '';

  function emit() {
    const plain = {};
    for (const [k, set] of Object.entries(active)) if (set.size) plain[k] = [...set];
    onChange(plain);
  }

  function toggle(key, value) {
    if (!active[key]) active[key] = new Set();
    const set = active[key];
    if (set.has(value)) set.delete(value);
    else set.add(value);
    if (!set.size) delete active[key];
    render();
    emit();
  }

  function clearKey(key) {
    delete active[key];
    render();
    emit();
  }

  function clearAll() {
    active = {};
    render();
    emit();
  }

  function chip(facet, value, count) {
    const on = active[facet.key]?.has(value);
    return h('button', {
      class: `facet-chip ${on ? 'on' : ''}`,
      title: on ? `Remove ${value}` : `Filter by ${value}`,
      onclick: () => toggle(facet.key, value),
    },
      h('span', { class: 'facet-chip-label' }, value || '(blank)'),
      h('span', { class: 'facet-chip-count' }, fmtNum(count)),
    );
  }

  function renderRow(facet) {
    const isOpen = expanded.has(facet.key);
    const chosen = active[facet.key]?.size || 0;
    const values = facet.values || [];
    // always show every selected value, plus the top few when collapsed
    const shown = isOpen
      ? values
      : values.filter((v) => active[facet.key]?.has(v.value) || values.indexOf(v) < 4);
    const hiddenCount = values.length - shown.length;

    return h('div', { class: 'facet-row' },
      h('button', {
        class: `facet-label ${chosen ? 'has-active' : ''}`,
        title: isOpen ? 'Collapse' : 'Show all values',
        onclick: () => {
          if (isOpen) expanded.delete(facet.key);
          else expanded.add(facet.key);
          render();
        },
      },
        icon(isOpen ? 'chevronDown' : 'chevronRight', 12),
        h('span', null, facet.label),
        chosen ? h('span', { class: 'facet-badge' }, chosen) : null,
      ),
      h('div', { class: 'facet-values' },
        ...shown.map((v) => chip(facet, v.value, v.count)),
        hiddenCount > 0
          ? h('button', {
            class: 'facet-more',
            onclick: () => { expanded.add(facet.key); render(); },
          }, `+${hiddenCount} more`)
          : null,
        chosen
          ? h('button', {
            class: 'facet-clear',
            title: `Clear ${facet.label}`,
            onclick: () => clearKey(facet.key),
          }, icon('x', 11))
          : null,
      ),
    );
  }

  function render() {
    if (!facets.length) {
      mount(el);
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const activeCount = Object.values(active).reduce((a, s) => a + s.size, 0);
    const ordered = [...facets].sort((a, b) => {
      const ai = PRIMARY_KEYS.indexOf(a.key);
      const bi = PRIMARY_KEYS.indexOf(b.key);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return 0;
    });
    // only collapse-able rows beyond the first few are hidden by default
    const visibleRows = ordered.slice(0, MAX_OPEN + expanded.size);

    mount(el,
      h('div', { class: 'facet-head' },
        h('div', { class: 'row', style: { gap: '7px', minWidth: '0' } },
          icon('filter', 14),
          h('span', { style: { fontWeight: '650', fontSize: '12.5px' } }, 'Filters'),
          scopeLabel ? h('span', { class: 'facet-scope' }, scopeLabel) : null,
        ),
        h('div', { class: 'row', style: { gap: '6px' } },
          activeCount
            ? h('button', { class: 'btn btn-ghost btn-xs', onclick: clearAll }, icon('x', 12), `Clear ${activeCount}`)
            : null,
          h('span', { class: 'subtle', style: { fontSize: '11.5px' } },
            activeCount ? 'Click a chip again to remove it' : 'Click a value to filter'),
        ),
      ),
      ...visibleRows.map(renderRow),
      ordered.length > visibleRows.length
        ? h('button', {
          class: 'facet-showall',
          onclick: () => { expanded.add('__all__'); ordered.forEach((f) => expanded.add(f.key)); render(); },
        }, icon('chevronDown', 12), `Show ${ordered.length - visibleRows.length} more filters`)
        : null,
    );
  }

  return {
    el,
    setFacets(next, label = '') {
      facets = next || [];
      scopeLabel = label;
      // drop selections for columns that no longer exist in scope
      const keys = new Set(facets.map((f) => f.key));
      let pruned = false;
      for (const k of Object.keys(active)) {
        if (!keys.has(k)) { delete active[k]; pruned = true; }
      }
      render();
      if (pruned) emit();
    },
    setActive(next) {
      active = {};
      for (const [k, vals] of Object.entries(next || {})) {
        if (vals && vals.length) active[k] = new Set(vals);
      }
      render();
    },
    clearAll,
    getActive: () => active,
    hasFilters: () => Object.values(active).some((s) => s.size > 0),
  };
}

/* =========================================================================
   Filter menu — one compact line of dropdowns.
   Each dropdown lists the real values of its column with the number of rows
   you get by choosing it. Nothing is expanded on the page, so the table itself
   stays at the top; open one dropdown, pick a value, the table narrows.
   ========================================================================= */
import { h, mount, icon, fmtNum } from '../core.js';

const MAX_SHOWN = 200;      // a date column can hold thousands of values
const MENU_WIDTH = 258;
// Only the five dimensions the brief allows are on the bar. Everything else the
// server offers (capability, dates, vertical…) is one click behind "More", so
// the row stays readable but no filter value is lost.
const PRIMARY = ['billing_status', 'bench_category', 'bl_status', 'offsite_onsite', 'giga_project_name'];

/** Small debounce so the search box does not refresh on every keystroke. */
function later(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function createFilterBar({ onChange }) {
  const el = h('div', { class: 'filterbar dropdowns' });
  let facets = [];
  let active = {};          // key -> [values]
  let scopeLabel = '';
  let openKey = null;       // which dropdown is open
  let search = {};          // key -> text typed in that dropdown
  let showAll = false;      // reveal the secondary columns

  const buttons = new Map();     // key -> button
  const menu = h('div', { class: 'facet-menu hidden', role: 'menu' });

  const activeCount = () => Object.values(active).reduce((a, v) => a + (v ? v.length : 0), 0);

  function emit() {
    const plain = {};
    for (const [k, vals] of Object.entries(active)) if (vals && vals.length) plain[k] = [...vals];
    onChange(plain);
  }

  function closeMenu() {
    openKey = null;
    menu.classList.add('hidden');
    menu.replaceChildren();
  }

  function setValue(key, value) {
    // "" clears this column; anything else becomes the single selection.
    // Choosing a value always dismisses the menu: leaving it open over the rows
    // hides the very result the click was meant to show.
    if (!value) delete active[key];
    else active[key] = [value];
    closeMenu();
    paint();
    emit();
  }

  function clearKey(key) {
    delete active[key];
    closeMenu();
    paint();
    emit();
  }

  function clearAll() {
    active = {};
    closeMenu();
    paint();
    emit();
  }

  /* ------------------------------------------------------------ the menu */
  function option(facet, value, count) {
    const on = (active[facet.key] || []).some((v) => String(v) === String(value));
    return h('button', {
      class: `facet-option ${on ? 'on' : ''}`,
      role: 'menuitem',
      title: value === '' ? 'Rows with no value' : `Show ${fmtNum(count)} rows`,
      onclick: (e) => { e.stopPropagation(); setValue(facet.key, value); },
    },
      h('span', { class: 'facet-check' }, on ? icon('check', 12) : null),
      h('span', { class: 'facet-option-label' }, value === '' ? '(blank)' : value),
      h('span', { class: 'facet-option-count' }, fmtNum(count)),
    );
  }

  function paintMenu() {
    const facet = facets.find((f) => f.key === openKey);
    if (!facet) { closeMenu(); return; }
    const term = (search[facet.key] || '').toLowerCase();
    const all = facet.values || [];
    const matching = term
      ? all.filter((v) => String(v.value).toLowerCase().includes(term))
      : all;
    const shown = matching.slice(0, MAX_SHOWN);
    const chosen = active[facet.key] || [];
    const total = facet.allCount ?? all.reduce((a, v) => a + v.count, 0);

    const box = h('input', {
      class: 'input facet-search',
      type: 'search',
      value: search[facet.key] || '',
      placeholder: `Find in ${facet.label.toLowerCase()}…`,
      oninput: later((e) => { search[facet.key] = e.target.value; paintMenu(); }, 120),
    });

    const scroll = h('div', { class: 'facet-options' },
      h('button', {
        class: `facet-option ${chosen.length ? '' : 'on'}`,
        role: 'menuitem',
        onclick: (e) => { e.stopPropagation(); setValue(facet.key, ''); },
      },
        h('span', { class: 'facet-check' }, chosen.length ? null : icon('check', 12)),
        h('span', { class: 'facet-option-label' }, 'All'),
        h('span', { class: 'facet-option-count' }, fmtNum(total)),
      ),
      ...shown.map((v) => option(facet, v.value, v.count)),
      !shown.length
        ? h('div', { class: 'facet-empty' }, all.length ? 'No value matches that text.' : 'No values in this selection.')
        : null,
      matching.length > shown.length
        ? h('div', { class: 'facet-empty' }, `Showing the first ${MAX_SHOWN} of ${fmtNum(matching.length)}. Type to narrow.`)
        : null,
    );

    mount(menu,
      h('div', { class: 'facet-menu-head' }, facet.label),
      all.length > 8 ? box : null,
      scroll,
    );
    menu.classList.remove('hidden');

    // sit under its button, kept inside the window
    const btn = buttons.get(facet.key);
    if (btn && btn.getBoundingClientRect) {
      const r = btn.getBoundingClientRect();
      const width = Math.min(MENU_WIDTH, (window.innerWidth || 1024) - 16);
      const left = Math.max(8, Math.min(r.left, (window.innerWidth || 1024) - width - 8));
      menu.style.width = `${width}px`;
      menu.style.left = `${left}px`;
      menu.style.top = `${r.bottom + 4}px`;
    }
    if (box.focus) setTimeout(() => box.focus(), 20);
  }

  function toggleMenu(key) {
    const next = openKey === key ? null : key;
    openKey = next;
    if (openKey) paintMenu();
    else closeMenu();
    paint();
  }

  // click anywhere else closes the menu
  document.addEventListener('mousedown', (e) => {
    if (openKey === null) return;
    if (el.isConnected === false) return;   // this table was replaced by another view
    const t = e.target;
    if (menu.contains(t)) return;
    if (t && t.closest && t.closest('.facet-btn')) return;
    closeMenu();
    paint();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openKey !== null) {
      closeMenu();
      paint();
    }
  });
  window.addEventListener('resize', () => { if (openKey) paintMenu(); });
  // the menu is pinned to the viewport, so any scroll would leave it floating
  // over unrelated rows; close it instead
  window.addEventListener('scroll', () => {
    if (openKey !== null) { closeMenu(); paint(); }
  }, true);

  /* ------------------------------------------------------------ the bar */
  function button(facet) {
    const chosen = active[facet.key] || [];
    const total = (facet.values || []).reduce((a, v) => a + v.count, 0);
    const label = chosen.length ? chosen.join(', ') : 'All';
    const count = chosen.length
      ? (facet.values || [])
        .filter((v) => chosen.some((c) => String(c) === String(v.value)))
        .reduce((a, v) => a + v.count, 0)
      : total;

    return h('button', {
      class: `facet-btn ${chosen.length ? 'on' : ''} ${openKey === facet.key ? 'open' : ''}`,
      title: chosen.length ? `${facet.label}: ${label} — click to change` : `Filter by ${facet.label}`,
      'aria-expanded': openKey === facet.key ? 'true' : 'false',
      onclick: (e) => { e.stopPropagation(); toggleMenu(facet.key); },
    },
      h('span', { class: 'facet-btn-label' }, facet.label),
      h('span', { class: 'facet-btn-value' }, label),
      h('span', { class: 'facet-btn-count' }, fmtNum(count)),
      icon('chevronDown', 12),
    );
  }

  function ordered() {
    const rank = (f) => {
      const i = PRIMARY.indexOf(f.key);
      return i < 0 ? 100 : i;
    };
    const primary = facets.filter((f) => PRIMARY.includes(f.key)).sort((a, b) => rank(a) - rank(b));
    const rest = facets.filter((f) => !PRIMARY.includes(f.key));
    return { primary, rest };
  }

  function paint() {
    const { primary, rest } = ordered();
    const list = showAll ? [...primary, ...rest] : primary;
    const n = activeCount();
    const head = h('div', { class: 'facet-head' },
      h('div', { class: 'row', style: { gap: '7px', minWidth: '0' } },
        icon('filter', 14),
        h('span', { style: { fontWeight: '650', fontSize: '12.5px' } }, 'Filters'),
        scopeLabel ? h('span', { class: 'facet-scope' }, scopeLabel) : null,
      ),
      h('div', { class: 'row', style: { gap: '6px' } },
        n ? h('button', { class: 'btn btn-ghost btn-xs', onclick: clearAll }, icon('x', 12), `Clear ${n}`) : null,
      ),
    );

    buttons.clear();
    const row = h('div', { class: 'facet-btns' },
      ...list.map((f) => {
        const b = button(f);
        buttons.set(f.key, b);
        return b;
      }),
      rest.length
        ? h('button', {
          class: 'btn btn-ghost btn-sm facet-more-btn',
          title: showAll ? 'Hide the other columns' : 'Every other filterable column',
          onclick: () => { showAll = !showAll; paint(); },
        }, icon(showAll ? 'chevronRight' : 'chevronDown', 12),
          showAll ? 'Fewer filters' : `More filters (${rest.length})`)
        : null,
    );

    mount(el, head, row);
    // the menu is a sibling of this bar, not a child, so it has to be dismissed
    // explicitly whenever no dropdown is open
    if (openKey) paintMenu();
    else if (!menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
      menu.replaceChildren();
    }
  }

  return {
    el,
    menu,
    setFacets(next, label = '') {
      facets = next || [];
      scopeLabel = label;
      const keys = new Set(facets.map((f) => f.key));
      let pruned = false;
      for (const k of Object.keys(active)) {
        if (!keys.has(k)) { delete active[k]; pruned = true; }
      }
      paint();
      if (pruned) emit();
    },
    setActive(next) {
      active = {};
      for (const [k, vals] of Object.entries(next || {})) {
        if (vals && vals.length) active[k] = [...vals];
      }
      paint();
    },
    clearAll,
    getActive: () => active,
    hasFilters: () => activeCount() > 0,
    openFor: (key) => toggleMenu(key),
  };
}

/* =========================================================================
   The assistant panel.
   A docked chat on the right of every screen. Totally offline: it calls the
   app's own /api/agent endpoints and nothing else. Anything it wants to change
   becomes a proposal card that an administrator approves or rejects.
   ========================================================================= */
import { h, mount, icon, api, state, toast, spinner, fmtRelative } from '../core.js';

const EXAMPLES = [
  'How many are on bench in NEXUS?',
  'How many are hard block in NEXUS?',
  'Who is on bench in NEXUS?',
];

export function createAssistant() {
  const el = h('div', { class: 'assistant hidden', 'aria-label': 'Assistant' });
  const head = h('div', { class: 'assistant-head' });
  const log = h('div', { class: 'assistant-log' });
  const foot = h('div', { class: 'assistant-foot' });
  const queueHost = h('div', { class: 'assistant-queue' });
  mount(el, head, queueHost, log, foot);

  let open = false;
  let busy = false;
  let proposals = [];

  function renderHead() {
    const pending = proposals.filter((p) => p.status === 'pending').length;
    mount(head,
      h('div', { class: 'row', style: { gap: '8px', minWidth: '0' } },
        h('span', { class: 'assistant-avatar' }, icon('sparkles', 15)),
        h('div', { class: 'col', style: { minWidth: '0' } },
          h('div', { style: { fontWeight: '650', fontSize: '13px' } }, 'Assistant'),
          h('div', { class: 'subtle', style: { fontSize: '11px' } }, 'Works offline · answers from your database'),
        ),
      ),
      h('div', { class: 'row', style: { gap: '4px' } },
        pending && state.user?.isAdmin
          ? h('span', { class: 'pill warn', title: 'Proposals waiting for your approval' }, pending + ' pending')
          : null,
        h('button', {
          class: 'btn btn-ghost btn-icon', title: 'Close', 'aria-label': 'Close assistant',
          onclick: () => toggle(false),
        }, icon('x', 15)),
      ),
    );
  }

  function bubble(role, text) {
    return h('div', { class: 'msg ' + role },
      role === 'agent' ? h('span', { class: 'assistant-avatar sm' }, icon('sparkles', 12)) : null,
      h('div', { class: 'msg-body' }, text),
    );
  }

  function dataTable(table) {
    if (!table) return null;
    return h('div', { class: 'msg-table' },
      h('div', { class: 'msg-table-title' }, table.title),
      h('div', { style: { maxHeight: '190px', overflow: 'auto' } },
        h('table', { class: 'mini' },
          h('thead', null, h('tr', null, ...table.columns.map((c) => h('th', null, c)))),
          h('tbody', null, ...table.rows.map((r) => h('tr', null, ...r.map((cell) => h('td', null, String(cell)))))),
        ),
      ),
    );
  }

  function proposalCard(p) {
    const rows = Object.entries(p.after || {}).map(([key, to]) => ({
      key,
      from: p.before ? p.before[key] : null,
      to,
    }));
    const statusClass = p.status === 'pending' ? 'warn' : p.status === 'approved' ? 'ok' : 'danger';
    return h('div', { class: 'proposal' },
      h('div', { class: 'proposal-head' },
        h('span', { class: 'pill ' + statusClass }, p.status),
        h('span', { class: 'subtle', style: { fontSize: '11px' } }, '#' + p.id + ' · ' + p.requestedBy),
      ),
      h('div', { class: 'proposal-summary' }, p.summary),
      h('div', { class: 'col', style: { gap: '3px', marginTop: '6px' } },
        ...rows.map((r) => h('div', { class: 'proposal-change' },
          h('span', { class: 'proposal-from' }, r.from === null || r.from === '' ? '(empty)' : r.from),
          h('span', { class: 'proposal-arrow' }, '→'),
          h('span', { class: 'proposal-to' }, r.to),
        )),
      ),
      p.status === 'pending' && state.user?.isAdmin
        ? h('div', { class: 'row', style: { gap: '6px', marginTop: '9px' } },
          h('button', { class: 'btn btn-primary btn-sm', onclick: () => decide(p.id, 'approve') },
            icon('check', 13), 'Approve & save'),
          h('button', { class: 'btn btn-sm', onclick: () => decide(p.id, 'reject') }, 'Reject'),
        )
        : null,
      p.status === 'pending' && !state.user?.isAdmin
        ? h('div', { class: 'subtle', style: { fontSize: '11px', marginTop: '7px' } },
          'Waiting for an administrator to approve.')
        : null,
      p.decidedBy
        ? h('div', { class: 'subtle', style: { fontSize: '11px', marginTop: '6px' } },
          p.status + ' by ' + p.decidedBy + (p.decidedAt ? ' · ' + fmtRelative(p.decidedAt) : ''))
        : null,
    );
  }

  async function decide(id, action) {
    const box = queueHost;
    try {
      const res = await api('/agent/proposals/' + id + '/' + action, { method: 'POST', body: {} });
      toast(action === 'approve' ? 'Approved and saved' : 'Rejected',
        res.message || '', action === 'approve' ? 'success' : 'info', 4200);
      if (action === 'approve' && res.proposal) {
        mount(box, proposalCard(res.proposal), ...proposals.filter((p) => p.id !== id && p.status === 'pending').map(proposalCard));
      }
      await refreshQueue();
      // the table behind the panel should show the new value straight away
      document.dispatchEvent(new CustomEvent('rp:data-changed'));
    } catch (err) {
      toast('Not applied', err.message, 'error', 6000);
      await refreshQueue();
    }
  }

  async function refreshQueue() {
    if (!state.user) return;
    try {
      const res = await api('/agent/proposals');
      proposals = res.proposals || [];
      const pending = proposals.filter((p) => p.status === 'pending' && state.user.isAdmin);
      mount(queueHost, ...pending.slice(0, 4).map(proposalCard));
      renderHead();
    } catch { /* the assistant must never block the page */ }
  }

  async function send(text) {
    const message = String(text || '').trim();
    if (!message || busy) return;
    busy = true;
    mount(log, ...log.children, bubble('user', message));
    const thinking = h('div', { class: 'msg agent' },
      h('span', { class: 'assistant-avatar sm' }, icon('sparkles', 12)),
      h('div', { class: 'msg-body' }, spinner(), ' Checking the database…'),
    );
    log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;
    try {
      const res = await api('/agent/ask', { method: 'POST', body: { message } });
      thinking.remove();
      log.appendChild(bubble('agent', res.reply));
      const t = dataTable(res.table);
      if (t) log.appendChild(h('div', { class: 'msg agent' }, h('span', { class: 'assistant-avatar sm' }, icon('sparkles', 12)), h('div', { class: 'msg-body wide' }, t)));
      if (res.proposal) {
        log.appendChild(h('div', { class: 'msg agent' }, h('span', { class: 'assistant-avatar sm' }, icon('sparkles', 12)),
          h('div', { class: 'msg-body wide' }, proposalCard(res.proposal))));
        await refreshQueue();
      }
      if (res.suggestions && res.suggestions.length) {
        log.appendChild(h('div', { class: 'msg agent suggestions' },
          ...res.suggestions.map((s) => h('button', { class: 'chip', onclick: () => send(s) }, s))));
      }
      log.scrollTop = log.scrollHeight;
    } catch (err) {
      thinking.remove();
      log.appendChild(bubble('agent', 'I could not reach the server: ' + err.message));
    } finally {
      busy = false;
    }
  }

  function renderFoot() {
    const input = h('textarea', {
      class: 'assistant-input', rows: 1, placeholder: 'Ask a question, or say "set EMP-10001 to hard block"',
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); input.value = ''; }
      },
    });
    mount(foot,
      input,
      h('button', { class: 'btn btn-primary btn-icon', title: 'Send', onclick: () => { send(input.value); input.value = ''; } }, icon('arrowRight', 15)),
    );
    return input;
  }

  function seed() {
    mount(log,
      bubble('agent', 'Hello. I answer only from this database, and I only see the projects you are allowed to see. Ask me a count, or ask me to change a record — changes wait for approval.'),
      h('div', { class: 'msg agent suggestions' },
        ...EXAMPLES.map((s) => h('button', { class: 'chip', onclick: () => send(s) }, s))),
    );
  }

  function toggle(next) {
    open = next === undefined ? !open : next;
    el.classList.toggle('hidden', !open);
    document.body.classList.toggle('assistant-open', open);
    document.querySelectorAll('.assistant-launch').forEach((b) => b.classList.toggle('active', open));
    if (open) {
      if (!log.children.length) seed();
      renderFoot();
      refreshQueue();
      el.querySelector('.assistant-input')?.focus();
    }
  }

  renderHead();
  renderFoot();
  window.addEventListener('rp:assistant', () => toggle());
  document.addEventListener('rp:logout', () => { open = false; el.classList.add('hidden'); document.body.classList.remove('assistant-open'); });

  return { el, toggle, open: () => toggle(true), isOpen: () => open, refreshQueue };
}

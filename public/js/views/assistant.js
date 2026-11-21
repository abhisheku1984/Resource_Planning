/* =========================================================================
   The assistant panel.
   Project-scoped reporting and proposals, plus an explicitly opened CRM form.
   All app requests are same-origin; recognition and read-back are on-device.
   ========================================================================= */
import { h, mount, icon, api, state, toast, fmtRelative } from '../core.js';

import { createLocalVoice } from '../voice.js';
import { createAssistantCrm } from './assistant-crm.js';

const EXAMPLES = ['How many are on bench?', 'Break down bench category', 'Who is on bench?', 'Open CRM'];

export function createAssistant() {
  const el = h('div', { class: 'assistant hidden', 'aria-label': 'Assistant' });
  const head = h('div', { class: 'assistant-head' });
  const log = h('div', { class: 'assistant-log' });
  const foot = h('div', { class: 'assistant-foot' });
  const queueHost = h('div', { class: 'assistant-queue' });
  const scopeHost = h('div', { class: 'assistant-scope' });
  const crmHost = h('section', { class: 'assistant-crm', 'aria-label': 'Employee CRM form' });
  const voiceText = h('span', { class: 'subtle', role: 'status' }, 'On-device English · no audio uploaded');
  const voiceBtn = h('button', { class: 'btn btn-sm', 'aria-pressed': 'false', onclick: () => voice.toggle() }, 'Start voice mode');
  const voice = createLocalVoice({ onCommand: send, onState({ text, active, needsPack }) {
    voiceText.textContent = text; voiceBtn.textContent = needsPack ? 'Install English speech pack' : active ? 'Stop voice' : 'Start voice mode';
    voiceBtn.setAttribute('aria-pressed', String(active));
  } });
  const crm = createAssistantCrm(crmHost, send);
  mount(el, head, scopeHost, queueHost, crmHost, log, h('div', { class: 'assistant-voice' }, voiceBtn, voiceText), foot);

  let open = false;
  let busy = false;
  let proposals = [], names = [], selected = null;
  let epoch = 0, pendingQuestion = '', waitingPerson = false;

  function renderHead() {
    const pending = proposals.filter((p) => p.status === 'pending').length;
    mount(head,
      h('div', { class: 'row', style: { gap: '8px', minWidth: '0' } },
        h('span', { class: 'assistant-avatar' }, icon('sparkles', 15)),
        h('div', { class: 'col', style: { minWidth: '0' } },
          h('div', { style: { fontWeight: '650', fontSize: '13px' } }, 'Assistant'),
          h('div', { class: 'subtle', style: { fontSize: '11px' } }, 'Workbook projects · local database'),
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
    try {
      const res = await api('/agent/proposals/' + id + '/' + action, { method: 'POST', body: {} });
      toast(action === 'approve' ? 'Approved and saved' : 'Rejected',
        res.message || '', action === 'approve' ? 'success' : 'info', 4200);
      await refreshQueue();
      // the table behind the panel should show the new value straight away
      document.dispatchEvent(new CustomEvent('rp:data-changed'));
    } catch (err) {
      toast('Not applied', err.message, 'error', 6000);
      await refreshQueue();
    }
  }

  async function refreshQueue() {
    const project = selected, id = epoch;
    if (!open || !state.user?.isAdmin || !project) return;
    try {
      const res = await api('/agent/proposals?status=pending&projectName=' + encodeURIComponent(project));
      if (id !== epoch || selected !== project) return;
      proposals = res.proposals || [];
      mount(queueHost, ...proposals.slice(0, 4).map(proposalCard)); renderHead();
    } catch { /* reporting doesn't depend on the approval queue */ }
  }

  function setProject(name) {
    if (selected !== name) {
      selected = name; waitingPerson = false; proposals = []; mount(queueHost); renderHead(); refreshQueue();
    }
    renderScope();
  }
  function renderScope() {
    const picker = h('select', { class: 'select', 'aria-label': 'Giga Project Name', disabled: busy || crm.isOpen(),
      onchange: (e) => {
        setProject(e.target.value || null);
        if (pendingQuestion && selected) { const ask = pendingQuestion; pendingQuestion = ''; send(ask); }
      },
    }, h('option', { value: '' }, 'Say or select a project'), ...names.map((name) => h('option', { value: name }, name)));
    picker.value = selected || '';
    mount(scopeHost, h('label', null, h('span', { class: 'field-label' }, 'Giga Project Name'), picker));
  }
  async function refreshProjects() {
    const id = epoch;
    try {
      const res = await api('/agent/projects');
      if (id !== epoch) return;
      names = res.projectNames;
      if (selected && !names.includes(selected)) { crm.clear(); pendingQuestion = ''; }
      setProject(names.includes(selected) ? selected : names.length === 1 ? names[0] : null);
    } catch { /* a typed project is still verified by /ask */ }
  }

  function addSuggestions(items) {
    if (items?.length) log.appendChild(h('div', { class: 'msg agent suggestions' },
      ...items.map((s) => h('button', { class: 'chip', onclick: () => send(s) }, s))));
  }
  const ask = (message, projectName) => api('/agent/ask', { method: 'POST', body: { message, projectName } });
  async function send(text) {
    const message = String(text || '').trim();
    if (!message || !open || busy) return '';
    const id = epoch;
    busy = true; renderScope(); log.appendChild(bubble('user', message));
    const thinking = bubble('agent', 'Checking…'); log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;
    try {
      if (crm.isOpen()) {
        const reply = await crm.command(message);
        if (id !== epoch) return '';
        log.appendChild(bubble('agent', reply));
        if (crm.reviewReady()) addSuggestions(['Confirm save', 'Discard changes']);
        return reply;
      }
      const lookup = waitingPerson && !/^(open|show|select|switch|use|how|who|list|count|break|set)\b/i.test(message);
      let res = await ask(lookup ? 'Open CRM for ' + message : message, selected);
      if (id !== epoch) return '';
      if (res.kind === 'project' && pendingQuestion) {
        res = await ask(pendingQuestion, res.projectName);
        if (id !== epoch) return '';
      }
      pendingQuestion = res.kind === 'choose_project' ? message : '';
      if (res.projectName) {
        if (!names.includes(res.projectName)) names.push(res.projectName);
        setProject(res.projectName);
      } else if (res.kind === 'denied') { setProject(null); refreshProjects(); }
      waitingPerson = res.kind === 'crm_lookup';
      if (res.crm) crm.show(res.crm);
      log.appendChild(bubble('agent', res.reply));
      const t = dataTable(res.table);
      if (t) log.appendChild(h('div', { class: 'msg agent' }, h('div', { class: 'msg-body wide' }, t)));
      if (res.proposal) {
        log.appendChild(h('div', { class: 'msg agent' }, h('div', { class: 'msg-body wide' }, proposalCard(res.proposal))));
        await refreshQueue();
      }
      if (!crm.isOpen() && !waitingPerson) addSuggestions(res.suggestions);
      const readTable = res.kind === 'list' || res.kind === 'crm_lookup' || res.kind === 'breakdown';
      return res.reply + (readTable && res.table?.rows?.length ? ' ' + res.table.rows.slice(0, 8).map((r) => r.join(', ')).join('; ') : '');
    } catch (err) {
      if (id !== epoch) return '';
      const reply = 'Request not completed. ' + err.message;
      log.appendChild(bubble('agent', reply)); return reply;
    } finally {
      thinking.remove();
      if (id === epoch) { busy = false; renderScope(); log.scrollTop = log.scrollHeight; }
    }
  }

  function renderFoot() {
    const submit = () => { if (!busy && input.value.trim()) { send(input.value); input.value = ''; } };
    const input = h('textarea', { class: 'assistant-input', rows: 1, 'aria-label': 'Ask or enter a CRM command',
      placeholder: 'Ask about a project or say “open CRM”',
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } },
    });
    mount(foot, input, h('button', { class: 'btn btn-primary btn-icon', 'aria-label': 'Send message', onclick: submit }, icon('arrowRight', 15)));
  }
  function seed() {
    mount(log, bubble('agent', 'Name the workbook project you want to ask about. I can report on its people or open CRM for an employee. In voice mode, say “open CRM”, dictate fields, then review and confirm before saving.'));
    addSuggestions(EXAMPLES);
  }
  function toggle(next) {
    open = next === undefined ? !open : next;
    el.classList.toggle('hidden', !open); document.body.classList.toggle('assistant-open', open);
    document.querySelectorAll('.assistant-launch').forEach((b) => b.classList.toggle('active', open));
    if (open) {
      if (!log.children.length) seed();
      renderFoot(); refreshProjects(); refreshQueue(); el.querySelector('.assistant-input')?.focus();
    } else {
      epoch++; busy = false; voice.stop(); waitingPerson = false; pendingQuestion = '';
    }
  }
  renderHead(); renderScope(); renderFoot();
  const launch = () => toggle();
  const suspend = () => { if (voice.isActive()) voice.stop(); };
  const visibility = () => { if (document.hidden) suspend(); };
  document.addEventListener('rp:assistant', launch);
  window.addEventListener('pagehide', suspend);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('rp:logout', () => {
    toggle(false); crm.clear(); mount(log); mount(queueHost); names = []; selected = null;
    document.removeEventListener('rp:assistant', launch);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', suspend);
  }, { once: true });
  return { el, toggle, open: () => toggle(true), isOpen: () => open, refreshQueue };
}

/* =========================================================================
   The assistant panel.
   Project-scoped reporting and proposals, plus an explicitly opened CRM form.
   Text conversations in English or Hindi; all requests are same-origin.
   ========================================================================= */
import { h, mount, icon, api, state, toast, fmtRelative } from '../core.js';
import { createAssistantCrm } from './assistant-crm.js';

const LANGUAGE_KEY = 'rp.askLanguage';

export function createAssistant() {
  let language = localStorage.getItem(LANGUAGE_KEY) === 'hi' ? 'hi' : 'en';
  const t = (en, hi) => language === 'hi' ? hi : en;
  const el = h('div', { class: 'assistant hidden', 'aria-label': 'Assistant', lang: language });
  const head = h('div', { class: 'assistant-head' });
  const log = h('div', { class: 'assistant-log' });
  const foot = h('div', { class: 'assistant-foot' });
  const queueHost = h('div', { class: 'assistant-queue' });
  const scopeHost = h('div', { class: 'assistant-scope' });
  const crmHost = h('section', { class: 'assistant-crm', 'aria-label': 'Employee CRM form' });
  let suggestions = null, hasTurns = false;
  const langTitle = 'Chat language / भाषा';
  const languageButtons = ['en', 'hi'].map((lang) => h('button', { type: 'button', class: 'btn btn-xs', lang,
    onclick: () => changeLanguage(lang) }, lang === 'hi' ? 'हिन्दी' : 'English'));
  const languageBar = h('div', { class: 'assistant-language', role: 'group', 'aria-label': langTitle },
    h('span', { class: 'field-label' }, langTitle), ...languageButtons);
  const crm = createAssistantCrm(crmHost, send, () => language, () => addSuggestions(crm.suggestions()));
  mount(el, head, scopeHost, queueHost, crmHost, log, languageBar, foot);

  let open = false, busy = false;
  let proposals = [], names = [], selected = null;
  let pendingGuide = null, lastReport = null;
  let epoch = 0, pendingQuestion = '', pendingAmbiguous = false, waitingPerson = false;

  function changeLanguage(next) {
    if (next === language || crm.isSaving()) return;
    ++epoch; busy = waitingPerson = pendingAmbiguous = false; pendingQuestion = ''; pendingGuide = lastReport = null;
    language = next; localStorage.setItem(LANGUAGE_KEY, next); el.setAttribute('lang', next);
    crm.changeLanguage(); renderHead(); renderScope(); renderFoot();
    if (!hasTurns) seed();
    else if (crm.isOpen()) {
      log.appendChild(bubble('agent', t('CRM is still open. Type “list fields” or “review changes”.', 'CRM खुला है। “फ़ील्ड बताएं” या “बदलाव की समीक्षा करें” लिखें।')));
      addSuggestions(t(['List fields', 'Review changes'], ['फ़ील्ड बताएं', 'बदलाव की समीक्षा करें']));
    } else addSuggestions(examples());
    log.scrollTop = log.scrollHeight; refreshProjects(); refreshQueue();
  }

  function renderHead() {
    languageButtons.forEach((b) => b.setAttribute('aria-pressed', String(language === b.getAttribute('lang'))));
    const pending = proposals.filter((p) => p.status === 'pending').length;
    mount(head,
      h('div', { class: 'row', style: { gap: '8px', minWidth: '0' } },
        h('span', { class: 'assistant-avatar' }, icon('sparkles', 15)),
        h('div', { class: 'col', style: { minWidth: '0' } },
          h('div', { style: { fontWeight: '650', fontSize: '13px' } }, t('Assistant', 'सहायक')),
          h('div', { class: 'subtle', style: { fontSize: '11px' } }, t('Workbook projects · local database', 'वर्कबुक प्रोजेक्ट · स्थानीय डेटाबेस')),
        ),
      ),
      h('div', { class: 'row', style: { gap: '4px' } },
        pending && state.user?.isAdmin
          ? h('span', { class: 'pill warn', title: 'Proposals waiting for your approval' }, pending + ' pending')
          : null,
        h('button', {
          class: 'btn btn-ghost btn-icon', title: 'Close', 'aria-label': t('Close assistant', 'सहायक बंद करें'),
          onclick: () => toggle(false),
        }, icon('x', 15)),
      ),
    );
  }

  function bubble(role, text) {
    return h('div', { class: 'msg ' + role, lang: language },
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
      selected = name; waitingPerson = false; pendingGuide = lastReport = null; proposals = []; mount(queueHost); renderHead(); refreshQueue();
    }
    renderScope();
  }
  function renderScope() {
    languageButtons.forEach((b) => { b.disabled = busy && crm.isOpen(); });
    const picker = h('select', { class: 'select', 'aria-label': t('Giga Project Name', 'गीगा प्रोजेक्ट का नाम'), disabled: busy || crm.isOpen(),
      onchange: (e) => {
        setProject(e.target.value || null);
        if (pendingQuestion && selected) { const ask = pendingQuestion; pendingQuestion = ''; send(ask, pendingAmbiguous); }
      },
    }, h('option', { value: '' }, t('Type or select a project', 'प्रोजेक्ट का नाम लिखें या चुनें')), ...names.map((name) => h('option', { value: name }, name)));
    picker.value = selected || '';
    mount(scopeHost, h('label', null, h('span', { class: 'field-label' }, t('Giga Project Name', 'गीगा प्रोजेक्ट का नाम')), picker));
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
    suggestions?.remove(); suggestions = null;
    if (items?.length) {
      suggestions = h('div', { class: 'msg agent suggestions', lang: language }, ...items.map((s) => h('button', { class: 'chip', onclick: () => send(s) }, s)));
      log.appendChild(suggestions);
    }
  }
  const ask = (message, projectName, guideChoice, picked) => api('/agent/ask', { method: 'POST',
    body: { message, projectName, language, ...(guideChoice && { guideChoice }), ...(picked && { projectPicked: true }) } });
  const newRequest = (msg) => names.includes(msg) || /^(?:open|show|select|switch|use|how|who|list|count|break|set|change|for|in|update|edit|help|please|can you|add|record)\b/i.test(msg) ||
    /(?:कितने|कितनी|कौन|विवरण|सूची|चुनें|खोलें|खोलो|खोलिए|अपडेट करें|दर्ज करें|बदलें)/u.test(msg);
  function localReply(reply, items = []) {
    log.appendChild(bubble('agent', reply)); addSuggestions(items);
  }
  async function send(text, picked = false) {
    const message = String(text || '').trim();
    if (!message || !open || busy || crm.isSaving()) return;
    const id = epoch;
    hasTurns = true; busy = true; addSuggestions([]); renderScope(); log.appendChild(bubble('user', message));
    const thinking = bubble('agent', t('Checking…', 'जाँच जारी है…')); log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;
    try {
      if (crm.isOpen()) {
        const reply = await crm.command(message);
        if (id !== epoch) return;
        log.appendChild(bubble('agent', reply));
        addSuggestions(crm.isOpen() ? crm.suggestions() : examples());
        return;
      }
      let original = message, choice;
      if ((pendingGuide || pendingQuestion || waitingPerson) && /^(?:cancel|never mind|discard changes|रद्द करें|बदलाव रद्द करें)[.!।]?$/iu.test(message)) {
        pendingGuide = null; pendingQuestion = ''; waitingPerson = false;
        return localReply(t('Update cancelled. No record was changed.', 'अनुरोध रद्द हुआ। कोई रिकॉर्ड नहीं बदला।'), examples());
      }
      if (pendingGuide && pendingGuide.projectName === selected && !newRequest(message)) {
        original = pendingGuide.message;
        if (pendingGuide.step === 'placement') {
          const match = message.replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)))
            .match(/^(?:(?:placement|प्लेसमेंट)\s*#?\s*)?(\d+)[.!।]?$/iu);
          const ordinal = [['first', 'पहला', 'पहली'], ['second', 'दूसरा', 'दूसरी'], ['third', 'तीसरा', 'तीसरी']]
            .findIndex((terms) => terms.includes(message.toLowerCase().replace(/^the | one$| वाला$/g, '').trim()));
          const placementId = match ? Number(match[1]) : pendingGuide.ids[ordinal];
          if (!pendingGuide.ids.includes(placementId)) return localReply(
            t('Choose one of the offered placement numbers, or cancel.', 'दिखाए गए प्लेसमेंट नंबरों में से एक चुनें या रद्द करें।'), pendingGuide.suggestions);
          choice = { person: pendingGuide.person, placementId };
        } else choice = { person: message };
      } else if (waitingPerson && !newRequest(message)) original = t('Open CRM for ' + message, message + ' का सीआरएम खोलें');
      else if (lastReport?.project === selected && /^(?:who are they|show (?:me )?their names|list them|उनके नाम (?:बताएं|दिखाएं))[?.!।]*$/iu.test(message)) {
        // A follow-up is a fresh authorized query, not a replay of cached rows.
        original = 'List people' + (lastReport.value ? ' ' + (lastReport.field === 'bl_status' ? '' : lastReport.field.replaceAll('_', ' ') + ' ') + lastReport.value : '');
      }
      const choosing = !!pendingQuestion && (!newRequest(message) || names.includes(message) || /^(?:select|switch to|use)\s|चुनें[।!]?$/iu.test(message));
      if (choosing && !newRequest(message)) original = t('Select ' + message, message + ' चुनें');
      pendingGuide = lastReport = null;
      let res = await ask(original, selected, choice, picked);
      if (id !== epoch) return;
      if (res.kind === 'project' && pendingQuestion) {
        original = pendingQuestion; pendingQuestion = ''; res = await ask(original, res.projectName, null, pendingAmbiguous);
        if (id !== epoch) return;
      }
      const retryProject = choosing && pendingQuestion && ['choose_project', 'denied'].includes(res.kind);
      if (!retryProject) pendingQuestion = res.kind === 'choose_project' ? original : '';
      pendingAmbiguous = !!res.ambiguousProject || !!(retryProject && pendingAmbiguous);
      if (res.projectName) {
        if (!names.includes(res.projectName)) names.push(res.projectName);
        setProject(res.projectName);
      } else if (res.kind === 'denied') { setProject(null); refreshProjects(); }
      waitingPerson = res.kind === 'crm_lookup' && !res.guide;
      if (['person', 'placement'].includes(res.guide?.step)) {
        pendingGuide = { ...res.guide, message: original, projectName: res.projectName,
          ids: (res.table?.rows || []).map((r) => r[0]), suggestions: res.suggestions };
      }
      if (res.crm) {
        const next = await crm.show(res.crm, res.guide);
        if (id !== epoch) return;
        if (next) res.reply = crm.isReviewed() || !crm.isOpen() ? next : res.reply + ' ' + next;
      }
      log.appendChild(bubble('agent', res.reply));
      if (['count', 'list', 'breakdown'].includes(res.kind) && res.data?.project) {
        if (res.kind !== 'breakdown') lastReport = res.data;
        log.appendChild(h('div', { class: 'ask-source' }, t('Source: workbook placements', 'स्रोत: वर्कबुक प्लेसमेंट'), ' · ', res.data.project,
          ' · ', t('distinct people', 'अलग-अलग कर्मचारी')));
      }
      if (res.kind === 'howto') log.appendChild(h('div', { class: 'ask-source' }, t('Source: app guide', 'स्रोत: ऐप सहायता'), ' · ', res.source));
      const table = dataTable(res.table);
      if (table) log.appendChild(h('div', { class: 'msg agent' }, h('div', { class: 'msg-body wide' }, table)));
      if (res.proposal) {
        log.appendChild(h('div', { class: 'msg agent' }, h('div', { class: 'msg-body wide' }, proposalCard(res.proposal))));
        await refreshQueue();
        if (id !== epoch) return;
      }
      if (crm.isOpen()) addSuggestions(crm.suggestions());
      else if (!waitingPerson) addSuggestions([...(res.kind === 'count' && res.data ? [t('Show their names', 'उनके नाम दिखाएं')] : []),
        ...(res.suggestions || []), ...(pendingGuide || pendingQuestion ? [t('Cancel', 'रद्द करें')]
          : ['count', 'list', 'breakdown', 'help', 'project'].includes(res.kind) ? [t('Update an employee', 'कर्मचारी अपडेट करें')] : [])]);
    } catch (err) {
      if (id !== epoch) return;
      const reply = t('Request not completed. ', 'अनुरोध पूरा नहीं हुआ। ') + err.message;
      log.appendChild(bubble('agent', reply));
    } finally {
      thinking.remove();
      if (id === epoch) { busy = false; renderScope(); log.scrollTop = log.scrollHeight; }
    }
  }

  function renderFoot() {
    const submit = () => { if (open && !busy && !crm.isSaving() && input.value.trim()) { send(input.value); input.value = ''; } };
    const input = h('textarea', { class: 'assistant-input', rows: 1, lang: language, 'aria-label': t('Ask or enter a CRM command', 'सवाल या CRM निर्देश लिखें'),
      placeholder: t('Ask a question or describe an employee update', 'प्रोजेक्ट पर सवाल पूछें या कर्मचारी में बदलाव बताएं'),
      // Enter can accept a Hindi IME composition without sending the message.
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } },
    });
    input.value = foot.querySelector('.assistant-input')?.value || '';
    mount(foot, input, h('button', { class: 'btn btn-primary btn-icon', 'aria-label': t('Send message', 'संदेश भेजें'), onclick: submit }, icon('arrowRight', 15)));
  }
  function examples() {
    return t(['Update an employee', 'How many are on bench?', 'Break down bench category', 'Who is on bench?', 'What can you do?', 'Open CRM'],
      ['कर्मचारी अपडेट करें', 'बेंच पर कितने लोग हैं?', 'बेंच श्रेणी का विवरण दिखाएँ', 'बेंच पर कौन है?', 'मदद', 'सीआरएम खोलें']);
  }
  function seed() {
    mount(log, bubble('agent', t('Choose a workbook project. Ask about its people, or tell me what to update: “Update the interview note for” followed by an employee ID. I’ll ask for anything missing and show the changes before saving.',
      'वर्कबुक का प्रोजेक्ट चुनें। कर्मचारियों के बारे में पूछें या “कर्मचारी अपडेट करें” लिखें। मैं ज़रूरी जानकारी पूछूँगा और सहेजने से पहले बदलाव दिखाऊँगा।')));
    addSuggestions(examples());
  }
  function toggle(next) {
    open = next === undefined ? !open : next;
    el.classList.toggle('hidden', !open); document.body.classList.toggle('assistant-open', open);
    document.querySelectorAll('.assistant-launch').forEach((b) => b.classList.toggle('active', open));
    if (open) {
      if (!log.children.length) seed();
      else if (crm.isOpen()) addSuggestions(crm.suggestions());
      renderFoot(); refreshProjects(); refreshQueue(); el.querySelector('.assistant-input')?.focus();
    } else suspend();
  }
  renderHead(); renderScope(); renderFoot();
  const launch = () => toggle();
  // Closing Ask or hiding the tab still invalidates a pending reply/review.
  function suspend() {
    ++epoch; busy = waitingPerson = pendingAmbiguous = false;
    pendingGuide = lastReport = null; pendingQuestion = ''; crm.suspend(); renderScope();
  }
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

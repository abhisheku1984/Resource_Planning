/* =========================================================================
   The assistant panel.
   Project-scoped reporting and proposals, plus an explicitly opened CRM form.
   All app requests are same-origin; recognition and read-back are on-device.
   ========================================================================= */
import { h, mount, icon, api, state, toast, fmtRelative } from '../core.js';

import { createLocalVoice } from '../voice.js';
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
  let lastReply = '', suggestions = null, hasTurns = false;
  const langTitle = 'Voice language / भाषा';
  const languageButtons = ['en', 'hi'].map((lang) => h('button', { type: 'button', class: 'btn btn-xs', lang,
    onclick: () => changeLanguage(lang) }, lang === 'hi' ? 'हिन्दी' : 'English'));
  const languageBar = h('div', { class: 'voice-language', role: 'group', 'aria-label': langTitle },
    h('span', { class: 'field-label' }, langTitle), ...languageButtons);
  const voiceText = h('span', { class: 'subtle', role: 'status' }, t('On-device English · no audio uploaded', 'डिवाइस पर हिन्दी · आवाज़ अपलोड नहीं होती'));
  const startLabel = () => t('Start voice mode', 'बोलना शुरू करें');
  const voiceBtn = h('button', { class: 'btn btn-sm', 'aria-pressed': 'false', onclick: () => voice.toggle() }, startLabel());
  const readBtn = h('button', { class: 'btn btn-xs', disabled: true, onclick: () => voice.readReply(lastReply) });
  const help = h('details', { class: 'voice-help' });
  function renderVoiceLabels() {
    languageButtons.forEach((b) => b.setAttribute('aria-pressed', String(language === b.getAttribute('lang'))));
    readBtn.textContent = t('Read last reply', 'पिछला जवाब सुनें');
    mount(help, h('summary', null, t('Voice setup and device dictation', 'आवाज़ की सेटिंग और डिक्टेशन')),
      window.self !== window.top ? h('a', { href: location.href, target: '_blank', rel: 'noopener noreferrer' }, t('Open the app in its own tab', 'ऐप को अलग टैब में खोलें')) : null,
      h('p', null, t('Try the app in a standalone tab in an up-to-date desktop Chrome browser. Use localhost on the server PC or HTTPS.', 'ऐप को अपडेट किए गए डेस्कटॉप ब्राउज़र में अलग टैब में खोलें। सर्वर कंप्यूटर पर localhost या HTTPS का उपयोग करें।')),
      h('p', null, t('Windows 11 alternative: Open Start → Voice access and complete its English setup. Focus the message box, dictate your question or CRM command, then say “Press Enter”. Windows controls its own microphone.', 'स्थानीय हिन्दी पैक उपलब्ध न हो तो संदेश बॉक्स में हिन्दी में लिखकर Enter दबाएँ। अगर आपके डिवाइस में ऑफ़लाइन हिन्दी डिक्टेशन उपलब्ध है, तो उसका उपयोग भी कर सकते हैं। उस माइक को डिवाइस नियंत्रित करता है, ऐप नहीं।')),
      h('p', null, t('Read-aloud needs a local English voice; it does not use the microphone.', 'जवाब सुनने के लिए डिवाइस पर हिन्दी की स्थानीय आवाज़ चाहिए। इसके लिए माइक की ज़रूरत नहीं है।')),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-xs', onclick: () => el.querySelector('.assistant-input')?.focus() }, t('Focus message box', 'संदेश बॉक्स चुनें')), readBtn));
  }
  const voice = createLocalVoice({ language, onCommand: send, onState({ text, active, action, help: showHelp }) {
    voiceText.textContent = text;
    voiceBtn.textContent = ({ stop: t('Stop voice', 'माइक बंद करें'), install: t('Install English speech pack', 'हिन्दी स्पीच पैक इंस्टॉल करें'),
      retry: t('Check again', 'फिर जाँचें'), 'stop-reading': t('Stop reading', 'पढ़ना बंद करें') })[action] || startLabel();
    voiceBtn.setAttribute('aria-pressed', String(active || action === 'stop-reading'));
    readBtn.disabled = !lastReply || active || action === 'stop-reading';
    if (showHelp) help.open = true;
    else if (active) help.open = false;
  } });
  const crm = createAssistantCrm(crmHost, send, () => language);
  mount(el, head, scopeHost, queueHost, crmHost, log, h('div', { class: 'assistant-voice' }, languageBar, voiceBtn, voiceText, help), foot);

  let open = false, busy = false;
  let proposals = [], names = [], selected = null;
  let epoch = 0, pendingQuestion = '', waitingPerson = false;

  function changeLanguage(next) {
    if (next === language || crm.isSaving()) return;
    ++epoch; busy = false; lastReply = ''; pendingQuestion = ''; waitingPerson = false;
    language = next; localStorage.setItem(LANGUAGE_KEY, next); el.setAttribute('lang', next);
    voice.setLanguage(next); help.open = false; renderVoiceLabels();
    crm.changeLanguage(); renderHead(); renderScope(); renderFoot();
    if (!hasTurns) seed();
    else if (crm.isOpen()) {
      log.appendChild(bubble('agent', t('CRM is still open. Say “list fields” or “review changes”.', 'CRM खुला है। “फ़ील्ड बताएं” या “बदलाव की समीक्षा करें” कहें।')));
      addSuggestions(t(['List fields', 'Review changes'], ['फ़ील्ड बताएं', 'बदलाव की समीक्षा करें']));
    } else addSuggestions(examples());
    log.scrollTop = log.scrollHeight; refreshProjects(); refreshQueue();
  }

  function renderHead() {
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
      selected = name; waitingPerson = false; proposals = []; mount(queueHost); renderHead(); refreshQueue();
    }
    renderScope();
  }
  function renderScope() {
    languageButtons.forEach((b) => { b.disabled = busy && crm.isOpen(); });
    const picker = h('select', { class: 'select', 'aria-label': t('Giga Project Name', 'गीगा प्रोजेक्ट का नाम'), disabled: busy || crm.isOpen(),
      onchange: (e) => {
        setProject(e.target.value || null);
        if (pendingQuestion && selected) { const ask = pendingQuestion; pendingQuestion = ''; send(ask); }
      },
    }, h('option', { value: '' }, t('Say or select a project', 'प्रोजेक्ट का नाम बोलें या चुनें')), ...names.map((name) => h('option', { value: name }, name)));
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
  const ask = (message, projectName) => api('/agent/ask', { method: 'POST', body: { message, projectName, language } });
  async function send(text) {
    const id = epoch;
    const reply = await respond(text);
    if (id === epoch && open && reply) { lastReply = reply; readBtn.disabled = voice.isActive(); }
    return reply;
  }
  async function respond(text) {
    const message = String(text || '').trim();
    if (!message || !open || busy || crm.isSaving()) return '';
    const id = epoch;
    hasTurns = true; busy = true; addSuggestions([]); renderScope(); log.appendChild(bubble('user', message));
    const thinking = bubble('agent', t('Checking…', 'जाँच जारी है…')); log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;
    try {
      if (crm.isOpen()) {
        const reply = await crm.command(message);
        if (id !== epoch) return '';
        log.appendChild(bubble('agent', reply));
        if (crm.reviewReady()) addSuggestions(t(['Confirm save', 'Discard changes'], ['सहेजने की पुष्टि करें', 'बदलाव रद्द करें']));
        return reply;
      }
      const lookup = waitingPerson && !names.includes(message) && !/^(open|show|select|switch|use|how|who|list|count|break|set)\b/i.test(message) &&
        !(language === 'hi' && /(?:कितने|कितनी|कौन|विवरण|सूची|चुनें|खोलें|खोलो|खोलिए)/u.test(message));
      let res = await ask(lookup ? t('Open CRM for ' + message, message + ' का सीआरएम खोलें') : message, selected);
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
      const table = dataTable(res.table);
      if (table) log.appendChild(h('div', { class: 'msg agent' }, h('div', { class: 'msg-body wide' }, table)));
      if (res.proposal) {
        log.appendChild(h('div', { class: 'msg agent' }, h('div', { class: 'msg-body wide' }, proposalCard(res.proposal))));
        await refreshQueue();
        if (id !== epoch) return '';
      }
      if (!crm.isOpen() && !waitingPerson) addSuggestions(res.suggestions);
      const readTable = res.kind === 'list' || res.kind === 'crm_lookup' || res.kind === 'breakdown';
      return res.reply + (readTable && res.table?.rows?.length ? ' ' + res.table.rows.slice(0, 8).map((r) => r.join(', ')).join('; ') : '');
    } catch (err) {
      if (id !== epoch) return '';
      const reply = t('Request not completed. ', 'अनुरोध पूरा नहीं हुआ। ') + err.message;
      log.appendChild(bubble('agent', reply)); return reply;
    } finally {
      thinking.remove();
      if (id === epoch) { busy = false; renderScope(); log.scrollTop = log.scrollHeight; }
    }
  }

  function renderFoot() {
    const submit = () => { if (!busy && input.value.trim()) { send(input.value); input.value = ''; } };
    const input = h('textarea', { class: 'assistant-input', rows: 1, lang: language, 'aria-label': t('Ask or enter a CRM command', 'सवाल या CRM निर्देश लिखें'),
      placeholder: t('Ask about a project or say “open CRM”', 'प्रोजेक्ट पर सवाल पूछें या “सीआरएम खोलें” कहें'),
      // Enter can accept a Hindi IME composition without sending the message.
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } },
    });
    input.value = foot.querySelector('.assistant-input')?.value || '';
    mount(foot, input, h('button', { class: 'btn btn-primary btn-icon', 'aria-label': t('Send message', 'संदेश भेजें'), onclick: submit }, icon('arrowRight', 15)));
  }
  function examples() {
    return t(['How many are on bench?', 'Break down bench category', 'Who is on bench?', 'Open CRM'],
      ['बेंच पर कितने लोग हैं?', 'बेंच श्रेणी का विवरण दिखाएँ', 'बेंच पर कौन है?', 'सीआरएम खोलें']);
  }
  function seed() {
    mount(log, bubble('agent', t('Name the workbook project you want to ask about. I can report on its people or open CRM for an employee. In voice mode, say “open CRM”, dictate fields, then review and confirm before saving.',
      'वर्कबुक का प्रोजेक्ट चुनें या उसका नाम बोलें। उसके कर्मचारियों के बारे में पूछें या “सीआरएम खोलें” कहें। CRM में बोलकर फ़ील्ड भरें, फिर सहेजने से पहले बदलाव की समीक्षा और पुष्टि करें।')));
    addSuggestions(examples());
  }
  function toggle(next) {
    open = next === undefined ? !open : next;
    el.classList.toggle('hidden', !open); document.body.classList.toggle('assistant-open', open);
    document.querySelectorAll('.assistant-launch').forEach((b) => b.classList.toggle('active', open));
    if (open) {
      if (!log.children.length) seed();
      renderFoot(); refreshProjects(); refreshQueue(); el.querySelector('.assistant-input')?.focus();
    } else {
      epoch++; busy = false; lastReply = ''; voice.stop(); waitingPerson = false; pendingQuestion = '';
    }
  }
  renderHead(); renderScope(); renderFoot(); renderVoiceLabels();
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

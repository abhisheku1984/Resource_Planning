/* Keystrokes, guided updates and final dictation edit the same in-memory CRM
   draft. Only a separate confirmation can call the authenticated submit API. */
import { h, mount, api } from '../core.js';
import { fieldsHi, optionsHi, crmCommandHi, hindiDate, digits } from './crm-hindi.js';
import { createGuide } from './crm-guide.js';

const words = (v) => String(v).toLowerCase().replace(/[_/.-]+/g, ' ').replace(/\s+/g, ' ').trim();
function dateValue(value) {
  const clean = value.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, '');
  let iso = clean;
  if (!/^\d{4}-\d\d-\d\d$/.test(clean)) {
    const months = 'january february march april may june july august september october november december'.split(' ');
    const m = clean.match(/^(?:(\d{1,2}) (\w+)|(\w+) (\d{1,2})) (\d{4})$/);
    if (!m) return '';
    const month = months.indexOf((m[2] || m[3]).toLowerCase()) + 1;
    iso = `${m[5]}-${String(month).padStart(2, '0')}-${(m[1] || m[4]).padStart(2, '0')}`;
  }
  const d = new Date(iso + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : '';
}
export function createAssistantCrm(host, onCommand, getLanguage = () => 'en', onEdit = () => {}) {
  let form = null, guide = null, reviewed = false, saving = false, ticket = null, version = 0;
  const controls = new Map(), draft = new Map(), preview = h('div', { class: 'guide-preview' });
  const hi = () => getLanguage() === 'hi';
  const t = (en, hindi) => hi() ? hindi : en;
  const label = (f) => hi() && Object.hasOwn(fieldsHi, f.key) ? fieldsHi[f.key] : f.label;
  const option = (v) => hi() && Object.hasOwn(optionsHi, v) ? optionsHi[v] : v;
  const display = (f, v) => f.type === 'select' ? option(v) : v;
  const identity = () => `${form.name} (${form.empCode})` + t(' in ', ', प्रोजेक्ट ') + form.projectName;
  const place = () => t('Placement ', 'प्लेसमेंट ') + form.assignmentId;
  const reviewLabel = () => t('Review changes', 'बदलाव की समीक्षा करें');
  const confirmLabel = () => t('Confirm save', 'सहेजने की पुष्टि करें');
  const discardLabel = () => t('Discard changes', 'बदलाव रद्द करें');
  function invalidate() { reviewed = false; ticket = null; ++version; }
  function clear() { invalidate(); form = guide = null; draft.clear(); controls.clear(); reviewed = saving = false; mount(host); mount(preview); }
  function update(f, value) {
    invalidate();
    if (String(f.value) === value) draft.delete(f.key); else draft.set(f.key, value);
    const input = controls.get(f.key);
    if (input) { input.value = value; input.classList.toggle('is-changed', draft.has(f.key)); }
  }
  function changes() {
    return [...draft].map(([key, value]) => {
      const f = form.fields.find((f) => f.key === key);
      return { field: label(f), before: display(f, f.value) || t('(empty)', '(खाली)'), after: display(f, value) || t('(clear)', '(खाली)') };
    });
  }
  function renderPreview() {
    if (!guide) return;
    mount(preview, h('div', { class: 'guide-stage' }, reviewed ? t('Review · Save these changes?', 'समीक्षा · ये बदलाव सहेजें?') : t('Draft · Not saved', 'ड्राफ़्ट · अभी सहेजा नहीं गया')),
      ...changes().map((c) => h('div', { class: 'guide-change' }, h('strong', null, c.field), h('del', null, c.before), h('span', null, ' → '), h('span', null, c.after))));
  }
  function control(f) {
    const input = f.type === 'select' ? h('select', { class: 'select' },
      h('option', { value: '' }, t('Not set', 'खाली')), ...(f.options || []).map((v) => h('option', { value: v }, option(v))))
      : f.type === 'textarea' ? h('textarea', { class: 'textarea', rows: 2 }) : h('input', { class: 'input', type: f.type || 'text' });
    input.disabled = saving || !f.editable; input.value = draft.get(f.key) ?? f.value; input.dataset.fieldKey = f.key;
    input.classList.toggle('is-changed', draft.has(f.key));
    input.addEventListener('input', () => { guide?.reset(); update(f, input.value); renderPreview(); onEdit(); }); controls.set(f.key, input);
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label(f) === f.label ? f.label : `${label(f)} · ${f.label}`), input);
  }
  function render() {
    if (!form) return;
    controls.clear(); renderPreview();
    const close = t('Close CRM', 'सीआरएम बंद करें');
    const pinned = (f) => guide && (draft.has(f.key) || guide.activeField() === f.key);
    mount(host, h('div', { class: 'spread' }, h('strong', null, guide ? t('Guided CRM update', 'निर्देशित CRM अपडेट') : t('Employee CRM', 'कर्मचारी CRM')),
      h('button', { class: 'btn btn-xs', disabled: saving, onclick: () => onCommand(close) }, close)),
      h('div', { class: 'subtle' }, identity()),
      !guide && form.fields.some((f) => f.guideEditable ?? f.editable) ? h('button', { class: 'btn btn-xs', disabled: saving, onclick: () => onCommand(t('Guide this form', 'फ़ॉर्म भरने में मदद करें')) }, t('Guide this form', 'फ़ॉर्म भरने में मदद करें')) : null, guide ? h('div', { class: 'subtle' }, [place(), form.placementLabel].filter(Boolean).join(' · ')) : null,
      guide ? preview : null, ...form.fields.filter(pinned).map(control),
      h('details', { open: !guide }, h('summary', null, `${t('CRM fields', 'CRM फ़ील्ड')} (${form.fields.length})`), ...form.fields.filter((f) => !pinned(f)).map(control)),
      form.fields.some((f) => f.editable) ? h('button', { class: 'btn btn-sm', disabled: saving, onclick: () => onCommand(reviewLabel()) }, reviewLabel()) : null);
  }
  function reviewBody() {
    return { crmProjectName: form.projectName, rev: form.rev, changes: Object.fromEntries(draft),
      before: Object.fromEntries(form.fields.filter((f) => draft.has(f.key)).map((f) => [f.key, String(f.value)])) };
  }
  async function review() {
    if (guide?.awaiting()) return t('Answer the outstanding field question, or discard this update first.', 'पहले फ़ील्ड के सवाल का जवाब दें या बदलाव रद्द करें।');
    if (!draft.size) return t('No CRM changes to save.', 'सहेजने के लिए कोई बदलाव नहीं है।');
    if (guide) {
      invalidate(); const id = version;
      try {
        const res = await api(`/agent/crm/${form.assignmentId}/review`, { method: 'POST', body: reviewBody() });
        if (id !== version) return t('The draft changed. Review it again.', 'ड्राफ़्ट बदला है। फिर समीक्षा करें।');
        // Read back the server's canonical values and current employee identity,
        // not a guessed field label or a number/date the server would reformat.
        const plan = res.interpretation;
        form.name = plan.name; form.empCode = plan.empCode; form.placementLabel = plan.placementLabel;
        draft.clear();
        for (const row of plan.fields) {
          const f = form.fields.find((f) => f.key === row.key); f.label = row.label; update(f, row.after);
        }
        ticket = res.ticket;
      } catch (err) {
        if (id !== version) return '';
        if ([401, 403, 404, 409].includes(err.status)) clear();
        return t(`Not saved. ${err.message}`, `सहेजा नहीं गया। ${err.message}`);
      }
    }
    reviewed = true;
    const values = changes().map((c) => `${c.field}: ` + (guide
      ? t(`was ${c.before}, now ${c.after}`, `पहले ${c.before}, अब ${c.after}`) : c.after)).join('; ');
    const ref = identity() + (guide ? ` · ${place()}` : '');
    if (guide) render();
    return t('Review for ', 'बदलाव की समीक्षा: ') + ref + ': ' + values + (guide
      ? t('. Save these changes? Say yes, correct a value, or cancel.', '। ये बदलाव सहेजें? हाँ कहें, मान सुधारें या रद्द करें।')
      : t('. Say “confirm save” to write these changes, or “discard changes”.', '। बदलाव लिखने के लिए “सहेजने की पुष्टि करें” या “बदलाव रद्द करें” कहें।'));
  }
  function normalize(f, raw) {
    let value = raw.trim();
    if (!value && f.required) return { error: t(`${f.label} is required.`, `${label(f)} खाली नहीं हो सकता।`) };
    if (value && f.type === 'select') {
      value = (f.options || []).find((v) => [v, option(v)].some((o) => words(o) === words(value)));
      if (!value) return { error: t('Choose one of: ', 'इनमें से एक चुनें: ') + (f.options || []).map(option).join(', ') + '.' };
    } else if (value && f.type === 'date') {
      const clean = value.replace(/[.!?।]+$/u, ''); value = dateValue(hi() ? hindiDate(clean) : clean);
      if (!value) return { error: t('Use a date like “May 12 2027” or YYYY-MM-DD.', 'तारीख “१२ मई २०२७” या YYYY-MM-DD के रूप में दें।') };
    } else if (value && f.type === 'number') {
      if (hi()) value = digits(value);
      if (!Number.isFinite(Number(value))) return { error: t('Please give a number.', 'कृपया कोई संख्या दें।') };
    }
    return { value };
  }
  function show(next, guided = null) {
    clear(); form = next;
    let reply = '';
    if (guided?.step === 'form') reply = beginGuide(guided.instruction);
    render(); return reply;
  }
  function beginGuide(instruction) {
    form = { ...form, fields: form.fields.map((f) => ({ ...f, editable: f.guideEditable ?? f.editable })) };
    guide = createGuide({ fields: form.fields, t, label, option, normalize, apply: update, review, dirtyKeys: () => [...draft.keys()] });
    return guide.start(instruction);
  }
  function suspend() { invalidate(); guide?.reset(); renderPreview(); }
  function changeLanguage() { suspend(); render(); }
  async function save() {
    if (!draft.size || !reviewed || saving || (guide && !ticket)) return t('First say “review changes” and check the employee and values.', 'पहले “बदलाव की समीक्षा करें” कहें और कर्मचारी व दर्ज किए गए मान जाँचें।');
    const proof = ticket; invalidate(); saving = true;
    const target = form;
    for (const input of controls.values()) input.disabled = true;
    try {
      const res = guide ? await api(`/agent/crm/${form.assignmentId}/confirm`, { method: 'POST', body: { ...reviewBody(), ticket: proof } })
        : await api(`/employees/${form.assignmentId}/submit`, { method: 'POST', body: {
        crmProjectName: form.projectName, changes: Object.fromEntries(draft), rev: form.rev, reason: 'Confirmed CRM form in assistant',
      } });
      if (target !== form) return '';
      const reply = t(`Saved CRM changes for ${identity()}.`, `${identity()} के CRM बदलाव सहेज लिए गए हैं।`);
      if (guide) clear();
      else show({ ...form, rev: res.record.rev, fields: form.fields.map((f) => ({ ...f, value: res.record.values[f.key] ?? '' })) });
      document.dispatchEvent(new CustomEvent('rp:data-changed')); return reply;
    } catch (err) {
      if (target !== form) return '';
      if ([401, 403, 404, 409].includes(err.status) && err.data?.code !== 'REVIEW_AGAIN') { clear(); return t(`Not saved. ${err.message} Reopen the CRM record to review it.`, `बदलाव नहीं सहेजे गए। ${err.message} जाँच के लिए CRM रिकॉर्ड फिर खोलें।`); }
      const reason = Object.values(err.data?.errors || {})[0] || err.message;
      return t(`Not saved. ${reason} Review your draft again before retrying.`, `बदलाव नहीं सहेजे गए। ${reason} फिर कोशिश करने से पहले बदलाव की समीक्षा करें।`);
    } finally {
      saving = false;
      if (form === target) { for (const f of form.fields) controls.get(f.key).disabled = !f.editable; renderPreview(); }
    }
  }
  async function command(message) {
    const text = hi() ? crmCommandHi(message) : message;
    const cmd = text.trim().replace(/[.!?।]+$/u, ''), lower = cmd.toLowerCase();
    if (lower === 'confirm save' || (guide && /^(?:yes|yes[, ]+save(?: it)?|हाँ|हां|जी हाँ|हाँ[, ]+सहेजें)$/u.test(lower))) return save();
    // In guided mode a yes is valid only directly after the latest review.
    if (guide) { invalidate(); renderPreview(); }
    if (/^(?:discard changes|cancel|cancel changes)$/.test(lower) || (guide && /^(?:no|no thanks|discard|नहीं|रद्द करें)$/u.test(lower))) {
      if (guide) clear(); else for (const f of form.fields) update(f, String(f.value));
      return t('Draft discarded. Nothing was saved.', 'बदलाव रद्द कर दिए गए। कुछ भी नहीं सहेजा गया।');
    }
    if (lower === 'close crm') {
      if (draft.size) return t('There are unsaved CRM changes. Say “review changes” to save or “discard changes” before closing.', 'अभी बदलाव नहीं सहेजे गए हैं। “बदलाव की समीक्षा करें” या बंद करने से पहले “बदलाव रद्द करें” कहें।');
      clear(); return t('CRM closed. You can ask another project question.', 'CRM बंद है। अब प्रोजेक्ट के बारे में दूसरा सवाल पूछ सकते हैं।');
    }
    if (/^(?:list|read|show) (?:the )?fields$/.test(lower)) return t('CRM fields: ', 'CRM फ़ील्ड: ') + form.fields.map(label).join('; ') + '.';
    if (/^(?:review(?: changes)?|save(?: changes)?|save crm)$/.test(lower)) return review();
    if (!guide && /^(?:guide this form|फ़ॉर्म भरने में मदद करें)$/iu.test(cmd)) {
      if (!form.fields.some((f) => f.guideEditable ?? f.editable)) return t('This record has no editable guide fields.', 'इस रिकॉर्ड में बदलने योग्य फ़ील्ड नहीं है।');
      if (draft.size) return t('Finish or discard the current draft first.', 'पहले मौजूदा ड्राफ़्ट पूरा करें या रद्द करें।');
      const reply = beginGuide(''); render(); return reply;
    }
    const op = cmd.match(/^(read|clear)\s+(.+)$/i);
    if (guide && !op) {
      // Never consume a new employee/project request as the answer for this form.
      const newSubject = /^(?:for .+,|in .+,|(?:switch to|select|use project|open crm|how many|who is)\b|(?:update|edit|set|change) (?:.+ (?:for|in) .+|(?:employee )?[a-z]+[- ]\d+.*|.+['’]s .+)|.+ का (?:सीआरएम|CRM) खोलें|.+ (?:की|का|के लिए) .+ (?:अपडेट करें|लिखें|भरें|बदलें|दर्ज करें)|.+ चुनें$)/iu;
      const otherId = /^(?:update|edit|set|change) .+\sfor (?:employee )?[a-z]+[- ]\d+(?: in .+)?[.!?]?$/iu;
      if ((otherId.test(cmd) && !/['”"’]$/.test(cmd)) || (!guide.namesField(text) && (newSubject.test(cmd) || newSubject.test(message)))) {
        return t('This draft belongs to ', 'यह ड्राफ़्ट इस रिकॉर्ड का है: ') + identity() + t('. Finish or discard it before switching.', '। पहले पूरा करें या रद्द करें।');
      }
      const reply = guide.turn(message); render(); return reply;
    }
    const set = text.trim().match(/^(?:set|change|fill)\s+(.+?)\s+to\s+(.+)$/is);
    if (!set && !op) return t('In CRM, say “list fields”, “read Detail Comments”, “set Detail Comments to” and your note, “review changes”, or “close CRM”.', 'CRM में “फ़ील्ड बताएं”, “टिप्पणी पढ़ें”, “टिप्पणी में अपना नोट लिखें”, “बदलाव की समीक्षा करें” या “सीआरएम बंद करें” कहें।');
    const key = words(set ? set[1] : op[2]);
    const matches = form.fields.filter((f) => [f.label, f.key, label(f)].some((k) => words(k) === key));
    if (matches.length !== 1) return t('That field is not on this CRM form or is ambiguous. Say “list fields” for its exact labels.', 'फ़ील्ड की पहचान नहीं हो सकी। सही नाम सुनने के लिए “फ़ील्ड बताएं” कहें।');
    const f = matches[0];
    if (op?.[1].toLowerCase() === 'read') return `${label(f)}: ${display(f, draft.get(f.key) ?? f.value) || t('not set', 'खाली')}.`;
    if (!f.editable) return t(`${f.label} is read-only. Nothing was changed.`, `${label(f)} केवल पढ़ने के लिए है। कोई बदलाव नहीं हुआ।`);
    const { value, error } = normalize(f, set ? set[2] : ''); if (error) return error;
    update(f, value);
    if (guide) { guide.reset(); const reply = review(); render(); return reply; }
    return t(`Draft ${f.label}: ${value || '(clear)'}. Not saved. Dictate another field or say “review changes”.`, `ड्राफ़्ट में ${label(f)}: ${display(f, value) || '(खाली)'}। अभी सहेजा नहीं गया है। अगला फ़ील्ड भरें या “बदलाव की समीक्षा करें” कहें।`);
  }
  function suggestions() {
    if (reviewed) return [confirmLabel(), discardLabel()];
    if (!guide) return [];
    return [...guide.choices().slice(0, 6), ...(!guide.awaiting() && draft.size ? [reviewLabel()] : []), discardLabel()];
  }
  return { show, clear, command, changeLanguage, suspend, suggestions, isOpen: () => !!form, isReviewed: () => reviewed, isSaving: () => saving };
}

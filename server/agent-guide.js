'use strict';
// Identify the subject of an explicit form update, not its authority. Project
// and employee strings STILL go through the normal live, exact scope lookup.
// Separate targets BEFORE interpreting field values: “ready for interview in
// May” is note text, not another employee or project.
const polite = /^(?:(?:please|can you|could you|help me|i want to|i(?:'d| would) like to)\s+)+/i;
const edit = /^(update|edit|fill|set|add|change|record|write)\s+(.+)$/is;
const generic = /^(?:(?:an?|the)\s+)?(?:employee(?:'s)?(?:\s+(?:CRM|record|form))?|CRM(?:\s+(?:record|form))?|record|form)$/i;
const clean = (s) => s?.trim().replace(/[.!?।]+$/u, '').trim() || '';

function english(raw, isCatalogueField) {
  let text = raw.replace(polite, ''), project = null, person = '', target = '', field;
  const prefix = text.match(/^in\s+(.+?),\s*(.+)$/is);
  if (prefix) { project = clean(prefix[1]); text = prefix[2].replace(polite, ''); }
  const front = text.match(/^for\s+(.+?),\s*(.+)$/is);
  if (front) { target = front[1]; text = front[2].replace(polite, ''); }
  const verb = text.match(edit);
  if (!verb) return null;
  // The value (including any later assignments) is opaque during scope lookup.
  const parts = verb[2].split(/(\s+to\s+|\s*:\s*|\s*=\s*)/i);
  const head = parts.shift().trim(); let tail = parts.join('');
  // An explicit employee ID can also close a sentence. Do not interpret an
  // ordinary “for interview” inside a note, nor peel a second employee off a
  // value when the sentence already named its target.
  const suffix = !front && !/\sfor\s|['’]s\s/i.test(head) && tail.match(/\s+for\s+((?:employee(?: id)?\s+)?[a-z]+[- ]\d+(?:\s+(?:in|within|under)\s+.+)?)[.!?]*$/is);
  if (suffix) { target = suffix[1]; tail = tail.slice(0, suffix.index); }
  if (front || suffix) field = head;
  else {
    const who = head.match(/^(.+?)\s+for\s+(.+)$/is);
    const possessive = head.match(/^(.+?)(?:'s|’s)\s+(.+)$/is);
    if (who) { field = who[1]; target = who[2]; }
    else if (possessive) { target = possessive[1]; field = possessive[2]; }
    else {
      // “Set <person> to hard block” belongs to the admin proposal workflow.
      if (/^(?:set|change)$/i.test(verb[1]) && !/^(?:the |(?:interview )?(?:notes?|comments?)$|owner$|billing date$)/i.test(head) && !isCatalogueField(head)) return null;
      const inProject = head.match(/^(.+?)\s+(?:in|under|within)\s+(.+)$/is);
      if (inProject && project) return null; // don't ignore conflicting targets
      if (inProject) project = clean(inProject[2]);
      field = inProject ? inProject[1] : head;
      if (/^(?:employee\s+)?[a-z]+[- ]\d+$/i.test(clean(field))) { person = clean(field); field = ''; }
    }
  }
  if (target) {
    const loc = target.trim().match(/^(.+?)\s+(?:in|under|within)\s+(.+)$/is);
    if (loc && project) return null;
    if (loc) project = clean(loc[2]);
    person = clean(loc ? loc[1] : target);
    if (generic.test(person)) person = '';
  }
  if (generic.test(clean(field))) field = '';
  return { project, person, instruction: (field + tail).trim() };
}

function hindi(text) {
  const action = text.replace(/^कृपया\s+/u, '').match(/^(.+?)\s+(?:अपडेट (?:करें|करो)|बदलें|सुधारें|लिखें|भरें|दर्ज करें)[.!?।]*$/su);
  if (!action) return null;
  let [, body] = action, project = null, person = '';
  // “में” and “के लिए” also occur in field labels and note text. Split
  // the subject first; once the field begins, leave its entire value intact.
  const fieldStart = /^(?:टिप्पणी|नोट|इंटरव्यू नोट|साक्षात्कार नोट|बिलिंग|खात[ेा]|अकाउंट|पिछले सप्ताह|इस सप्ताह|अवसर|मांग|महीने की भूमिका|भूमिका पर|साक्षात्कारकर्ता|आवंटन पूरा|प्रतीक्षित|पीआईडी ब्लॉक|ब्लॉक स्थिति)(?:\s|$)/u;
  const prefix = !fieldStart.test(body) && body.match(/^(.+?)\s+में\s+(.+)$/su);
  if (prefix && !/\s+(?:की|का|के)\s+/u.test(prefix[1])) { project = clean(prefix[1]); body = prefix[2]; }
  const who = !fieldStart.test(body) && body.match(/^(.+?)\s+(?:के लिए|की|का|के)\s+(.+)$/su);
  if (who) { person = clean(who[1]); body = who[2]; }
  if (!who && /^(?:कर्मचारी\s+)?[a-z]+[- ]+[०-९\d]+$/iu.test(body)) { person = body; body = ''; }
  if (/^(?:कर्मचारी|कर्मचारी रिकॉर्ड|सीआरएम|रिकॉर्ड|फ[ॉो]र्म)$/u.test(body)) body = '';
  if (person === 'कर्मचारी') person = '';
  return { project, person, instruction: body.trim() };
}

function parseGuide(message, language, isCatalogueField = () => false) {
  const text = message.trim();
  return (language === 'hi' && hindi(text)) || english(text, isCatalogueField);
}
// Procedural questions do not require a workbook selection or query any staff
// data. These answers describe actual screens, not generated policy advice.
function howTo(message, language, user) {
  const t = (en, hi) => language === 'hi' ? hi : en;
  const text = clean(message).toLowerCase();
  let topic, reply;
  if (/^(?:help|what can you do|how (?:do|can) i update (?:a record|an employee)|मदद|आप क्या कर सकते हैं|कर्मचारी अपडेट कैसे करें)$/u.test(text)) {
    topic = 'Ask'; reply = t('Choose Update an employee. Tell me the project and employee, then the note, date or other field to change. You can correct my draft; it is not saved until you confirm the review.',
      '“कर्मचारी अपडेट करें” चुनें। प्रोजेक्ट, कर्मचारी और बदलने वाला फ़ील्ड बताएं। आप ड्राफ़्ट सुधार सकते हैं; समीक्षा की पुष्टि के बाद ही बदलाव सहेजे जाते हैं।');
  } else if (/^(?:how (?:do|can) i import (?:the |a |my )?(?:workbook|spreadsheet)|वर्कबुक कैसे आयात करें)$/u.test(text)) {
    topic = 'Data Hub'; reply = user.isAdmin || (!user.gigaAccess && user.capabilities?.['import.data'])
      ? t('In Data Hub, choose the default placement, upload the .xlsx, preview the rows and protected values, then select Apply import.', 'Data Hub में प्लेसमेंट चुनें, .xlsx अपलोड करें, पंक्तियों और सुरक्षित मानों का पूर्वावलोकन करें, फिर आयात लागू करें।')
      : t('An administrator or authorized HR importer can preview and apply the master workbook in Data Hub. Your access does not permit master imports.', 'व्यवस्थापक या अधिकृत HR उपयोगकर्ता Data Hub में मास्टर वर्कबुक आयात कर सकता है। आपकी अनुमति में यह शामिल नहीं है।');
  } else if (/^(?:how do approvals work|who approves changes|मंज़ूरी कैसे मिलती है)$/u.test(text)) {
    topic = 'Ask'; reply = t('A bench or block request in chat is a proposal. An administrator reviews the old and new values in Ask before approving or rejecting it. A changed target cannot be approved as originally proposed.',
      'चैट में बेंच या ब्लॉक बदलाव एक प्रस्ताव है। व्यवस्थापक Ask में पुराने और नए मान देखकर मंज़ूरी देता है या प्रस्ताव रद्द करता है। रिकॉर्ड बदल जाए तो पुराना प्रस्ताव लागू नहीं होता।');
  } else return null;
  return { kind: 'howto', understood: true, reply, source: topic, suggestions: [t('Update an employee', 'कर्मचारी अपडेट करें'), t('How do approvals work?', 'मंज़ूरी कैसे मिलती है?')] };
}
module.exports = { parseGuide, howTo };

'use strict';
// Presentation only: both languages receive results from the same scoped queries.
// Project names, employee identity, revision and stored option values stay exact.
const { label } = require('./agent-hi');
const en = {
  choose: (names) => 'Which Giga Project Name? Say or select one of your workbook projects: ' + names.join(', ') + '.',
  unavailable: 'That Giga Project Name is not available in your access. Choose an exact workbook project name; I have not searched any other project.',
  noProjects: 'There are no named workbook placements in your access. Ask an administrator about your Giga project.',
  selected: (name) => `Selected Giga project: ${name}.`,
  examples: (name) => [`How many are on bench in ${name}?`, `Break down bench category in ${name}`, `Who is on bench in ${name}?`],
  help: (name) => `For ${name}, I can count or list people, break down a status, propose a bench or block change, or open an employee’s CRM. Try one of the examples.`,
  whichField: (name, fields) => `Which field in ${name}: ${fields.join(' or ')}? Include the field name in your question.`,
  count: (name, total, field, value) => `${total.toLocaleString('en-IN')} ${total === 1 ? 'person' : 'people'}${value ? ` (${field.label}: ${value})` : ''} in ${name}.`,
  first25: ' Showing the first 25.', people: 'People', peopleColumns: ['Employee ID', 'Name', 'Giga Project Name'],
  placements: 'Matching placements', placementColumns: ['Placement', 'Employee ID', 'Name', 'Project / subproject / category'],
  retryGuide: (name) => `I couldn't match that employee and placement in ${name}. Start a new update with the exact employee ID. No form was changed.`,
  draftFor: (ref) => `CRM draft for ${ref}.`,
  noMatch: (name) => `No matching accessible placement in ${name}. Give the employee ID or exact full name.`,
  ambiguous: (name) => `More than one placement matches in ${name}. Use “placement” and the placement number instead of the name.`,
  noPermission: (name, crm) => `You do not have ${crm ? 'CRM' : 'edit'} permission in ${name}.`,
  askPerson: (name) => `Whose CRM record in ${name}? Say the employee ID or full name.`,
  reference: (p, name) => `${p.name} (${p.emp_code}) in ${name}`,
  openCrm: (ref, editable) => `CRM open for ${ref}. ` + (editable ? 'Say “list fields” or “set Detail Comments to” followed by your note. Then say “review changes”.' : 'This CRM record is read-only.'),
  unchanged: (ref, to) => `${ref} is already ${to}. Nothing to approve.`,
  proposed: (ref, field, to) => `Proposed ${field.label}: ${to} for ${ref}. An administrator must approve before anything is saved.`,
};
const hi = {
  choose: (names) => 'कौन सा गीगा प्रोजेक्ट? वर्कबुक से कोई एक नाम बोलें या चुनें: ' + names.join(', ') + '।',
  unavailable: 'इस गीगा प्रोजेक्ट का नाम आपकी पहुँच में नहीं है। वर्कबुक का पूरा नाम चुनें। किसी दूसरे प्रोजेक्ट में खोज नहीं की गई।',
  noProjects: 'आपकी पहुँच में वर्कबुक का कोई नामित प्रोजेक्ट नहीं है। अपने व्यवस्थापक से संपर्क करें।',
  selected: (name) => `चुना गया गीगा प्रोजेक्ट: ${name}।`,
  examples: (name) => [`${name} में बेंच पर कितने लोग हैं?`, `${name} में बेंच श्रेणी का विवरण दिखाएँ`, `${name} में बेंच पर कौन है?`],
  help: (name) => `${name} के लिए कर्मचारियों की संख्या, सूची या स्थिति पूछें, बदलाव का प्रस्ताव दें या “सीआरएम खोलें” कहें। उदाहरण नीचे हैं।`,
  whichField: (name, fields) => `${name} में किस फ़ील्ड की बात कर रहे हैं: ${fields.join(' या ')}?`,
  count: (name, total, field, value) => `${name} में ${total.toLocaleString('hi-IN')} कर्मचारी${value ? ` (${label(field.key)}: ${label(value)})` : ''}।`,
  first25: ' पहले 25 नाम दिखाए गए हैं।', people: 'कर्मचारी', peopleColumns: ['कर्मचारी आईडी', 'नाम', 'गीगा प्रोजेक्ट का नाम'],
  placements: 'मिलते-जुलते प्लेसमेंट', placementColumns: ['प्लेसमेंट', 'कर्मचारी आईडी', 'नाम', 'पदानुक्रम'],
  retryGuide: (name) => `${name} में यह कर्मचारी और प्लेसमेंट नहीं मिला। सही कर्मचारी आईडी के साथ नया अनुरोध करें। कोई बदलाव नहीं हुआ।`,
  draftFor: (ref) => `${ref} का CRM ड्राफ़्ट।`,
  noMatch: (name) => `${name} में ऐसा कोई सुलभ प्लेसमेंट नहीं मिला। कर्मचारी आईडी या पूरा नाम बोलें।`,
  ambiguous: (name) => `${name} में एक से ज़्यादा प्लेसमेंट मिले। “प्लेसमेंट” और फिर उसका नंबर बोलें।`,
  noPermission: (name, crm) => `${name} में आपको ${crm ? 'CRM खोलने' : 'बदलाव करने'} की अनुमति नहीं है।`,
  askPerson: (name) => `${name} में किसका CRM खोलें? कर्मचारी आईडी या पूरा नाम बोलें।`,
  reference: (p, name) => `${name} में ${p.name} (${p.emp_code})`,
  openCrm: (ref, editable) => `${ref} का CRM खुला है। ` + (editable ? '“फ़ील्ड बताएं” कहें या “टिप्पणी में” बोलें, फिर अपना नोट और “लिखें” कहें। उसके बाद “बदलाव की समीक्षा करें” कहें।' : 'यह रिकॉर्ड केवल पढ़ने के लिए है।'),
  unchanged: (ref, to) => `${ref}: ${label(to)} पहले से दर्ज है। कोई बदलाव नहीं है।`,
  proposed: (ref, field, to) => `${ref}: ${label(field.key)} को ${label(to)} करने का प्रस्ताव है। सहेजने से पहले व्यवस्थापक की मंज़ूरी ज़रूरी है।`,
};
module.exports = { en, hi };

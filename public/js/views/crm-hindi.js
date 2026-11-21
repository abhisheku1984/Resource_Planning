/* Spoken labels only. The CRM editor matches these against fields actually on
   the open form; API payloads keep the workbook keys and canonical options. */
export const fieldsHi = {
  leader_input_last_week: 'पिछले सप्ताह की राय', leader_input_this_week: 'इस सप्ताह की राय',
  leader_input_pid_account: 'प्रतीक्षित पीआईडी खाते पर राय', billing_start_date: 'बिलिंग शुरू होने की तारीख',
  billing_end_date: 'बिलिंग खत्म होने की तारीख', pid_awaited_account: 'प्रतीक्षित पीआईडी खाता',
  pid_awaited_blocked_date: 'पीआईडी ब्लॉक की तारीख', opp_id: 'अवसर आईडी', account_owner: 'खाता स्वामी',
  allocation_closure_eta: 'आवंटन पूरा होने की तारीख', role_of_month: 'महीने की भूमिका', role_of_responses: 'भूमिका पर प्रतिक्रियाएँ',
  detail_comments: 'टिप्पणी', block_status: 'ब्लॉक स्थिति', account_name: 'खाते का नाम', interviewed_by: 'साक्षात्कारकर्ता', demand_number: 'मांग संख्या',
};
export const optionsHi = { 'Hard Block': 'हार्ड ब्लॉक', 'Soft Block': 'सॉफ्ट ब्लॉक', 'No Block': 'कोई ब्लॉक नहीं' };
export const digits = (s) => s.replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)));
const months = ['जनवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
export function hindiDate(s) {
  const m = digits(s).replace(/म्बर/g, 'ंबर').replace('फ़रवरी', 'फरवरी').match(/^(\d{1,2})\s+(\S+)\s+(\d{4})$/);
  if (!m || !months.includes(m[2])) return digits(s);
  return `${m[3]}-${String(months.indexOf(m[2]) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
// Match a whole command, never a substring of a note. "सहेजें" alone only
// requests a review. Only a separate, explicit confirmation can submit.
export function crmCommandHi(text) {
  const cmd = text.trim().replace(/[।.!?]+$/u, '').trim();
  if (/^(?:बदलाव|परिवर्तन) (?:की समीक्षा करें|देखें|जाँचें|सहेजें)$|^सहेजें$/u.test(cmd)) return 'review changes';
  if (/^सहेजने की पुष्टि (?:करें|करो)$/u.test(cmd)) return 'confirm save';
  if (/^बदलाव (?:हटाएँ|हटाएं|रद्द करें)$/u.test(cmd)) return 'discard changes';
  if (/^(?:सी\s*आर\s*एम|crm) बंद (?:करें|करो)$/iu.test(cmd)) return 'close crm';
  if (/^फ़?ील्ड(?: की सूची)? (?:बताएं|बताएँ|दिखाएँ|दिखाएं|पढ़ें)$/u.test(cmd)) return 'list fields';
  const set = cmd.match(/^(.+?)\s+में\s+(.+)\s+(?:लिखें|लिखो|भरें|दर्ज करें)$/su);
  if (set) return `set ${set[1]} to ${set[2]}`;
  const op = cmd.match(/^(.+?)\s+(पढ़ें|पढ़ो|साफ़ करें|साफ करें|खाली करें)$/u);
  if (op) return `${op[2].startsWith('पढ़') ? 'read' : 'clear'} ${op[1]}`;
  return text; // English labels and commands remain valid in a bilingual team
}

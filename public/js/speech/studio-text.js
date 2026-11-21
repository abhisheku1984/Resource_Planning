// Playback text only. The two specialist models have different alphabets;
// don't let the Hindi tokenizer silently discard a Latin project name or ID.
const small = ('शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस ' +
  'बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस ' +
  'चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ ' +
  'साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्नासी ' +
  'अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सतासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पंचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे').split(' ');
const letters = 'ए बी सी डी ई एफ जी एच आई जे के एल एम एन ओ पी क्यू आर एस टी यू वी डब्ल्यू एक्स वाई ज़ेड'.split(' ');
const enDigits = 'zero one two three four five six seven eight nine'.split(' ');
const words = new Map(Object.entries({ one: 'वन', two: 'टू', three: 'थ्री', four: 'फ़ोर', five: 'फ़ाइव', project: 'प्रोजेक्ट' }));
const spellDigits = (s, names) => [...s].map((d) => names[Number(d)]).join(' ');
function count(n) {
  if (n < 100) return small[n];
  const [scale, name] = [[1e7, 'करोड़'], [1e5, 'लाख'], [1e3, 'हज़ार'], [100, 'सौ']].find(([v]) => n >= v);
  return count(Math.floor(n / scale)) + ' ' + name + (n % scale ? ' ' + count(n % scale) : '');
}
// Approximate pronunciation of Devanagari names embedded in English replies.
const consonants = 'k kh g gh ng ch chh j jh ny t th d dh n t th d dh n n p ph b bh m y r r l l l v sh sh s h'.split(' ');
const vowels = { अ: 'a', आ: 'aa', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo', ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au', ऑ: 'o',
  'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e', '्': '' };
function romanName(word) {
  let out = '', consonant = false;
  for (const ch of word.normalize('NFD')) {
    if (ch === '़') continue;
    const c = consonants[ch.charCodeAt(0) - 0x915];
    if (c) { out += (consonant ? 'a' : '') + c; consonant = true; }
    else { out += vowels[ch] ?? (ch === 'ं' || ch === 'ँ' ? (consonant ? 'an' : 'n') : ''); consonant = false; }
  }
  return out;
}
export function spokenText(text, language, transliterate) {
  let s = String(text).normalize('NFC').replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)))
    .replace(/\d{1,3}(?:,\d{2})*(?:,\d{3})+\b/g, (n) => n.replaceAll(',', ''))
    .replace(/(^|[\s(])[-−](?=\d)/g, language === 'hi' ? '$1ऋण ' : '$1minus ');
  if (language === 'en') return s.replace(/[\u0900-\u0963]+/g, romanName).replace(/\b[A-Z]{2,5}\b/g, (w) => [...w].join(' '))
    .replace(/\d+(?:\.\d+)?/g, (n) => {
      const [whole, frac] = n.split('.');
      return /^(?:0\d|\d{13})/.test(whole) ? ' ' + spellDigits(whole, enDigits) + (frac ? ' point ' + spellDigits(frac, enDigits) : '') + ' ' : n;
    });
  s = s.replace(/₹\s*(\d+(?:\.\d+)?)/g, '$1 रुपये').replaceAll('%', ' प्रतिशत ').replaceAll('&', ' और ')
    .replace(/\d+(?:\.\d+)?/g, (n) => {
      const [whole, fraction] = n.split('.');
      const first = /^(?:0\d|\d{10})/.test(whole) ? spellDigits(whole, small) : count(Number(whole));
      return ' ' + first + (fraction ? ' दशमलव ' + spellDigits(fraction, small) : '') + ' ';
    });
  return s.replace(/[A-Za-z]+/g, (w) => {
    if (/^[A-Z]{1,5}$/.test(w)) return [...w].map((c) => letters[c.charCodeAt(0) - 65]).join(' ');
    const dev = words.get(w.toLowerCase()) || transliterate(w);
    return /a$/i.test(w) && /[क-ह]$/.test(dev) ? dev + 'ा' : dev;
  }).replace(/\s+/g, ' ').trim();
}

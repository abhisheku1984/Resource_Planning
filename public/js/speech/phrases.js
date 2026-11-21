// Split after text normalization: a number or ID can expand into many words.
// Prefer complete sentences. Never drop the unspoken tail of a long report.
export function phrases(text, limit) {
  const parts = []; let part = '';
  for (let word of text.trim().split(/\s+/u)) {
    if (part && part.length + word.length + 1 > limit) { parts.push(part); part = ''; }
    while (word.length > limit) {
      const n = /[\uD800-\uDBFF]/.test(word[limit - 1]) ? limit - 1 : limit;
      parts.push(word.slice(0, n)); word = word.slice(n);
    }
    part = part ? part + ' ' + word : word;
    if (/[.?!।॥]$/.test(part)) { parts.push(part); part = ''; }
  }
  if (part) parts.push(part);
  return parts;
}

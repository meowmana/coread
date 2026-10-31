// Match an annotation quote against the book text: exact → trimmed → nearby paragraphs →
// curly/straight quote & full/half-width folding → unique hit anywhere in the book.
// Folding is a 1:1 character swap, so offsets map straight back to the original text.

const FOLD = {
  '“': '"', '”': '"', '„': '"', '「': '"', '」': '"', '『': '"', '』': '"', '＂': '"',
  '‘': "'", '’': "'", '＇': "'",
  '，': ',', '：': ':', '；': ';', '！': '!', '？': '?', '（': '(', '）': ')',
  '　': ' ', ' ': ' ',
};
const fold = s => s.replace(/[“”„「」『』＂‘’＇，：；！？（）　 ]/g, c => FOLD[c]);

function findAll(t, q) {
  const out = [];
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) out.push(i);
  return out;
}

export function matchQuote(db, bookId, paraIdx, quote, span = 2) {
  const rows = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx BETWEEN ? AND ? ORDER BY idx')
    .all(bookId, paraIdx - span, paraIdx + span);
  const paras = new Map(rows.map(r => [r.idx, r.content]));
  const own = paras.get(paraIdx);
  if (own == null) return { ok: false, reason: `paragraph ${paraIdx} does not exist in this book` };
  const hit = (k, i, len, note) => {
    const t = paras.get(k);
    return { ok: true, paragraph_idx: k, start: i, end: i + len, text: t.slice(i, i + len), note };
  };

  const i0 = own.indexOf(quote);
  if (i0 >= 0) return hit(paraIdx, i0, quote.length);
  const q = quote.trim();
  if (!q) return { ok: false, reason: 'selected_text is empty' };
  const order = [paraIdx];
  for (let d = 1; d <= span; d++) for (const k of [paraIdx + d, paraIdx - d]) if (paras.has(k)) order.push(k);

  for (const k of order) {
    const h = findAll(paras.get(k), q);
    if (h.length) return hit(k, h[0], q.length, k === paraIdx ? undefined : `quote found in paragraph ${k}, moved there`);
  }
  const fq = fold(q);
  for (const k of order) {
    const h = findAll(fold(paras.get(k)), fq);
    if (h.length === 1 || (h.length && k === paraIdx)) {
      return hit(k, h[0], q.length, 'quotes/punctuation differed from the book; replaced with the original'
        + (k === paraIdx ? '' : `; quote found in paragraph ${k}, moved there`));
    }
  }
  if (q.length >= 6) {
    const far = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND instr(content, ?) > 0 LIMIT 2').all(bookId, q);
    if (far.length === 1) {
      paras.set(far[0].idx, far[0].content);
      return hit(far[0].idx, far[0].content.indexOf(q), q.length, `quote found in paragraph ${far[0].idx} (not ${paraIdx}), moved there`);
    }
    if (far.length > 1) return { ok: false, reason: 'the quote appears several times in the book; give the exact paragraph_idx' };
  }
  return {
    ok: false,
    reason: 'selected_text is not in the book text. Copy a continuous span verbatim from the paragraph below (no paraphrasing, no stitched dialogue, no crossing paragraphs)',
    paragraph: own,
  };
}

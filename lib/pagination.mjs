const CHAPTER_RE = /^第[\d一二三四五六七八九十百千万]+[章节回]|^#|^Chapter\s+\d/i;

export const BOOK_PER_PAGE = 28;
const CONFIG_PREFIX = 'browser_pagination_v1:';

function configKey(bookId) {
  return `${CONFIG_PREFIX}${Number(bookId)}`;
}

export function computePageBreaks(db, bookId, perPage = BOOK_PER_PAGE, charsPerLine = 22) {
  const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(bookId);
  const pages = [];
  let cur = [];
  let curWeight = 0;
  const maxWeight = perPage;
  for (const p of paras) {
    if (CHAPTER_RE.test(p.content.trim().substring(0, 60)) && cur.length > 0) {
      pages.push(cur);
      cur = [];
      curWeight = 0;
    }
    const lines = Math.max(1, Math.ceil(p.content.length / charsPerLine));
    if (curWeight + lines > maxWeight && cur.length > 0) {
      pages.push(cur);
      cur = [];
      curWeight = 0;
    }
    cur.push(p.idx);
    curWeight += lines;
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

function parseStoredPagination(value, expectedParagraphCount) {
  try {
    const parsed = JSON.parse(value);
    if (parsed?.version !== 1 || !Array.isArray(parsed.paragraph_ids) || !Array.isArray(parsed.breaks)) return null;
    if (parsed.paragraph_ids.length === 0 || parsed.breaks.length === 0) return null;
    if (Number(parsed.source_paragraph_count) !== Number(expectedParagraphCount)) return null;

    const ids = parsed.paragraph_ids.map(Number);
    if (ids.some((id, i) => !Number.isInteger(id) || id < 0 || (i > 0 && id <= ids[i - 1]))) return null;
    const positions = new Map(ids.map((id, i) => [id, i]));
    const breaks = parsed.breaks.map(b => ({ paragraph_idx: Number(b.paragraph_idx), offset: Number(b.offset) || 0 }));
    if (breaks.some(b => !Number.isInteger(b.paragraph_idx) || !positions.has(b.paragraph_idx) || !Number.isInteger(b.offset) || b.offset < 0)) return null;
    if (breaks[0].paragraph_idx !== ids[0] || breaks[0].offset !== 0) return null;
    for (let i = 1; i < breaks.length; i++) {
      const prev = breaks[i - 1];
      const cur = breaks[i];
      const prevPos = positions.get(prev.paragraph_idx);
      const curPos = positions.get(cur.paragraph_idx);
      if (curPos < prevPos || (curPos === prevPos && cur.offset <= prev.offset)) return null;
    }
    return { ...parsed, paragraph_ids: ids, breaks };
  } catch {
    return null;
  }
}

export function getBrowserPagination(db, bookId) {
  const book = db.prepare('SELECT total_paragraphs FROM books WHERE id = ?').get(bookId);
  if (!book) return null;
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(configKey(bookId));
  return row?.value ? parseStoredPagination(row.value, book.total_paragraphs) : null;
}

export function saveBrowserPagination(db, bookId, payload) {
  const book = db.prepare('SELECT total_paragraphs FROM books WHERE id = ?').get(bookId);
  if (!book) throw new Error('book not found');

  const candidate = {
    version: 1,
    source_paragraph_count: Number(payload?.source_paragraph_count),
    paragraph_ids: payload?.paragraph_ids,
    breaks: payload?.breaks,
    viewport: {
      width: Number(payload?.viewport?.width) || 0,
      height: Number(payload?.viewport?.height) || 0,
      font_size: Number(payload?.viewport?.font_size) || 0,
    },
    updated_at: new Date().toISOString(),
  };
  const normalized = parseStoredPagination(JSON.stringify(candidate), book.total_paragraphs);
  if (!normalized) throw new Error('invalid browser pagination');

  const known = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(bookId);
  // Browser offsets use JavaScript UTF-16 positions, so validation must use the
  // same string length semantics (SQLite length() counts Unicode code points).
  const lengths = new Map(known.map(p => [Number(p.idx), String(p.content).length]));
  if (normalized.paragraph_ids.some(id => !lengths.has(id))) throw new Error('pagination references an unknown paragraph');
  if (normalized.breaks.some(b => b.offset > lengths.get(b.paragraph_idx))) throw new Error('pagination offset exceeds paragraph length');

  db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(configKey(bookId), JSON.stringify(normalized));
  return normalized;
}

export function clearBrowserPagination(db, bookId) {
  db.prepare('DELETE FROM config WHERE key = ?').run(configKey(bookId));
}

export function resolvePagination(db, bookId) {
  const browser = getBrowserPagination(db, bookId);
  if (browser) {
    return {
      source: 'browser',
      totalPages: browser.breaks.length,
      paragraphIds: browser.paragraph_ids,
      breaks: browser.breaks,
      viewport: browser.viewport,
      updatedAt: browser.updated_at,
    };
  }
  const pages = computePageBreaks(db, bookId, BOOK_PER_PAGE);
  return { source: 'fallback', totalPages: pages.length || 1, pages };
}

export function displayPageForParagraph(pagination, paragraphIdx, offset = 0) {
  const target = Number(paragraphIdx);
  if (!Number.isInteger(target) || target < 0) return null;
  if (pagination.source === 'browser') {
    let lo = 0;
    let hi = pagination.breaks.length - 1;
    let answer = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = pagination.breaks[mid];
      if (b.paragraph_idx < target || (b.paragraph_idx === target && b.offset <= offset)) {
        answer = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return answer + 1;
  }
  for (let i = 0; i < pagination.pages.length; i++) {
    if (pagination.pages[i].includes(target)) return i + 1;
    if (pagination.pages[i].some(idx => idx > target)) return Math.max(1, i + 1);
  }
  return pagination.totalPages;
}

export function paragraphForDisplayPage(pagination, page) {
  return positionForDisplayPage(pagination, page)?.paragraph_idx ?? null;
}

export function positionForDisplayPage(pagination, page) {
  const p = Math.max(1, Math.min(Number(page) || 1, pagination.totalPages));
  if (pagination.source === 'browser') return pagination.breaks[p - 1] || null;
  const paragraphIdx = pagination.pages[p - 1]?.[0];
  return paragraphIdx == null ? null : { paragraph_idx: paragraphIdx, offset: 0 };
}

export function getPageFragments(db, bookId, pagination, page) {
  const p = Math.max(1, Math.min(Number(page) || 1, pagination.totalPages));
  if (pagination.source === 'fallback') {
    const ids = pagination.pages[p - 1] || [];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT idx, content, 0 AS start_offset, length(content) AS end_offset FROM book_paragraphs WHERE book_id = ? AND idx IN (${placeholders}) ORDER BY idx`).all(bookId, ...ids);
  }

  const start = pagination.breaks[p - 1];
  const end = p < pagination.totalPages ? pagination.breaks[p] : null;
  const positions = new Map(pagination.paragraphIds.map((id, i) => [id, i]));
  const startPos = positions.get(start.paragraph_idx);
  const endPos = end ? positions.get(end.paragraph_idx) : pagination.paragraphIds.length;
  if (startPos == null || endPos == null) return [];
  const exclusive = end && end.offset > 0 ? endPos + 1 : endPos;
  const ids = pagination.paragraphIds.slice(startPos, exclusive);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx IN (${placeholders}) ORDER BY idx`).all(bookId, ...ids);
  return rows.map(row => {
    const startOffset = row.idx === start.paragraph_idx ? start.offset : 0;
    const endOffset = end && row.idx === end.paragraph_idx ? end.offset : row.content.length;
    return { ...row, content: row.content.slice(startOffset, endOffset), start_offset: startOffset, end_offset: endOffset };
  }).filter(row => row.end_offset > row.start_offset);
}

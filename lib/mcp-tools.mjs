import { getDb, getImageDir } from './db.mjs';
import { parseEpub, extractImages, extractCover, smartSplit } from './epub.mjs';
import { computePageBreaks, BOOK_PER_PAGE } from './routes.mjs';
import { isValidDate, calculateStreaks, mergeReadingBooks } from './reading-stats.mjs';
import fs from 'fs';
import path from 'path';

const CHAPTER_RE = /^第[\d一二三四五六七八九十百千万]+[章节回]|^#|^Chapter\s+\d/i;

const ROOM_LOCK_PATH = '/home/admin/.sullyos/reading-room-lock.json';
function roomLocked() {
  try { return !!JSON.parse(fs.readFileSync(ROOM_LOCK_PATH, 'utf8')).locked; } catch { return false; }
}
const DOOR_CLOSED = { error: 'door_locked', message: '🔒 共读室关门了（彤宝落的锁）。门只有彤宝能开——想读书去群里跟她求情，别自己想办法开门。' };
const GATED_TOOLS = new Set(['read_book', 'add_comment', 'update_progress', 'import_book', 'get_reading_stats', 'add_reading_note']);

export const tools = [
  {
    name: 'list_books',
    description: 'List all books in the co-reading library',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_book',
    description: 'Read a section of a book by page number',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
        page: { type: 'number', description: 'Page number (default 1)' },
        per_page: { type: 'number', description: 'Deprecated/ignored: pagination is unified server-side (BOOK_PER_PAGE)' },
      },
      required: ['book_id'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment/annotation to a paragraph in a book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
        paragraph_idx: { type: 'number', description: 'Paragraph index to comment on' },
        content: { type: 'string', description: 'Comment text' },
        from_who: { type: 'string', description: 'Who is commenting (default: "ai")' },
        selected_text: { type: 'string', description: 'Optional: highlighted text from the paragraph' },
        reply_to: { type: 'number', description: 'Optional: comment ID to reply to' },
      },
      required: ['book_id', 'paragraph_idx', 'content'],
    },
  },
  {
    name: 'list_comments',
    description: 'List all comments for a book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
      },
      required: ['book_id'],
    },
  },
  {
    name: 'get_toc',
    description: 'Get the table of contents for a book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
      },
      required: ['book_id'],
    },
  },
  {
    name: 'import_book',
    description: 'Import a book from text content or epub (base64)',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Book title' },
        content: { type: 'string', description: 'Plain text content (for text import)' },
        format: { type: 'string', description: '"epub" for epub import' },
        data: { type: 'string', description: 'Base64-encoded epub file data' },
      },
      required: ['title'],
    },
  },
  {
    name: 'delete_comment',
    description: 'Delete a comment by ID',
    inputSchema: {
      type: 'object',
      properties: { comment_id: { type: 'number', description: 'Comment ID to delete' } },
      required: ['comment_id'],
    },
  },
  {
    name: 'update_progress',
    description: 'Update reading progress for a book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
        page: { type: 'number', description: 'Current page number' },
      },
      required: ['book_id', 'page'],
    },
  },
  {
    name: 'get_reading_stats',
    description: 'Read the human reader’s daily time, streaks, finished books, and notes on their reading record',
    inputSchema: {
      type: 'object',
      properties: {
        today: { type: 'string', description: 'Reader local date in YYYY-MM-DD format; used to calculate the current streak' },
        book_id: { type: 'number', description: 'Optional book ID to limit book totals and notes' },
      },
      required: ['today'],
    },
  },
  {
    name: 'add_reading_note',
    description: 'Add an AI note to the overall reading record, a particular book, a particular date, or both',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note text' },
        book_id: { type: 'number', description: 'Optional book ID' },
        reading_date: { type: 'string', description: 'Optional reader local date in YYYY-MM-DD format' },
        from_who: { type: 'string', description: 'Note author (default: ai)' },
      },
      required: ['content'],
    },
  },
];

export function handleTool(name, args) {
  if (GATED_TOOLS.has(name) && roomLocked()) return DOOR_CLOSED;
  switch (name) {
    case 'list_books': {
      const db = getDb(true);
      const books = db.prepare('SELECT b.id, b.title, b.total_paragraphs, b.created_at, b.cover_image, p.page as current_page FROM books b LEFT JOIN book_progress p ON b.id = p.book_id ORDER BY b.created_at DESC').all();
      const counts = db.prepare('SELECT book_id, COUNT(*) as count FROM book_comments GROUP BY book_id').all();
      db.close();
      const countMap = {};
      for (const c of counts) countMap[c.book_id] = c.count;
      return books.map(b => ({ ...b, comment_count: countMap[b.id] || 0 }));
    }
    case 'read_book': {
      const { book_id, page = 1 } = args;
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(book_id);
      if (!book) { db.close(); return { error: 'Book not found' }; }
      // 统一坐标制（移植自 Sully AS#72）：AI 与前端/后端共用同一套服务端分页，
      // per_page 参数不再解析，AI 看到的页码与批注页码一致
      const pages = computePageBreaks(db, book_id, BOOK_PER_PAGE);
      const totalPages = pages.length || 1;
      const p = Math.max(1, Math.min(page, totalPages));
      const pageIndices = pages[p - 1] || [];
      let pageParas = [];
      if (pageIndices.length > 0) {
        const placeholders = pageIndices.map(() => '?').join(',');
        pageParas = db.prepare(`SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx IN (${placeholders}) ORDER BY idx`).all(book_id, ...pageIndices);
      }
      const idxSet = new Set(pageParas.map(x => x.idx));
      const comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? ORDER BY paragraph_idx, created_at').all(book_id)
        .filter(c => idxSet.has(c.paragraph_idx));
      db.close();
      const text = pageParas.map(x => `[${x.idx}] ${x.content}`).join('\n\n');
      const commentText = comments.length ? '\n---\nComments on this page:\n' + comments.map(c => `  [${c.from_who}@${c.paragraph_idx}] ${c.selected_text ? `"${c.selected_text}" → ` : ''}${c.content}`).join('\n') : '';
      return { book: book.title, page: p, totalPages, text: text + commentText };
    }
    case 'add_comment': {
      const { book_id, paragraph_idx, content, from_who = 'ai', selected_text, reply_to } = args;
      const db = getDb();
      let startIdx = null, endIdx = null;
      if (selected_text) {
        const para = db.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = ?').get(book_id, paragraph_idx);
        if (para?.content) { const i = para.content.indexOf(selected_text); if (i >= 0) { startIdx = i; endIdx = i + selected_text.length; } }
      }
      const result = db.prepare('INSERT INTO book_comments (book_id, paragraph_idx, sel_start_idx, sel_end_idx, selected_text, from_who, content, reply_to) VALUES (?,?,?,?,?,?,?,?)').run(book_id, paragraph_idx, startIdx, endIdx, selected_text || null, from_who, content, reply_to || null);
      db.close();
      return { ok: true, id: Number(result.lastInsertRowid) };
    }
    case 'list_comments': {
      const { book_id } = args;
      const db = getDb(true);
      const comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? ORDER BY paragraph_idx, created_at').all(book_id);
      db.close();
      return comments;
    }
    case 'get_toc': {
      const { book_id } = args;
      const db = getDb(true);
      const paras = db.prepare('SELECT idx, substr(content, 1, 100) as content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(book_id);
      db.close();
      const chapters = [];
      for (const p of paras) {
        if (CHAPTER_RE.test(p.content.trim())) {
          chapters.push({ idx: p.idx, title: p.content.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 60) });
        }
      }
      return chapters;
    }
    case 'import_book': {
      const { title, content, format, data } = args;
      let paragraphs = [];
      let epubResult = null;
      if (format === 'epub' && data) { epubResult = parseEpub(data); paragraphs = epubResult.paragraphs; }
      else if (content) { paragraphs = smartSplit(content); }
      else return { error: 'content or epub data required' };
      if (!paragraphs.length) return { error: 'no paragraphs extracted' };
      const db = getDb();
      const r = db.prepare('INSERT INTO books (title, total_paragraphs) VALUES (?, ?)').run(title, paragraphs.length);
      const bookId = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO book_paragraphs (book_id, idx, content) VALUES (?, ?, ?)');
      db.transaction(() => { for (let i = 0; i < paragraphs.length; i++) ins.run(bookId, i, paragraphs[i]); })();
      db.close();
      if (epubResult) {
        const imgDir = getImageDir(bookId);
        const images = extractImages(epubResult.zip, epubResult.epubImageMap, paragraphs);
        for (const [fname, d] of images) fs.writeFileSync(path.join(imgDir, fname), d);
        const cover = extractCover(epubResult.zip, epubResult.epubCoverFile);
        if (cover) {
          fs.writeFileSync(path.join(imgDir, cover.name), cover.data);
          const db2 = getDb();
          db2.prepare('UPDATE books SET cover_image = ? WHERE id = ?').run(cover.name, bookId);
          db2.close();
        }
      }
      return { ok: true, book_id: bookId, paragraphs: paragraphs.length };
    }
    case 'delete_comment': {
      const db = getDb();
      db.prepare('DELETE FROM book_comments WHERE id = ?').run(args.comment_id);
      db.close();
      return { ok: true };
    }
    case 'update_progress': {
      const db = getDb();
      db.prepare("INSERT INTO book_progress (book_id, page, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(book_id) DO UPDATE SET page = ?, updated_at = datetime('now')").run(args.book_id, args.page, args.page);
      db.close();
      return { ok: true };
    }
    case 'get_reading_stats': {
      const today = String(args.today || '');
      if (!isValidDate(today)) return { error: 'today must use a valid YYYY-MM-DD date' };
      const bookId = args.book_id == null ? null : Number(args.book_id);
      const db = getDb(true);
      const daily = bookId == null
        ? db.prepare('SELECT reading_date, SUM(seconds) AS seconds FROM reading_daily GROUP BY reading_date ORDER BY reading_date DESC').all()
        : db.prepare('SELECT reading_date, seconds FROM reading_daily WHERE book_id = ? ORDER BY reading_date DESC').all(bookId);
      const bookTimes = bookId == null
        ? db.prepare(`SELECT d.book_id AS id, COALESCE(MAX(b.title), MAX(d.book_title), '已删除书籍') AS title, SUM(d.seconds) AS total_seconds, MAX(d.updated_at) AS last_read_at FROM reading_daily d LEFT JOIN books b ON b.id = d.book_id GROUP BY d.book_id`).all()
        : db.prepare(`SELECT d.book_id AS id, COALESCE(MAX(b.title), MAX(d.book_title), '已删除书籍') AS title, SUM(d.seconds) AS total_seconds, MAX(d.updated_at) AS last_read_at FROM reading_daily d LEFT JOIN books b ON b.id = d.book_id WHERE d.book_id = ? GROUP BY d.book_id`).all(bookId);
      const finishes = bookId == null
        ? db.prepare('SELECT book_id AS id, book_title AS title, finished_at FROM reading_finished').all()
        : db.prepare('SELECT book_id AS id, book_title AS title, finished_at FROM reading_finished WHERE book_id = ?').all(bookId);
      const notes = bookId == null
        ? db.prepare('SELECT n.*, COALESCE(b.title, n.book_title) AS book_title FROM reading_record_notes n LEFT JOIN books b ON b.id = n.book_id ORDER BY n.created_at DESC, n.id DESC').all()
        : db.prepare('SELECT n.*, COALESCE(b.title, n.book_title) AS book_title FROM reading_record_notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.book_id = ? ORDER BY n.created_at DESC, n.id DESC').all(bookId);
      db.close();
      const streak = calculateStreaks(daily, today);
      const books = mergeReadingBooks(bookTimes, finishes);
      return {
        today,
        today_seconds: Number(daily.find(x => x.reading_date === today)?.seconds || 0),
        total_seconds: daily.reduce((sum, x) => sum + Number(x.seconds || 0), 0),
        current_streak: streak.currentStreak,
        longest_streak: streak.longestStreak,
        reading_days: streak.readingDays,
        daily,
        books,
        notes,
      };
    }
    case 'add_reading_note': {
      const content = String(args.content || '').trim();
      const bookId = args.book_id == null ? null : Number(args.book_id);
      const readingDate = args.reading_date == null || args.reading_date === '' ? null : String(args.reading_date);
      if (!content) return { error: 'content required' };
      if (readingDate && !isValidDate(readingDate)) return { error: 'reading_date must use a valid YYYY-MM-DD date' };
      if (bookId != null && !Number.isInteger(bookId)) return { error: 'book_id must be an integer' };
      const db = getDb();
      let bookTitle = null;
      if (bookId != null) {
        const live = db.prepare('SELECT title FROM books WHERE id = ?').get(bookId);
        const finished = db.prepare('SELECT book_title AS title FROM reading_finished WHERE book_id = ?').get(bookId);
        const timed = db.prepare('SELECT book_title AS title FROM reading_daily WHERE book_id = ? AND book_title IS NOT NULL LIMIT 1').get(bookId);
        bookTitle = live?.title || finished?.title || timed?.title || null;
        if (!bookTitle) { db.close(); return { error: 'Book not found' }; }
      }
      const result = db.prepare('INSERT INTO reading_record_notes (book_id, book_title, reading_date, from_who, content) VALUES (?, ?, ?, ?, ?)').run(bookId, bookTitle, readingDate, String(args.from_who || 'ai'), content);
      db.close();
      return { ok: true, id: Number(result.lastInsertRowid) };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

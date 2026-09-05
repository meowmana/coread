import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getDb, getImageDir } from './db.mjs';
import { parseEpub, extractImages, extractCover, smartSplit } from './epub.mjs';
const require = createRequire(import.meta.url);

const CHAPTER_RE = /^第[\d一二三四五六七八九十百千万]+[章节回]|^#|^Chapter\s+\d/i;

// ─── 共读室关门锁（task-1786030476040-meb33p）───
// 与 bridge server / sullyos-bridge 工具共享同一把文件锁；开门要彤宝的 owner key。
const ROOM_LOCK_PATH = '/home/admin/.sullyos/reading-room-lock.json';
const ROOM_OWNER_KEY = process.env.ROOM_OWNER_KEY || 'xk-room-owner-f47ac10b58d2e619a3c4';
function readRoomLock() {
  try {
    const s = JSON.parse(fs.readFileSync(ROOM_LOCK_PATH, 'utf8'));
    return { locked: !!s.locked, at: s.at || null, note: typeof s.note === 'string' ? s.note : '' };
  } catch { return { locked: false, at: null, note: '' }; }
}
function roomGate(req, res) {
  if (!readRoomLock().locked) return false;
  if ((req.headers['x-owner-key'] || '') === ROOM_OWNER_KEY) return false;
  json(res, 423, { error: 'door_locked', message: '共读室已关门（彤宝落了锁），开门要彤宝来。' });
  return true;
}

// 统一坐标制（移植自 Sully AS#72）：全系统只保留这一套服务端分页，
// per_page 参数不再解析——前端/AI/批注页码共用同一坐标，不再各切各的页
export const BOOK_PER_PAGE = 28;

export function computePageBreaks(db, bookId, perPage, charsPerLine = 22) {
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

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-owner-key');
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('gbk').decode(buf); } catch {}
  return buf.toString('utf8');
}

export async function handleRequest(req, res, opts = {}) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }

  cors(res);
  const port = opts.port || 3000;

  // GET /v1/books
  if (req.method === 'GET' && req.url === '/v1/books') {
    try {
      const db = getDb(true);
      const books = db.prepare("SELECT b.id, b.title, b.total_paragraphs, b.created_at, b.cover_image, p.page as current_page, p.updated_at as last_read_at, p.last_opened_at as last_opened_at FROM books b LEFT JOIN book_progress p ON b.id = p.book_id ORDER BY MAX(COALESCE(p.last_opened_at, ''), b.created_at) DESC, b.id DESC").all();
      const commentCounts = db.prepare('SELECT book_id, COUNT(*) as count FROM book_comments GROUP BY book_id').all();
      db.close();
      const countMap = {};
      for (const c of commentCounts) countMap[c.book_id] = c.count;
      json(res, 200, { books: books.map(b => ({ ...b, comment_count: countMap[b.id] || 0 })) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/slice
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/slice/)) {
    if (roomGate(req, res)) return true;
    try {
      const urlObj = new URL(req.url, `http://localhost:${port}`);
      const id = parseInt(req.url.split('/')[3]);
      const start = parseInt(urlObj.searchParams.get('start') || '0');
      const count = parseInt(urlObj.searchParams.get('count') || '30');
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'not found' }); return true; }
      const paragraphs = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx >= ? ORDER BY idx LIMIT ?').all(id, start, count);
      const minIdx = paragraphs.length ? paragraphs[0].idx : start;
      const maxIdx = paragraphs.length ? paragraphs[paragraphs.length - 1].idx : start;
      const comments = paragraphs.length ? db.prepare('SELECT * FROM book_comments WHERE book_id = ? AND paragraph_idx BETWEEN ? AND ? ORDER BY paragraph_idx, created_at').all(id, minIdx, maxIdx) : [];
      db.close();
      json(res, 200, { book, paragraphs, comments, total: book.total_paragraphs });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+(\?|$)/)) {
    if (roomGate(req, res)) return true;
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const id = parseInt(url.pathname.split('/')[3]);
      const page = parseInt(url.searchParams.get('page') || '1');
      const perPage = BOOK_PER_PAGE; // 统一坐标制：per_page 参数不再解析（移植自 Sully AS#72）
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      const pages = computePageBreaks(db, id, perPage);
      const totalPages = pages.length || 1;
      const clampedPage = Math.max(1, Math.min(page, totalPages));
      const pageIndices = pages[clampedPage - 1] || [];
      let paragraphs = [];
      if (pageIndices.length > 0) {
        const placeholders = pageIndices.map(() => '?').join(',');
        paragraphs = db.prepare(`SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx IN (${placeholders}) ORDER BY idx`).all(id, ...pageIndices);
      }
      const comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? ORDER BY paragraph_idx, created_at').all(id);
      const progress = db.prepare('SELECT page FROM book_progress WHERE book_id = ?').get(id);
      db.close();
      json(res, 200, { book, paragraphs, comments, pagination: { page: clampedPage, perPage, totalPages, total: book.total_paragraphs }, progress: progress?.page || 1 });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // POST /v1/books/:id/comment
  if (req.method === 'POST' && req.url.match(/^\/v1\/books\/\d+\/comment$/)) {
    if (roomGate(req, res)) return true;
    try {
      const id = parseInt(req.url.split('/')[3]);
      const body = await readBody(req);
      const { paragraph_idx, selected_text, content, from_who, sel_start_idx, sel_end_idx, sel_end_para_idx, reply_to } = body;
      if (paragraph_idx === undefined || !content) { json(res, 400, { error: 'paragraph_idx and content required' }); return true; }
      const db = getDb();
      db.pragma('foreign_keys = OFF');
      const author = from_who || 'human';
      let startIdx = sel_start_idx ?? null, endIdx = sel_end_idx ?? null;
      if (selected_text && startIdx == null) {
        const para = db.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = ?').get(id, paragraph_idx);
        if (para?.content) {
          const i = para.content.indexOf(selected_text);
          if (i >= 0) { startIdx = i; endIdx = i + selected_text.length; }
        }
      }
      const result = db.prepare('INSERT INTO book_comments (book_id, paragraph_idx, sel_start_idx, sel_end_idx, sel_end_para_idx, selected_text, from_who, content, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, paragraph_idx, startIdx, endIdx, sel_end_para_idx ?? null, selected_text || null, author, content, reply_to ?? null);
      db.close();
      json(res, 200, { ok: true, id: Number(result.lastInsertRowid) });
      if (opts.onComment) opts.onComment({ book_id: id, from_who: author, content });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // DELETE /v1/books/comment/:id
  if (req.method === 'DELETE' && req.url.match(/^\/v1\/books\/comment\/\d+$/)) {
    try {
      const commentId = parseInt(req.url.split('/').pop());
      const db = getDb();
      db.prepare('DELETE FROM book_comments WHERE id = ?').run(commentId);
      db.close();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/new-replies
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/new-replies/)) {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const id = parseInt(req.url.split('/')[3]);
      const lastSeen = parseInt(urlObj.searchParams.get('since') || '0');
      const db = getDb(true);
      const replies = db.prepare(
        `SELECT c.id, c.paragraph_idx, c.content, c.created_at, c.reply_to,
                c.from_who, c.sel_start_idx, c.sel_end_idx, c.selected_text,
                p.content as parent_content, p.from_who as parent_from, p.id as parent_id
         FROM book_comments c
         LEFT JOIN book_comments p ON c.reply_to = p.id
         WHERE c.book_id = ? AND c.id > ?
         ORDER BY c.id DESC LIMIT 20`
      ).all(id, lastSeen);
      db.close();
      json(res, 200, { replies });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/reader-state
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/reader-state/)) {
    if (roomGate(req, res)) return true;
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const id = parseInt(req.url.split('/')[3]);
      const lastCommentId = parseInt(urlObj.searchParams.get('since') || '0');
      const db = getDb(true);
      const progress = db.prepare('SELECT page FROM book_progress WHERE book_id = ?').get(id);
      const position = progress?.page || 0;
      const around = 3;
      const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx >= ? AND idx < ? ORDER BY idx').all(id, Math.max(0, position - around), position + 10 + around);
      const newComments = db.prepare('SELECT id, paragraph_idx, from_who, content, reply_to, created_at FROM book_comments WHERE book_id = ? AND id > ? ORDER BY id').all(id, lastCommentId);
      const visibleComments = db.prepare('SELECT id, paragraph_idx, sel_start_idx, sel_end_idx, selected_text, from_who, content, reply_to, created_at FROM book_comments WHERE book_id = ? AND paragraph_idx >= ? AND paragraph_idx < ? ORDER BY paragraph_idx, created_at').all(id, Math.max(0, position), position + 10);
      db.close();
      json(res, 200, { position, paragraphs: paras, newComments, visibleComments });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // PATCH /v1/books/:id/progress
  if (req.method === 'PATCH' && req.url.match(/^\/v1\/books\/\d+\/progress$/)) {
    if (roomGate(req, res)) return true;
    try {
      const id = parseInt(req.url.split('/')[3]);
      const body = await readBody(req);
      const { page } = body;
      if (!page) { json(res, 400, { error: 'page required' }); return true; }
      const db = getDb();
      db.prepare("INSERT INTO book_progress (book_id, page, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(book_id) DO UPDATE SET page = ?, updated_at = datetime('now')").run(id, page, page);
      db.close();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // POST /v1/books/:id/open — 只写last_opened_at，不动page/updated_at，没读过的书不伪造进度
  if (req.method === 'POST' && req.url.match(/^\/v1\/books\/\d+\/open$/)) {
    if (roomGate(req, res)) return true;
    try {
      const id = parseInt(req.url.split('/')[3]);
      const db = getDb();
      db.prepare("INSERT INTO book_progress (book_id, page, last_opened_at) VALUES (?, NULL, datetime('now')) ON CONFLICT(book_id) DO UPDATE SET last_opened_at = datetime('now')").run(id);
      db.close();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // POST /v1/books — create book
  // 两种形态：JSON {title, content|data:base64}（旧客户端兼容）；
  // 二进制 Content-Type: application/octet-stream，body=文件原始字节，title/format走query
  if (req.method === 'POST' && (req.url === '/v1/books' || req.url.startsWith('/v1/books?'))) {
    if (roomGate(req, res)) return true;
    try {
      let title, content, format, fileBuf = null;
      if (String(req.headers['content-type'] || '').startsWith('application/octet-stream')) {
        const q = new URL(req.url, `http://localhost:${port}`).searchParams;
        title = q.get('title') || '';
        format = (q.get('format') || '').toLowerCase();
        fileBuf = await readRawBody(req);
        if (!fileBuf.length) { json(res, 400, { error: 'empty file body' }); return true; }
      } else {
        const body = await readBody(req);
        title = body.title; content = body.content; format = body.format;
        if (body.data) fileBuf = Buffer.from(body.data, 'base64');
      }
      if (!title) { json(res, 400, { error: 'title required' }); return true; }

      let paragraphs = [];
      let epubResult = null;

      if (format === 'epub' && fileBuf) {
        epubResult = parseEpub(fileBuf);
        paragraphs = epubResult.paragraphs;
      } else if (content || (fileBuf && format !== 'pdf')) {
        paragraphs = smartSplit(content || decodeText(fileBuf));
      } else {
        json(res, 400, { error: 'content or epub data required' }); return true;
      }

      if (paragraphs.length === 0) { json(res, 400, { error: 'no paragraphs extracted' }); return true; }

      const db = getDb();
      const bookResult = db.prepare('INSERT INTO books (title, total_paragraphs) VALUES (?, ?)').run(title, paragraphs.length);
      const bookId = Number(bookResult.lastInsertRowid);
      const ins = db.prepare('INSERT INTO book_paragraphs (book_id, idx, content) VALUES (?, ?, ?)');
      db.transaction(() => { for (let i = 0; i < paragraphs.length; i++) ins.run(bookId, i, paragraphs[i]); })();
      db.close();

      if (epubResult) {
        const imgDir = getImageDir(bookId);
        const images = extractImages(epubResult.zip, epubResult.epubImageMap, paragraphs);
        for (const [fname, data] of images) {
          fs.writeFileSync(path.join(imgDir, fname), data);
        }
        const cover = extractCover(epubResult.zip, epubResult.epubCoverFile);
        if (cover) {
          fs.writeFileSync(path.join(imgDir, cover.name), cover.data);
          const db2 = getDb();
          db2.prepare('UPDATE books SET cover_image = ? WHERE id = ?').run(cover.name, bookId);
          db2.close();
        }
      }

      json(res, 201, { ok: true, book_id: bookId, title, paragraphs: paragraphs.length });
    } catch (e) {
      console.error('Book create error:', e);
      json(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /v1/books/:id/toc
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/toc/)) {
    try {
      const id = parseInt(req.url.split('/')[3]);
      const urlObj = new URL(req.url, 'http://localhost');
      const perPage = BOOK_PER_PAGE; // 统一坐标制：目录页码与正文同一坐标
      const db = getDb(true);
      const pages = computePageBreaks(db, id, perPage);
      const idxToPage = {};
      for (let i = 0; i < pages.length; i++) {
        for (const idx of pages[i]) idxToPage[idx] = i + 1;
      }
      const paras = db.prepare('SELECT idx, substr(content, 1, 100) as content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(id);
      db.close();
      const chapters = [];
      for (const p of paras) {
        if (CHAPTER_RE.test(p.content.trim())) {
          const title = p.content.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 60);
          chapters.push({ idx: p.idx, page: idxToPage[p.idx] || 1, title });
        }
      }
      json(res, 200, { chapters, totalPages: pages.length });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/export
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/export/)) {
    if (roomGate(req, res)) return true;
    try {
      const urlObj = new URL(req.url, `http://localhost:${port}`);
      const id = parseInt(urlObj.pathname.split('/')[3]);
      const format = urlObj.searchParams.get('format') || 'epub';
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(id);
      const comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? ORDER BY paragraph_idx, sel_start_idx, created_at').all(id);
      db.close();

      const commentsByPara = {};
      for (const c of comments) {
        if (!commentsByPara[c.paragraph_idx]) commentsByPara[c.paragraph_idx] = [];
        commentsByPara[c.paragraph_idx].push(c);
      }

      if (format === 'md') {
        let md = `# ${book.title}\n\n`;
        for (const para of paras) {
          md += para.content + '\n\n';
          const pComments = commentsByPara[para.idx];
          if (pComments?.length) {
            for (const c of pComments) {
              if (c.selected_text) md += `> **${c.from_who}** highlighted "${c.selected_text}": ${c.content}\n>\n`;
              else md += `> **${c.from_who}**: ${c.content}\n>\n`;
            }
            md += '\n';
          }
        }
        cors(res);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(book.title)}.md"` });
        res.end(md);
        return true;
      }

      // EPUB export
      const { ZipArchive } = require('archiver');
      const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const epubId = `book-${id}-${Date.now()}`;
      const chapterRe = /^第[\d一二三四五六七八九十百千万]+[章节回]|^#|^Chapter\s+\d/i;
      const chapters = [];
      let curChapter = { title: book.title, paras: [] };
      for (const p of paras) {
        const t = p.content.trim();
        if (chapterRe.test(t) && curChapter.paras.length > 0) {
          chapters.push(curChapter);
          curChapter = { title: t.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80), paras: [] };
        }
        curChapter.paras.push(p);
      }
      if (curChapter.paras.length > 0) chapters.push(curChapter);

      const style = `body{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",serif;line-height:1.85;color:#333;margin:1em}h1{text-align:center;font-size:1.4em;margin:2em 0 1em;color:#222}p{text-indent:1.5em;margin:.6em 0}.ann{background:#f8f0f0;border-left:3px solid #d4a0a0;border-radius:8px;padding:8px 12px;margin:8px 0;font-size:.9em}.ann-author{font-weight:bold;color:#8b6b6b}.ann-quote{font-style:italic;color:#888;margin-bottom:4px}`;

      const imgDir = getImageDir(id);
      const exportImages = new Map();
      try {
        for (const f of fs.readdirSync(imgDir)) exportImages.set(f, fs.readFileSync(path.join(imgDir, f)));
      } catch {}

      const buildChapterXhtml = (ch, idx) => {
        let body = '';
        if (idx > 0 || chapterRe.test(ch.paras[0]?.content?.trim() || '')) body += `<h1>${esc(ch.title)}</h1>\n`;
        for (const p of ch.paras) {
          const t = p.content.trim();
          const imgMatch = t.match(/^\[IMG:([^\]]+)\]$/);
          if (imgMatch) { body += `<div style="text-align:center;margin:1em 0"><img src="images/${esc(imgMatch[1])}" style="max-width:100%"/></div>\n`; continue; }
          if (chapterRe.test(t) && body.includes('</h1>')) {} else {
            const isH = t.startsWith('#');
            const display = t.replace(/^#+\s*/, '');
            if (isH) body += `<h1>${esc(display)}</h1>\n`;
            else body += `<p>${display.replace(/\[IMG:([^\]]+)\]/g, (_, f) => `</p><div style="text-align:center;margin:1em 0"><img src="images/${esc(f)}" style="max-width:100%"/></div><p>`)}</p>\n`;
          }
          const pComments = commentsByPara[p.idx];
          if (pComments?.length) {
            for (const c of pComments) {
              body += `<div class="ann">`;
              if (c.selected_text) body += `<div class="ann-quote">"${esc(c.selected_text.slice(0, 200))}"</div>`;
              body += `<span class="ann-author">${esc(c.from_who)}</span>: ${esc(c.content)}</div>\n`;
            }
          }
        }
        return `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><meta charset="utf-8"/><title>${esc(ch.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
      };

      let manifest = '', spine = '', navPoints = '';
      for (let i = 0; i < chapters.length; i++) {
        manifest += `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>\n`;
        spine += `<itemref idref="ch${i}"/>\n`;
        navPoints += `<navPoint id="nav${i}" playOrder="${i+1}"><navLabel><text>${esc(chapters[i].title)}</text></navLabel><content src="ch${i}.xhtml"/></navPoint>\n`;
      }

      const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
      let imgManifest = '', coverMeta = '';
      let imgIdx = 0;
      for (const [fname] of exportImages) {
        const ext = fname.split('.').pop().toLowerCase();
        const mime = mimeTypes[ext] || 'image/jpeg';
        const imgId = `img${imgIdx++}`;
        imgManifest += `<item id="${imgId}" href="images/${esc(fname)}" media-type="${mime}"${fname.startsWith('cover.') ? ' properties="cover-image"' : ''}/>\n`;
        if (fname.startsWith('cover.')) coverMeta = `<meta name="cover" content="${imgId}"/>`;
      }

      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Disposition': `attachment; filename="${encodeURIComponent(book.title)}.epub"` });
      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.pipe(res);
      archive.append('application/epub+zip', { name: 'mimetype', store: true });
      archive.append(`<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, { name: 'META-INF/container.xml' });
      archive.append(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(book.title)}</dc:title><dc:language>zh</dc:language><dc:identifier id="bookid">${epubId}</dc:identifier><dc:creator>coread</dc:creator>${coverMeta}</metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${manifest}${imgManifest}</manifest><spine toc="ncx">${spine}</spine></package>`, { name: 'OEBPS/content.opf' });
      archive.append(`<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${epubId}"/></head><docTitle><text>${esc(book.title)}</text></docTitle><navMap>${navPoints}</navMap></ncx>`, { name: 'OEBPS/toc.ncx' });
      archive.append(style, { name: 'OEBPS/style.css' });
      for (let i = 0; i < chapters.length; i++) archive.append(buildChapterXhtml(chapters[i], i), { name: `OEBPS/ch${i}.xhtml` });
      for (const [fname, data] of exportImages) archive.append(data, { name: `OEBPS/images/${fname}` });
      archive.finalize();
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // DELETE /v1/books/:id
  if (req.method === 'DELETE' && req.url.match(/^\/v1\/books\/\d+$/)) {
    try {
      const id = parseInt(req.url.split('/')[3]);
      const db = getDb();
      const book = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      db.prepare('DELETE FROM book_comments WHERE book_id = ?').run(id);
      db.prepare('DELETE FROM book_paragraphs WHERE book_id = ?').run(id);
      db.prepare('DELETE FROM book_progress WHERE book_id = ?').run(id);
      db.prepare('DELETE FROM books WHERE id = ?').run(id);
      db.close();
      json(res, 200, { ok: true, deleted: id });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/book-images/:bookId/:filename
  const imgMatch = req.url?.match(/^\/v1\/book-images\/(\d+)\/(.+)$/);
  if (req.method === 'GET' && imgMatch) {
    const imgPath = path.join(getImageDir(parseInt(imgMatch[1])), decodeURIComponent(imgMatch[2]));
    try {
      const data = fs.readFileSync(imgPath);
      const ext = path.extname(imgPath).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      cors(res);
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
    return true;
  }

  return false;
}

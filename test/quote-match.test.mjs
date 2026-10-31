import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { initDb, getDb } from '../lib/db.mjs';
import { handleRequest } from '../lib/routes.mjs';
import { handleTool } from '../lib/mcp-tools.mjs';

const PARAS = [
  '第一段，什么也没有。',
  '鼻涕虫也可以在墙上撞碎自己的身体，哪怕只是在墙上轻轻地打出“啪”的一声。',
  '她说：「你绝对不会撒谎，但你会选择不说。」',
  '我们这些听众就是聋子。',
  '第五段。',
  '第六段。',
  '第七段，每次描述一座城市时，我其实都会讲一些关于威尼斯的事。',
];

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-quote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initDb(path.join(dir, 'coread.db'));
  const db = getDb();
  const bookId = Number(db.prepare('INSERT INTO books (title) VALUES (?)').run('测试书').lastInsertRowid);
  const ins = db.prepare('INSERT INTO book_paragraphs (book_id, idx, content) VALUES (?, ?, ?)');
  PARAS.forEach((c, i) => ins.run(bookId, i, c));
  db.close();
  return bookId;
}

const row = id => { const db = getDb(true); const r = db.prepare('SELECT * FROM book_comments WHERE id = ?').get(id); db.close(); return r; };
const highlighted = r => PARAS[r.paragraph_idx].slice(r.sel_start_idx, r.sel_end_idx);

test('add_comment repairs straight quotes, wrong paragraphs and far-off paragraphs', (t) => {
  const bookId = setup(t);

  const quotes = handleTool('add_comment', { book_id: bookId, paragraph_idx: 1, content: 'a', selected_text: '轻轻地打出"啪"的一声' });
  assert.equal(quotes.ok, true);
  assert.equal(highlighted(row(quotes.id)), '轻轻地打出“啪”的一声');

  const near = handleTool('add_comment', { book_id: bookId, paragraph_idx: 1, content: 'b', selected_text: '你绝对不会撒谎' });
  assert.equal(near.ok, true);
  assert.equal(row(near.id).paragraph_idx, 2);

  const far = handleTool('add_comment', { book_id: bookId, paragraph_idx: 0, content: 'c', selected_text: '每次描述一座城市时' });
  assert.equal(far.ok, true);
  assert.equal(row(far.id).paragraph_idx, 6);
  assert.equal(highlighted(row(far.id)), '每次描述一座城市时');
});

test('add_comment rejects a typo and hands back the paragraph', (t) => {
  const bookId = setup(t);
  const r = handleTool('add_comment', { book_id: bookId, paragraph_idx: 3, content: 'x', selected_text: '我们这些听众就是聋的' });
  assert.equal(r.ok, false);
  assert.equal(r.paragraph, PARAS[3]);
  const db = getDb(true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_comments').get().n, 0);
  db.close();
});

test('comment route keeps explicit selections and fixes quote-only ones', async (t) => {
  const bookId = setup(t);
  const post = async body => {
    const req = Readable.from([JSON.stringify(body)]);
    Object.assign(req, { method: 'POST', url: `/v1/books/${bookId}/comment`, headers: {} });
    const res = { status: null, body: '', setHeader() {}, writeHead(s) { this.status = s; }, end(b = '') { this.body = String(b); } };
    await handleRequest(req, res);
    return { status: res.status, body: JSON.parse(res.body) };
  };

  const manual = await post({ paragraph_idx: 3, content: 'm', selected_text: '随便', sel_start_idx: 0, sel_end_idx: 2 });
  assert.equal(manual.status, 200);
  assert.equal(row(manual.body.id).sel_start_idx, 0);

  const fixed = await post({ paragraph_idx: 1, content: 'f', selected_text: '"啪"的一声' });
  assert.equal(fixed.status, 200);
  assert.equal(highlighted(row(fixed.body.id)), '“啪”的一声');

  const bad = await post({ paragraph_idx: 3, content: 'b', selected_text: '完全不存在的句子' });
  assert.equal(bad.status, 400);
});

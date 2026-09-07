import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { initDb, getDb } from '../lib/db.mjs';
import { handleTool } from '../lib/mcp-tools.mjs';
import { handleRequest } from '../lib/routes.mjs';

function makeRequest(url, body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = url;
  req.headers = {};
  return req;
}

function makeResponse() {
  return {
    status: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body = String(body); },
  };
}

test('MCP uses the browser page table and preserves paragraph offsets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-pagination-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initDb(path.join(dir, 'coread.db'));

  const db = getDb();
  const bookId = Number(db.prepare('INSERT INTO books (title, total_paragraphs) VALUES (?, ?)').run('分页测试', 4).lastInsertRowid);
  const insert = db.prepare('INSERT INTO book_paragraphs (book_id, idx, content) VALUES (?, ?, ?)');
  insert.run(bookId, 10, 'first');
  insert.run(bookId, 20, 'abcdefghij');
  insert.run(bookId, 30, 'third');
  insert.run(bookId, 40, 'last');
  db.close();

  const syncResponse = makeResponse();
  await handleRequest(makeRequest(`/v1/books/${bookId}/pagination`, {
    version: 1,
    source_paragraph_count: 4,
    paragraph_ids: [10, 20, 30, 40],
    breaks: [
      { paragraph_idx: 10, offset: 0 },
      { paragraph_idx: 20, offset: 3 },
      { paragraph_idx: 40, offset: 0 },
    ],
    viewport: { width: 360, height: 720, font_size: 16 },
  }), syncResponse);
  assert.equal(syncResponse.status, 200);
  assert.equal(JSON.parse(syncResponse.body).total_pages, 3);

  const updated = handleTool('update_progress', { book_id: bookId, page: 2 });
  assert.deepEqual(updated, {
    ok: true,
    page: 2,
    paragraph_idx: 20,
    paragraph_offset: 3,
    pagination_source: 'browser',
  });

  const [listed] = handleTool('list_books', {});
  assert.equal(listed.current_page, 2);
  assert.equal(listed.current_paragraph_idx, 20);
  assert.equal(listed.current_paragraph_offset, 3);
  assert.equal(listed.total_pages, 3);
  assert.equal(listed.pagination_source, 'browser');

  const read = handleTool('read_book', { book_id: bookId, page: 2 });
  assert.equal(read.page, 2);
  assert.equal(read.totalPages, 3);
  assert.equal(read.pagination_source, 'browser');
  assert.match(read.text, /\[20:3-10\] defghij/);
  assert.match(read.text, /\[30:0-5\] third/);
  assert.doesNotMatch(read.text, /abcdefghij/);

  const verify = getDb(true);
  assert.deepEqual(
    verify.prepare('SELECT page, paragraph_offset FROM book_progress WHERE book_id = ?').get(bookId),
    { page: 20, paragraph_offset: 3 },
  );
  verify.close();
});

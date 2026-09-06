import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { initDb, getDb } from '../lib/db.mjs';
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
    writeHead(status, headers = {}) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body = '') { this.body = String(body); },
  };
}

test('finish route preserves the first completion date', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-finish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initDb(path.join(dir, 'coread.db'));

  const db = getDb();
  const bookId = Number(db.prepare('INSERT INTO books (title) VALUES (?)').run('测试书').lastInsertRowid);
  db.close();

  const first = makeResponse();
  await handleRequest(makeRequest(`/v1/books/${bookId}/finish`, { finished_date: '2026-09-06' }), first);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).finished_at, '2026-09-06');

  const repeated = makeResponse();
  await handleRequest(makeRequest(`/v1/books/${bookId}/finish`, { finished_date: '2026-09-08' }), repeated);
  assert.equal(repeated.status, 200);
  assert.equal(JSON.parse(repeated.body).finished_at, '2026-09-06');

  const verify = getDb(true);
  assert.equal(
    verify.prepare('SELECT finished_at FROM reading_finished WHERE book_id = ?').get(bookId).finished_at,
    '2026-09-06',
  );
  verify.close();
});

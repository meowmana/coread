import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { initDb, getDb, getImageDir } from '../lib/db.mjs';
import { exportBackup, previewBackup, restoreBackup, validateBackup, MAX_BACKUP_BYTES } from '../lib/backup.mjs';
import { handleBackupRequest } from '../lib/backup-routes.mjs';

test('backup round trip preserves reading data and images; failure rolls back; runtime config is excluded', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initDb(path.join(dir, 'library.db'));
  const db = getDb();
  db.prepare('INSERT INTO books (id, title, total_paragraphs, cover_image) VALUES (1, ?, 1, ?)').run('Portable book', 'cover.png');
  db.prepare('INSERT INTO book_paragraphs (book_id, idx, content) VALUES (1, 0, ?)').run('A paragraph');
  db.prepare('INSERT INTO book_comments (book_id, paragraph_idx, content) VALUES (1, 0, ?)').run('A note');
  db.prepare('INSERT INTO book_progress (book_id, page, paragraph_offset, finished_at) VALUES (1, 0, 3, ?)').run('2026-09-08');
  db.prepare('INSERT INTO reading_daily (book_id, book_title, reading_date, seconds) VALUES (1, ?, ?, ?)').run('Portable book', '2026-09-08', 123.75);
  db.prepare('INSERT INTO reading_finished (book_id, book_title, finished_at) VALUES (1, ?, ?)').run('Portable book', '2026-09-08');
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('runtime_token', 'test-secret-not-exportable');
  db.close();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(getImageDir(1), 'cover.png'), image);
  const backup = exportBackup({ 'coread-font-size': '18', 'coread-night-mode': 'true' });
  assert.equal(backup.counts.books, 1);
  assert.equal(backup.counts.readingSeconds, 123.75);
  const serialized = JSON.stringify(backup);
  assert.ok(!serialized.includes('test-secret-not-exportable'));
  assert.ok(!serialized.includes(dir));
  assert.throws(() => restoreBackup('missing', true), /preview/);
  const preview = previewBackup(backup);
  assert.throws(() => restoreBackup(preview.token, false), /confirmation/);
  assert.throws(() => restoreBackup(preview.token, true, () => { throw new Error('disk fault'); }), /disk fault/);
  assert.deepEqual(exportBackup(backup.settings).data, backup.data);
  const result = restoreBackup(preview.token, true);
  assert.equal(result.ok, true);
  assert.deepEqual(exportBackup(result.settings).data, backup.data);
  const verify = getDb(true);
  assert.deepEqual(verify.prepare('SELECT data FROM backup_assets').get().data, image);
  assert.equal(verify.prepare('SELECT value FROM config WHERE key = ?').get('runtime_token').value, 'test-secret-not-exportable');
  verify.close();
  assert.throws(() => restoreBackup(preview.token, true), /preview/);
  // A second confirmation cannot silently overwrite reading performed after preview.
  const fresh = previewBackup(backup);
  const update = getDb(); update.prepare('UPDATE reading_daily SET seconds = seconds + 1').run(); update.close();
  assert.throws(() => restoreBackup(fresh.token, true), /changed after preview/);
  for (const name of ['../cover.png', '..\\cover.png', '/root/cover.png', 'C:cover.png', '%2e%2e.png']) {
    const bad = structuredClone(backup); bad.assets[0].name = name;
    assert.throws(() => validateBackup(bad), /path/);
  }
  for (const mutate of [b => b.schemaVersion = 900, b => b.data.reading_daily[0].seconds = -1,
    b => b.data.books[0].title = null, b => b.data.books.push(b.data.books[0]),
    b => b.settings.token = 'forbidden', b => b.assets[0].base64 = 'invalid!',
    b => b.data.book_comments[0].book_id = 999,
    b => b.data.reading_daily[0].reading_date = '2026-02-30']) {
    const bad = structuredClone(backup); mutate(bad); assert.throws(() => validateBackup(bad));
  }
});

test('backup routes require same-origin custom header and bound input size before parsing', async () => {
  async function call(headers, body = '{}', url = '/v1/backup/preview') {
    const req = Readable.from([body]); req.method = 'POST'; req.url = url; req.headers = headers;
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handleBackupRequest(req, res);
    return res;
  }
  assert.equal((await call({})).status, 403);
  const headers = { 'x-coread-backup': '1', 'content-type': 'application/json', host: 'localhost:3000', origin: 'http://localhost:3000' };
  assert.equal((await call({ ...headers, origin: 'http://attacker.test' })).status, 403);
  assert.equal((await call({ ...headers, 'content-length': String(MAX_BACKUP_BYTES + 1) })).status, 413);
  assert.equal((await call(headers, 'invalid json')).status, 400);
  assert.equal((await call(headers, '{}', '/v1/backup/restore')).status, 400);
});

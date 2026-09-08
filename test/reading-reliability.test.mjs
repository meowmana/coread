import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../lib/db.mjs';
import { recordCheckpoint } from '../lib/reading-events.mjs';
import { ReadingClock, splitDays } from '../web/reading-clock.mjs';

test('foreground clock pauses, does not double resume, and skips suspension gaps without click heuristics', () => {
  const events = [];
  const clock = new ReadingClock('session-clock-one', 1, x => events.push(x));
  clock.resume(1000); clock.resume(1100); clock.sample(2000); clock.pause(2250);
  clock.sample(50000); clock.pause(51000);
  assert.equal(clock.total, 1250);
  clock.resume(60000); clock.sample(61000); clock.sample(1000000);
  assert.equal(clock.total, 2250);
  // A user can stay on the same page for an hour without a single click.
  for (let time = 1001000; time <= 4600000; time += 1000) clock.sample(time);
  assert.equal(clock.total, 3602250);
  assert.equal(events.at(-1).elapsed_ms, clock.total);
});

test('local midnight splits exact milliseconds into separate natural days', () => {
  const start = new Date(2026, 8, 8, 23, 59, 59, 500).getTime();
  assert.deepEqual(splitDays(start, start + 1250), [{ date: '2026-09-08', ms: 500 }, { date: '2026-09-09', ms: 750 }]);
});

test('failed local persistence is never displayed as confirmed reading', () => {
  const clock = new ReadingClock('session-storage-full', 1, () => { throw new Error('quota'); });
  clock.resume(1000);
  assert.throws(() => clock.sample(2000), /quota/);
  assert.equal(clock.total, 0);
});

test('checkpoints are idempotent, order independent, fractional, per-day and session bound', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-checkpoints-'));
  initDb(path.join(dir, 'test.db'));
  initDb(path.join(dir, 'test.db')); // additive migration is repeatable
  const db = getDb(); t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.prepare('INSERT INTO books (id, title) VALUES (?, ?)').run(1, 'one');
  db.prepare('INSERT INTO books (id, title) VALUES (?, ?)').run(2, 'two');
  const sample = { session_id: 'session-durable-one', reading_date: '2026-09-08', elapsed_ms: 1250 };
  recordCheckpoint(db, 1, sample); recordCheckpoint(db, 1, sample);
  recordCheckpoint(db, 1, { ...sample, elapsed_ms: 500 });
  assert.equal(db.prepare('SELECT seconds FROM reading_daily').get().seconds, 1.25);
  recordCheckpoint(db, 1, { ...sample, elapsed_ms: 5000 });
  recordCheckpoint(db, 1, { ...sample, reading_date: '2026-09-09', elapsed_ms: 2000 });
  assert.equal(db.prepare('SELECT SUM(seconds) AS s FROM reading_daily').get().s, 7);
  assert.throws(() => recordCheckpoint(db, 2, sample), /another book/);
  for (const value of [NaN, -1, Infinity, 0.1, 999999999]) assert.throws(() => recordCheckpoint(db, 1, { ...sample, elapsed_ms: value }));
  assert.throws(() => recordCheckpoint(db, 1, { ...sample, reading_date: '2026-02-30' }));
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('library_generation', 'new-library');
  assert.throws(() => recordCheckpoint(db, 1, sample), /reload/);
  assert.equal(db.prepare('SELECT SUM(seconds) AS s FROM reading_daily').get().s, 7);
});

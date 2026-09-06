import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateStreaks, isValidDate, mergeReadingBooks, shiftDate } from '../lib/reading-stats.mjs';

test('date validation rejects impossible calendar dates', () => {
  assert.equal(isValidDate('2026-09-06'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('09-06-2026'), false);
});

test('shiftDate crosses month boundaries safely', () => {
  assert.equal(shiftDate('2026-09-01', -1), '2026-08-31');
});

test('streak counts days with at least one minute and allows today to be unfinished', () => {
  const rows = [
    { reading_date: '2026-09-02', seconds: 300 },
    { reading_date: '2026-09-03', seconds: 30 },
    { reading_date: '2026-09-04', seconds: 60 },
    { reading_date: '2026-09-05', seconds: 120 },
  ];
  assert.deepEqual(calculateStreaks(rows, '2026-09-06'), {
    currentStreak: 2,
    longestStreak: 2,
    readingDays: 3,
  });
});

test('book history merges time and finish rows even without a live book', () => {
  const result = mergeReadingBooks(
    [{ id: 7, title: '旧书', total_seconds: 900, last_read_at: '2026-09-05 12:00:00' }],
    [{ id: 7, title: '旧书', finished_at: '2026-09-05' }, { id: 9, title: '短篇', finished_at: '2026-09-06' }],
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].title, '短篇');
  assert.equal(result[1].total_seconds, 900);
  assert.equal(result[1].finished_at, '2026-09-05');
});

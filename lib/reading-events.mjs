import { isValidDate } from './reading-stats.mjs';

// Cumulative per-session/day checkpoints make retries and out-of-order delivery safe.
export function recordCheckpoint(db, bookId, input) {
  const { session_id: session, reading_date: date, elapsed_ms: elapsed } = input;
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(session || '') || !isValidDate(date || '') ||
      !Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > 26 * 3600 * 1000) {
    throw Object.assign(new Error('Invalid reading checkpoint'), { status: 400 });
  }
  return db.transaction(() => {
    const generation = db.prepare('SELECT value FROM config WHERE key = ?').get('library_generation')?.value || 'initial';
    if ((input.generation || 'initial') !== generation) throw Object.assign(new Error('Library restored; reload before reading'), { status: 409 });
    const book = db.prepare('SELECT title FROM books WHERE id = ?').get(bookId);
    if (!book) throw Object.assign(new Error('Book not found'), { status: 404 });
    const owner = db.prepare('SELECT book_id FROM reading_checkpoints WHERE session_id = ? LIMIT 1').get(session);
    if (owner && owner.book_id !== bookId) throw Object.assign(new Error('Session belongs to another book'), { status: 409 });
    const previous = db.prepare('SELECT elapsed_ms FROM reading_checkpoints WHERE session_id = ? AND reading_date = ?').get(session, date)?.elapsed_ms || 0;
    const accepted = Math.max(previous, elapsed);
    db.prepare(`INSERT INTO reading_checkpoints (session_id, book_id, reading_date, elapsed_ms) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, reading_date) DO UPDATE SET elapsed_ms = MAX(elapsed_ms, excluded.elapsed_ms)`).run(session, bookId, date, accepted);
    const delta = (accepted - previous) / 1000;
    if (delta) db.prepare(`INSERT INTO reading_daily (book_id, book_title, reading_date, seconds) VALUES (?, ?, ?, ?)
      ON CONFLICT(book_id, reading_date) DO UPDATE SET seconds = seconds + excluded.seconds,
      book_title = excluded.book_title, updated_at = datetime('now')`).run(bookId, book.title, date, delta);
    return { ok: true, accepted_ms: accepted };
  }).immediate();
}

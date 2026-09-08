import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, getDbPath } from './db.mjs';
import { isValidDate } from './reading-stats.mjs';

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const SETTINGS = ['coread-human-name', 'coread-ai-name', 'coread-font-size', 'coread-brightness', 'coread-night-mode'];
const TABLES = {
  books: 'id title total_paragraphs created_at cover_image',
  book_paragraphs: 'id book_id idx content',
  book_comments: 'id book_id paragraph_idx sel_start_idx sel_end_idx sel_end_para_idx selected_text from_who content created_at reply_to',
  book_progress: 'book_id page paragraph_offset updated_at last_opened_at finished_at',
  reading_daily: 'book_id book_title reading_date seconds updated_at',
  reading_record_notes: 'id book_id book_title reading_date from_who content created_at',
  reading_finished: 'book_id book_title finished_at created_at',
  reading_checkpoints: 'session_id book_id reading_date elapsed_ms',
};
const NUMBERS = new Set('id book_id total_paragraphs idx paragraph_idx sel_start_idx sel_end_idx sel_end_para_idx reply_to page paragraph_offset seconds elapsed_ms'.split(' '));
const previews = new Map();
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
export function safeAssetName(name) {
  return typeof name === 'string' && name.length <= 180 && !/[\\/:%\x00-\x1f]/.test(name) &&
    name !== '.' && name !== '..' && !name.endsWith('.') && !name.endsWith(' ') &&
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name);
}
function settingsOnly(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) invalid('Invalid settings');
  if (Object.keys(settings).some(key => !SETTINGS.includes(key))) invalid('Unsupported setting');
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== 'string' || value.length > 100) invalid('Invalid setting value');
    if (key === 'coread-night-mode' && !['true', 'false'].includes(value)) invalid('Invalid night mode');
    if (key === 'coread-font-size' && (!/^\d+$/.test(value) || +value < 12 || +value > 22)) invalid('Invalid font size');
    if (key === 'coread-brightness' && (!/^\d+$/.test(value) || +value < 20 || +value > 100)) invalid('Invalid brightness');
  }
  return settings;
}
function snapshot(db) {
  return Object.fromEntries(Object.entries(TABLES).map(([table, columns]) => [table, db.prepare(`SELECT ${columns.split(' ').join(',')} FROM ${table} ORDER BY rowid`).all()]));
}
function revision(db) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot(db)))
    .update(JSON.stringify(db.prepare('SELECT book_id, name, hex(data) AS bytes FROM backup_assets ORDER BY book_id, name').all())).digest('hex');
}
function counts(data, assets) {
  return { books: data.books.length, paragraphs: data.book_paragraphs.length, comments: data.book_comments.length,
    readingDays: new Set(data.reading_daily.map(row => row.reading_date)).size,
    readingSeconds: data.reading_daily.reduce((sum, row) => sum + row.seconds, 0), coversAndImages: assets.length };
}
export function exportBackup(settings = {}) {
  settingsOnly(settings);
  const db = getDb(true);
  try {
    return db.transaction(() => {
      const data = snapshot(db);
      const assets = [];
      let bytes = Buffer.byteLength(JSON.stringify(data));
      for (const book of data.books) {
        const stored = db.prepare('SELECT name, data FROM backup_assets WHERE book_id = ?').all(book.id);
        const names = new Set(stored.map(asset => asset.name));
        const directory = path.join(path.dirname(getDbPath()), 'book-images', String(book.id));
        // Once a library is restored, only transactionally installed assets belong to it.
        const restoredIds = JSON.parse(db.prepare('SELECT value FROM config WHERE key = ?').get('backup_asset_mode')?.value || '[]');
        if (!restoredIds.includes(book.id) && fs.existsSync(directory)) {
          if (fs.lstatSync(directory).isSymbolicLink()) invalid('Image directory cannot be a link');
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !safeAssetName(entry.name) || names.has(entry.name)) continue;
            const file = path.join(directory, entry.name);
            if (fs.statSync(file).size > 8 * 1024 * 1024) invalid('Image exceeds 8 MiB');
            stored.push({ name: entry.name, data: fs.readFileSync(file) });
          }
        }
        for (const asset of stored) {
          bytes += Math.ceil(asset.data.length * 4 / 3);
          if (bytes > MAX_BACKUP_BYTES) invalid('Backup exceeds 64 MiB');
          assets.push({ book_id: book.id, name: asset.name, base64: asset.data.toString('base64') });
        }
      }
      const backup = { schemaVersion: 1, createdAt: new Date().toISOString(), counts: counts(data, assets), data, assets, settings };
      validateBackup(backup);
      return backup;
    })();
  } finally { db.close(); }
}

// Explicit migration boundary: never guess how a future/unknown version should map.
export function migrateBackup(input) {
  if (input?.schemaVersion !== 1) invalid('Unsupported schemaVersion; a version migration is required');
  return input;
}
export function validateBackup(input) {
  const b = migrateBackup(input);
  if (Buffer.byteLength(JSON.stringify(b)) > MAX_BACKUP_BYTES) invalid('Backup exceeds 64 MiB');
  if (Object.keys(b).some(k => !['schemaVersion', 'createdAt', 'counts', 'data', 'assets', 'settings'].includes(k))) invalid('Unexpected backup field');
  if (typeof b.createdAt !== 'string' || !Number.isFinite(Date.parse(b.createdAt))) invalid('Invalid creation date');
  settingsOnly(b.settings);
  if (!b.data || Object.keys(b.data).length !== Object.keys(TABLES).length) invalid('Invalid data tables');
  let rows = 0;
  for (const [table, columns] of Object.entries(TABLES)) {
    const allowed = columns.split(' ');
    if (!Array.isArray(b.data[table])) invalid(`Missing table: ${table}`);
    for (const row of b.data[table]) {
      if (++rows > 250000) invalid('Too many rows');
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== allowed.length || allowed.some(k => !(k in row))) invalid(`Invalid row: ${table}`);
      for (const [key, value] of Object.entries(row)) {
        if (!allowed.includes(key)) invalid('Unexpected column');
        if (value === null) continue;
        if (NUMBERS.has(key)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (key !== 'seconds' && !Number.isInteger(value))) invalid(`Invalid number: ${key}`);
        } else if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) invalid(`Invalid text: ${key}`);
        if (['reading_date', 'finished_at'].includes(key) && !isValidDate(value)) invalid('Invalid calendar date');
      }
    }
  }
  const books = new Set(b.data.books.map(row => row.id));
  if (books.size !== b.data.books.length || b.data.books.some(row => !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.title !== 'string')) invalid('Invalid book identifiers');
  const paragraphs = new Set();
  for (const row of b.data.book_paragraphs) {
    if (!books.has(row.book_id) || row.idx === null || typeof row.content !== 'string') invalid('Invalid paragraph');
    const key = `${row.book_id}:${row.idx}`;
    if (paragraphs.has(key)) invalid('Duplicate paragraph index');
    paragraphs.add(key);
  }
  for (const row of [...b.data.book_comments, ...b.data.book_progress]) if (!books.has(row.book_id)) invalid('Orphan book data');
  if (!Array.isArray(b.assets) || b.assets.length > 10000) invalid('Invalid assets');
  const assets = new Set();
  for (const asset of b.assets) {
    if (!asset || Object.keys(asset).sort().join(',') !== 'base64,book_id,name' || !books.has(asset.book_id) || !safeAssetName(asset.name)) invalid('Unsafe asset path');
    if (typeof asset.base64 !== 'string' || asset.base64.length > 12 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)) invalid('Invalid image encoding');
    const bytes = Buffer.from(asset.base64, 'base64');
    if (bytes.length > 8 * 1024 * 1024) invalid('Image exceeds 8 MiB');
    if (/\.svg$/i.test(asset.name) && /<\s*(script|foreignObject)|\bon\w+\s*=|(?:href|src)\s*=\s*['"]\s*(?:https?:|\/\/|data:|javascript:)|<!ENTITY/i.test(bytes.toString('utf8'))) invalid('Active SVG content is not allowed');
    const key = `${asset.book_id}:${asset.name}`;
    if (assets.has(key)) invalid('Duplicate image');
    assets.add(key);
  }
  for (const book of b.data.books) if (book.cover_image && (!safeAssetName(book.cover_image) || !assets.has(`${book.id}:${book.cover_image}`))) invalid('Missing or invalid cover');
  // Check constraints in memory before preview; the live DB is never a validation scratchpad.
  const db = getDb(true);
  try {
    for (const [table, list] of Object.entries(b.data)) {
      const schema = db.prepare(`PRAGMA table_info(${table})`).all();
      const primary = schema.filter(c => c.pk).map(c => c.name);
      const required = schema.filter(c => c.notnull).map(c => c.name);
      const seen = new Set();
      for (const row of list) {
        const key = JSON.stringify(primary.map(k => row[k]));
        if (primary.some(k => row[k] == null) || seen.has(key)) invalid('Missing or duplicate row key');
        if (required.some(k => row[k] == null)) invalid('Missing required value');
        seen.add(key);
      }
    }
  } finally { db.close(); }
  return { ...counts(b.data, b.assets), createdAt: b.createdAt, schemaVersion: b.schemaVersion };
}

export function previewBackup(backup) {
  const summary = validateBackup(backup);
  const now = Date.now();
  for (const [key, value] of previews) if (value.expires < now) previews.delete(key);
  if (previews.size >= 2) invalid('Close an existing preview or wait five minutes');
  const token = crypto.randomUUID();
  // Store exactly the validated bytes, detached from callers. Confirmation carries no new data.
  const db = getDb(true);
  try { previews.set(token, { backup: JSON.stringify(backup), revision: revision(db), expires: now + 5 * 60000 }); }
  finally { db.close(); }
  return { token, ...summary };
}
export function restoreBackup(token, confirmed, failpoint) {
  const preview = previews.get(token);
  if (confirmed !== true || !preview || preview.expires < Date.now()) invalid('A valid preview and explicit confirmation are required');
  const backup = JSON.parse(preview.backup);
  const db = getDb();
  try {
    db.transaction(() => {
      if (revision(db) !== preview.revision) invalid('Reading data changed after preview; close other readers and preview again');
      for (const table of Object.keys(TABLES)) db.prepare(`DELETE FROM ${table}`).run();
      for (const [table, columns] of Object.entries(TABLES)) {
        const keys = columns.split(' ');
        const insert = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
        for (const row of backup.data[table]) insert.run(...keys.map(key => row[key]));
      }
      db.prepare('DELETE FROM backup_assets').run();
      const insertAsset = db.prepare('INSERT INTO backup_assets (book_id, name, data) VALUES (?, ?, ?)');
      for (const asset of backup.assets) insertAsset.run(asset.book_id, asset.name, Buffer.from(asset.base64, 'base64'));
      // Keep unrelated runtime configuration private; discard only derived browser page tables.
      db.prepare("DELETE FROM config WHERE key LIKE 'browser_pagination_v1:%'").run();
      const set = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
      set.run('backup_asset_mode', JSON.stringify(backup.data.books.map(book => book.id)));
      set.run('portable_settings', JSON.stringify(backup.settings));
      set.run('library_generation', crypto.randomUUID());
      if (failpoint) failpoint();
    }).immediate();
    previews.delete(token);
    return { ok: true, settings: backup.settings, generation: db.prepare('SELECT value FROM config WHERE key = ?').get('library_generation').value };
  } finally { db.close(); }
}

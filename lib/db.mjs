import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let dbPath = null;

export function initDb(customPath) {
  dbPath = customPath || path.join(process.cwd(), 'data', 'coread.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      total_paragraphs INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now')),
      cover_image TEXT
    );
    CREATE TABLE IF NOT EXISTS book_paragraphs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      paragraph_idx INTEGER NOT NULL,
      sel_start_idx INTEGER,
      sel_end_idx INTEGER,
      sel_end_para_idx INTEGER,
      selected_text TEXT,
      from_who TEXT DEFAULT 'human',
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      reply_to INTEGER
    );
    CREATE TABLE IF NOT EXISTS book_progress (
      book_id INTEGER PRIMARY KEY,
      page INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT (datetime('now')),
      last_opened_at DATETIME,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reading_daily (
      book_id INTEGER NOT NULL,
      book_title TEXT,
      reading_date TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT (datetime('now')),
      PRIMARY KEY (book_id, reading_date)
    );
    CREATE TABLE IF NOT EXISTS reading_record_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER,
      book_title TEXT,
      reading_date TEXT,
      from_who TEXT DEFAULT 'ai',
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reading_finished (
      book_id INTEGER PRIMARY KEY,
      book_title TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  try { db.exec('ALTER TABLE book_progress ADD COLUMN last_opened_at DATETIME'); } catch {}
  try { db.exec('ALTER TABLE book_progress ADD COLUMN finished_at TEXT'); } catch {}
  try { db.exec('ALTER TABLE reading_daily ADD COLUMN book_title TEXT'); } catch {}
  try { db.exec('ALTER TABLE reading_record_notes ADD COLUMN book_title TEXT'); } catch {}
  db.close();
}

export function getDb(readonly = false) {
  return new Database(dbPath, { readonly });
}

export function getDbPath() { return dbPath; }

export function getImageDir(bookId) {
  const dir = path.join(path.dirname(dbPath), 'book-images', String(bookId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

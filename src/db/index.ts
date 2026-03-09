import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';
import { initSchema } from './schema.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db');

let _db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (_db) return _db;

  // Ensure data directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  log.info({ path: config.dbPath }, 'opening database');

  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');

  initSchema(_db);

  log.info('database initialized with schema');
  return _db;
}

export function getDb(): Database.Database {
  if (!_db) {
    return initDb();
  }
  return _db;
}

export function checkDbHealth(db: Database.Database): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

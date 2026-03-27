import type { Database as DatabaseType } from 'better-sqlite3';
import { readdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('migrate');

export interface Migration {
  version: number;
  description: string;
  up(db: DatabaseType): void;
}

export async function runMigrations(db: DatabaseType): Promise<number> {
  // Create schema_version table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now', '+3 hours'))
    )
  `);

  // Get current version
  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = current.v || 0;

  // Discover migration files
  const migrationsDir = join(import.meta.dirname, '../migrations');
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter(f => f.match(/^\d{3}-.+\.js$/) && !f.endsWith('.d.ts'))
      .sort();
  } catch {
    log.warn('no migrations directory found');
    return 0;
  }

  let applied = 0;
  for (const file of files) {
    const module = await import(join(migrationsDir, file));
    const migration: Migration = module.default;

    if (migration.version <= currentVersion) continue;

    log.info({ version: migration.version, description: migration.description }, 'applying migration');

    const run = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(
        migration.version,
        migration.description
      );
    });

    run();
    applied++;
    log.info({ version: migration.version }, 'migration applied');
  }

  if (applied > 0) {
    log.info({ applied, currentVersion: currentVersion + applied }, 'migrations complete');
  }

  return applied;
}

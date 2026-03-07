import type { Migration } from '../utils/migrate.js';

const migration: Migration = {
  version: 1,
  description: 'Baseline — existing schema snapshot',
  up(db) {
    // All tables already exist from db.ts CREATE IF NOT EXISTS.
    // This migration marks the baseline version so future migrations
    // can run incrementally.
  },
};

export default migration;

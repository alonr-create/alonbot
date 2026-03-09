import { describe, it, expect } from 'vitest';

describe('config extensions', () => {
  it('has anthropicApiKey field', async () => {
    const { config } = await import('../../config.js');
    expect(config).toHaveProperty('anthropicApiKey');
    expect(typeof config.anthropicApiKey).toBe('string');
  });

  it('has mondayApiToken field', async () => {
    const { config } = await import('../../config.js');
    expect(config).toHaveProperty('mondayApiToken');
    expect(typeof config.mondayApiToken).toBe('string');
  });

  it('has mondayBoardId field', async () => {
    const { config } = await import('../../config.js');
    expect(config).toHaveProperty('mondayBoardId');
    expect(typeof config.mondayBoardId).toBe('string');
  });

  it('has mondayStatusColumnId field with default', async () => {
    const { config } = await import('../../config.js');
    expect(config).toHaveProperty('mondayStatusColumnId');
    expect(config.mondayStatusColumnId).toBe('status');
  });
});

describe('schema migration', () => {
  it('adds monday_item_id, monday_board_id, interest columns to leads', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { initSchema } = await import('../../db/schema.js');

    const db = new Database(':memory:');
    initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info('leads')")
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);

    expect(names).toContain('monday_item_id');
    expect(names).toContain('monday_board_id');
    expect(names).toContain('interest');

    db.close();
  });

  it('is idempotent - running twice does not throw', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { initSchema } = await import('../../db/schema.js');

    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();

    db.close();
  });
});

describe('Monday.com types', () => {
  it('exports MondayWebhookPayload type', async () => {
    const types = await import('../types.js');
    // Types exist at compile time; we verify the module loads
    expect(types).toBeDefined();
  });
});

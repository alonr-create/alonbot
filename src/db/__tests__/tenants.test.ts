import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.js';
import type { TenantRow } from '../tenants.js';
import { lookupTenantByPhoneNumberId, getTenants, getTenantById } from '../tenants.js';

// Helper: create an in-memory DB with schema initialized
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

describe('Tenants', () => {
  describe('lookupTenantByPhoneNumberId', () => {
    it('returns דקל tenant for phone_number_id 1080047101853955', () => {
      const db = makeDb();
      const tenant = lookupTenantByPhoneNumberId('1080047101853955', db);
      expect(tenant).not.toBeNull();
      expect(tenant!.name).toBe('דקל');
      expect(tenant!.monday_board_id).toBe(1443236269);
    });

    it('returns alondev tenant for phone_number_id 967467269793135', () => {
      const db = makeDb();
      const tenant = lookupTenantByPhoneNumberId('967467269793135', db);
      expect(tenant).not.toBeNull();
      expect(tenant!.name).toBe('alondev');
      expect(tenant!.monday_board_id).toBe(5092777389);
    });

    it('returns null for nonexistent phone_number_id', () => {
      const db = makeDb();
      const tenant = lookupTenantByPhoneNumberId('nonexistent', db);
      expect(tenant).toBeNull();
    });

    it('does NOT return inactive tenant', () => {
      const db = makeDb();
      // Deactivate דקל tenant
      db.prepare("UPDATE tenants SET active = 0 WHERE name = 'דקל'").run();
      const tenant = lookupTenantByPhoneNumberId('1080047101853955', db);
      expect(tenant).toBeNull();
    });
  });

  describe('getTenants', () => {
    it('returns array of 2 active tenants', () => {
      const db = makeDb();
      const tenants = getTenants(db);
      expect(tenants).toHaveLength(2);
    });

    it('returned tenants include דקל and alondev', () => {
      const db = makeDb();
      const tenants = getTenants(db);
      const names = tenants.map((t: TenantRow) => t.name);
      expect(names).toContain('דקל');
      expect(names).toContain('alondev');
    });
  });

  describe('getTenantById', () => {
    it('returns correct tenant row by id', () => {
      const db = makeDb();
      // Get דקל tenant id first via lookup
      const dekel = lookupTenantByPhoneNumberId('1080047101853955', db);
      expect(dekel).not.toBeNull();
      const found = getTenantById(dekel!.id, db);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('דקל');
      expect(found!.monday_board_id).toBe(1443236269);
    });

    it('returns null for nonexistent id', () => {
      const db = makeDb();
      const found = getTenantById(99999, db);
      expect(found).toBeNull();
    });

    it('returns null for inactive tenant', () => {
      const db = makeDb();
      const dekel = lookupTenantByPhoneNumberId('1080047101853955', db);
      db.prepare('UPDATE tenants SET active = 0 WHERE id = ?').run(dekel!.id);
      const found = getTenantById(dekel!.id, db);
      expect(found).toBeNull();
    });
  });

  describe('TenantRow includes wa_cloud_token', () => {
    it('TenantRow has wa_cloud_token field (nullable)', () => {
      const db = makeDb();
      const tenant = lookupTenantByPhoneNumberId('1080047101853955', db);
      expect(tenant).not.toBeNull();
      // wa_cloud_token is present in the row (may be null)
      expect('wa_cloud_token' in tenant!).toBe(true);
    });

    it('seed tenants have null wa_cloud_token', () => {
      const db = makeDb();
      const tenant = lookupTenantByPhoneNumberId('1080047101853955', db);
      expect(tenant!.wa_cloud_token).toBeNull();
    });
  });
});

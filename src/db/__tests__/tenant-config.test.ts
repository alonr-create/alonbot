import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.js';
import { clearConfigCache, isAdminPhone } from '../tenant-config.js';
import type { TenantRow } from '../tenants.js';

// Helper: create an in-memory DB with schema initialized
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

// A fake TenantRow for testing purposes
function makeTenantRow(adminPhone: string): TenantRow {
  return {
    id: 1,
    name: 'test-tenant',
    wa_phone_number_id: '123456',
    wa_number: '972559999999',
    monday_board_id: 999,
    business_name: 'Test Business',
    owner_name: 'Test Owner',
    admin_phone: adminPhone,
    personality: '',
    timezone: 'Asia/Jerusalem',
    payment_url: '',
    service_catalog: '[]',
    sales_faq: '[]',
    sales_objections: '[]',
    portfolio: '[]',
    wa_cloud_token: null,
    active: 1,
  };
}

describe('isAdminPhone', () => {
  beforeEach(() => {
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
  });

  it('returns true for known admin phone with no tenant (backward compat)', () => {
    // Uses tenant_config table which seeds admin_phone = '972546300783' (Alon.dev defaults)
    // Since we run in isolation without a real DB, it falls back to appConfig.alonPhone
    // We test the backward-compat case by calling isAdminPhone with the known alonPhone
    const result = isAdminPhone('972546300783');
    expect(result).toBe(true);
  });

  it('returns true when tenant.admin_phone matches exactly', () => {
    const tenant = makeTenantRow('972546300783');
    const result = isAdminPhone('972546300783', tenant);
    expect(result).toBe(true);
  });

  it('returns true when phone ends with last 9 digits of tenant.admin_phone', () => {
    const tenant = makeTenantRow('972551234567');
    // Phone that ends with the last 9 digits of 972551234567 (= 551234567)
    const result = isAdminPhone('0551234567', tenant);
    expect(result).toBe(true);
  });

  it('returns false when phone does NOT match tenant.admin_phone', () => {
    const tenant = makeTenantRow('972551234567');
    const result = isAdminPhone('972599999999', tenant);
    expect(result).toBe(false);
  });

  it('returns false for unknown phone with no tenant', () => {
    // 972599999999 is not the alonPhone default
    const result = isAdminPhone('972599999999');
    expect(result).toBe(false);
  });

  it('returns true for different tenant admin phone when tenant is provided', () => {
    const tenant = makeTenantRow('972551112222');
    const result = isAdminPhone('972551112222', tenant);
    expect(result).toBe(true);
  });
});

import type Database from 'better-sqlite3';
import { getDb } from './index.js';

export interface TenantRow {
  id: number;
  name: string;
  wa_phone_number_id: string;
  wa_number: string;
  monday_board_id: number;
  business_name: string;
  owner_name: string;
  admin_phone: string;
  personality: string;
  timezone: string;
  payment_url: string;
  service_catalog: string;
  sales_faq: string;
  sales_objections: string;
  portfolio: string;
  wa_cloud_token: string | null;
  active: number;
}

/**
 * Lookup a tenant by WhatsApp phone_number_id (Meta Cloud API field).
 * Returns null if not found or inactive.
 * Accepts an optional db parameter for testing with in-memory databases.
 */
export function lookupTenantByPhoneNumberId(
  phoneNumberId: string,
  db?: Database.Database,
): TenantRow | null {
  const database = db ?? getDb();
  const row = database
    .prepare(
      'SELECT * FROM tenants WHERE wa_phone_number_id = ? AND active = 1',
    )
    .get(phoneNumberId) as TenantRow | undefined;
  return row ?? null;
}

/**
 * Get all active tenants.
 * Accepts an optional db parameter for testing with in-memory databases.
 */
export function getTenants(db?: Database.Database): TenantRow[] {
  const database = db ?? getDb();
  return database
    .prepare('SELECT * FROM tenants WHERE active = 1')
    .all() as TenantRow[];
}

/**
 * Lookup a tenant by their numeric ID.
 * Returns null if not found or inactive.
 * Accepts an optional db parameter for testing with in-memory databases.
 */
export function getTenantById(id: number, db?: Database.Database): TenantRow | null {
  const database = db ?? getDb();
  const row = database
    .prepare('SELECT * FROM tenants WHERE id = ? AND active = 1')
    .get(id) as TenantRow | undefined;
  return row ?? null;
}

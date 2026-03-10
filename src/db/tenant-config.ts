/**
 * Tenant configuration — reads business-specific settings from the DB.
 * All values are seeded with Alon.dev defaults on first run.
 * Future tenants: change values in tenant_config table per deployment.
 */
import { getDb } from './index.js';
import { config as appConfig } from '../config.js';

const cache = new Map<string, string>();
let cacheLoaded = false;

function loadCache(): void {
  if (cacheLoaded) return;
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM tenant_config').all() as Array<{ key: string; value: string }>;
  for (const row of rows) {
    cache.set(row.key, row.value);
  }
  cacheLoaded = true;
}

/** Get a single config value. Returns fallback if not found. */
export function getConfig(key: string, fallback = ''): string {
  loadCache();
  return cache.get(key) ?? fallback;
}

/** Get config as number. */
export function getConfigNum(key: string, fallback = 0): number {
  const val = getConfig(key);
  return val ? parseInt(val, 10) : fallback;
}

/** Get config as parsed JSON. */
export function getConfigJSON<T>(key: string, fallback: T): T {
  const val = getConfig(key);
  if (!val) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

/** Check if a phone number is the admin (boss). */
export function isAdminPhone(phone: string): boolean {
  const adminPhone = getConfig('admin_phone');
  if (!adminPhone) {
    // Fallback to config.alonPhone if tenant_config not set
    return phone === appConfig.alonPhone || phone.endsWith(appConfig.alonPhone.slice(-9));
  }
  return phone === adminPhone || phone.endsWith(adminPhone.slice(-9));
}

/** Update a config value (persists to DB and updates cache). */
export function setConfig(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO tenant_config (key, value) VALUES (?, ?)',
  ).run(key, value);
  cache.set(key, value);
}

/** Clear config cache (useful for tests or hot-reload). */
export function clearConfigCache(): void {
  cache.clear();
  cacheLoaded = false;
}

// ── Convenience getters ──

export function getBusinessName(): string {
  return getConfig('business_name', 'Business');
}

export function getOwnerName(): string {
  return getConfig('owner_name', 'Owner');
}

export function getAdminPhone(): string {
  return getConfig('admin_phone', '');
}

export function getTimezone(): string {
  return getConfig('timezone', 'Asia/Jerusalem');
}

export function getEscalationMessage(): string {
  const template = getConfig('escalation_message', 'תודה על הסבלנות! {owner} יחזור אליך בהקדם האפשרי.');
  return template.replace('{owner}', getOwnerName());
}

export interface ServiceItem {
  name: string;
  min: number;
  max: number;
  unit?: string;
}

export interface ServiceCategory {
  category: string;
  items: ServiceItem[];
}

export function getServiceCatalog(): ServiceCategory[] {
  return getConfigJSON<ServiceCategory[]>('service_catalog', []);
}

export interface PortfolioItem {
  name: string;
  url: string;
  type: string;
  desc: string;
}

export function getPortfolio(): PortfolioItem[] {
  return getConfigJSON<PortfolioItem[]>('portfolio', []);
}

export interface FAQItem {
  q: string;
  a: string;
}

export function getSalesFAQ(): FAQItem[] {
  return getConfigJSON<FAQItem[]>('sales_faq', []);
}

export interface ObjectionItem {
  objection: string;
  response: string;
}

export function getSalesObjections(): ObjectionItem[] {
  return getConfigJSON<ObjectionItem[]>('sales_objections', []);
}

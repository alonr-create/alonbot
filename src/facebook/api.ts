/**
 * Facebook Marketing API client.
 * Uses Graph API v21.0 with native fetch.
 * Supports multiple ad accounts.
 */
import { createLogger } from '../utils/logger.js';
import type {
  FacebookCampaign,
  FacebookInsights,
  CampaignInsightsResult,
  AccountInsightsResult,
  DatePreset,
  FacebookApiError,
} from './types.js';

const log = createLogger('facebook-api');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Ad accounts with their tokens (each Business Manager has its own System User token)
interface AdAccountConfig {
  id: string;
  tokenEnv: string; // env var name for the token
}

const AD_ACCOUNTS: Record<string, AdAccountConfig> = {
  'דקל לפרישה': { id: 'act_293504438925223', tokenEnv: 'FACEBOOK_ACCESS_TOKEN' },
  'Alon.dev': { id: 'act_1314904720689466', tokenEnv: 'FACEBOOK_ACCESS_TOKEN_ALON' },
};

function getAccessToken(tokenEnv = 'FACEBOOK_ACCESS_TOKEN'): string {
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`${tokenEnv} env var is not set`);
  return token;
}

function getTokenForAccount(accountId: string): string {
  for (const config of Object.values(AD_ACCOUNTS)) {
    if (config.id === accountId) return getAccessToken(config.tokenEnv);
  }
  return getAccessToken();
}

function getTokenEnvForAccount(accountId: string): string {
  for (const config of Object.values(AD_ACCOUNTS)) {
    if (config.id === accountId) return config.tokenEnv;
  }
  return 'FACEBOOK_ACCESS_TOKEN';
}

/** Get all ad account IDs. */
export function getAllAdAccountIds(): { name: string; id: string }[] {
  return Object.entries(AD_ACCOUNTS).map(([name, config]) => ({ name, id: config.id }));
}

/** Get ad account ID by name (partial match). Falls back to first account. */
export function getAdAccountId(name?: string): string {
  if (!name) return Object.values(AD_ACCOUNTS)[0].id;
  const lower = name.toLowerCase();
  for (const [key, config] of Object.entries(AD_ACCOUNTS)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      return config.id;
    }
  }
  return Object.values(AD_ACCOUNTS)[0].id;
}

/**
 * Generic Facebook Graph API request helper.
 */
async function fbGet<T>(path: string, params: Record<string, string> = {}, tokenEnv?: string): Promise<T> {
  const url = new URL(`${GRAPH_BASE_URL}${path}`);
  url.searchParams.set('access_token', tokenEnv ? getAccessToken(tokenEnv) : getAccessToken());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString());
  const data = await res.json() as T | FacebookApiError;

  if (!res.ok || ('error' in (data as Record<string, unknown>))) {
    const err = data as FacebookApiError;
    log.error({ path, status: res.status, error: err.error }, 'Facebook API error');
    throw new Error(`Facebook API error: ${err.error?.message || res.statusText}`);
  }

  return data as T;
}

async function fbPost<T>(path: string, body: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${GRAPH_BASE_URL}${path}`);
  url.searchParams.set('access_token', getAccessToken());

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as T | FacebookApiError;

  if (!res.ok || ('error' in (data as Record<string, unknown>))) {
    const err = data as FacebookApiError;
    log.error({ path, status: res.status, error: err.error }, 'Facebook API POST error');
    throw new Error(`Facebook API error: ${err.error?.message || res.statusText}`);
  }

  return data as T;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Get active campaigns for a specific ad account (or all accounts).
 */
export async function getActiveCampaigns(accountId?: string): Promise<(FacebookCampaign & { accountName?: string })[]> {
  if (accountId) {
    return fetchCampaignsForAccount(accountId);
  }

  // Fetch from all accounts in parallel
  const results = await Promise.allSettled(
    Object.entries(AD_ACCOUNTS).map(async ([name, config]) => {
      const campaigns = await fetchCampaignsForAccount(config.id);
      return campaigns.map((c) => ({ ...c, accountName: name }));
    }),
  );

  const all: (FacebookCampaign & { accountName?: string })[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }
  log.info({ totalActive: all.length }, 'fetched campaigns from all accounts');
  return all;
}

async function fetchCampaignsForAccount(accountId: string): Promise<FacebookCampaign[]> {
  const tokenEnv = getTokenEnvForAccount(accountId);
  const result = await fbGet<{ data: FacebookCampaign[] }>(
    `/${accountId}/campaigns`,
    {
      fields: 'id,name,status,effective_status,daily_budget,objective',
      limit: '100',
    },
    tokenEnv,
  );
  const active = result.data.filter(
    (c) => c.status === 'ACTIVE' || c.effective_status === 'ACTIVE',
  );
  log.info({ accountId, total: result.data.length, active: active.length }, 'fetched campaigns');
  return active;
}

/**
 * Get insights for a specific campaign.
 */
export async function getCampaignInsights(
  campaignId: string,
  datePreset: DatePreset = 'today',
): Promise<CampaignInsightsResult> {
  const result = await fbGet<{ data: FacebookInsights[] }>(
    `/${campaignId}/insights`,
    {
      fields: 'spend,impressions,clicks,actions,cost_per_action_type,cpc',
      date_preset: datePreset,
    },
  );

  const insights = result.data[0];
  if (!insights) {
    return {
      campaignId,
      spend: 0,
      impressions: 0,
      clicks: 0,
      leads: 0,
      cpc: 0,
      cpl: 0,
      dateStart: '',
      dateStop: '',
    };
  }

  return parseInsights(insights, campaignId);
}

/**
 * Get aggregated insights for a specific ad account (or all accounts combined).
 */
export async function getAccountInsights(
  datePreset: DatePreset = 'today',
  accountId?: string,
): Promise<AccountInsightsResult> {
  if (accountId) {
    return fetchInsightsForAccount(accountId, datePreset);
  }

  // Fetch from all accounts and sum up
  const results = await Promise.allSettled(
    Object.values(AD_ACCOUNTS).map((config) => fetchInsightsForAccount(config.id, datePreset)),
  );

  let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalLeads = 0;
  let dateStart = '', dateStop = '';

  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalSpend += r.value.spend;
      totalImpressions += r.value.impressions;
      totalClicks += r.value.clicks;
      totalLeads += r.value.leads;
      if (r.value.dateStart && (!dateStart || r.value.dateStart < dateStart)) dateStart = r.value.dateStart;
      if (r.value.dateStop && (!dateStop || r.value.dateStop > dateStop)) dateStop = r.value.dateStop;
    }
  }

  return {
    spend: totalSpend,
    impressions: totalImpressions,
    clicks: totalClicks,
    leads: totalLeads,
    cpc: totalClicks > 0 ? Math.round((totalSpend / totalClicks) * 100) / 100 : 0,
    cpl: totalLeads > 0 ? Math.round((totalSpend / totalLeads) * 100) / 100 : 0,
    dateStart,
    dateStop,
  };
}

async function fetchInsightsForAccount(accountId: string, datePreset: DatePreset): Promise<AccountInsightsResult> {
  const tokenEnv = getTokenEnvForAccount(accountId);
  const result = await fbGet<{ data: FacebookInsights[] }>(
    `/${accountId}/insights`,
    {
      fields: 'spend,impressions,clicks,actions,cost_per_action_type,cpc',
      date_preset: datePreset,
    },
    tokenEnv,
  );

  const insights = result.data[0];
  if (!insights) {
    return { spend: 0, impressions: 0, clicks: 0, leads: 0, cpc: 0, cpl: 0, dateStart: '', dateStop: '' };
  }

  const parsed = parseInsights(insights);
  return {
    spend: parsed.spend,
    impressions: parsed.impressions,
    clicks: parsed.clicks,
    leads: parsed.leads,
    cpc: parsed.cpc,
    cpl: parsed.cpl,
    dateStart: parsed.dateStart,
    dateStop: parsed.dateStop,
  };
}

/**
 * Pause a campaign.
 */
export async function pauseCampaign(campaignId: string): Promise<boolean> {
  await fbPost<{ success: boolean }>(`/${campaignId}`, { status: 'PAUSED' });
  log.info({ campaignId }, 'campaign paused');
  return true;
}

/**
 * Resume (activate) a campaign.
 */
export async function resumeCampaign(campaignId: string): Promise<boolean> {
  await fbPost<{ success: boolean }>(`/${campaignId}`, { status: 'ACTIVE' });
  log.info({ campaignId }, 'campaign resumed');
  return true;
}

/**
 * Update daily budget for a campaign.
 * @param budgetInAgorot - Budget in agorot (smallest ILS unit). 1 shekel = 100 agorot.
 */
export async function updateDailyBudget(
  campaignId: string,
  budgetInAgorot: number,
): Promise<boolean> {
  await fbPost<{ success: boolean }>(`/${campaignId}`, {
    daily_budget: String(budgetInAgorot),
  });
  log.info({ campaignId, budgetInAgorot }, 'campaign daily budget updated');
  return true;
}

// ── Helpers ──────────────────────────────────────────────────

function parseInsights(
  insights: FacebookInsights,
  campaignId?: string,
): CampaignInsightsResult {
  const spend = parseFloat(insights.spend || '0');
  const impressions = parseInt(insights.impressions || '0', 10);
  const clicks = parseInt(insights.clicks || '0', 10);

  // Extract leads from actions array
  const leadAction = insights.actions?.find(
    (a) => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead',
  );
  const leads = leadAction ? parseInt(leadAction.value, 10) : 0;

  const cpc = clicks > 0 ? spend / clicks : 0;
  const cpl = leads > 0 ? spend / leads : 0;

  return {
    campaignId: campaignId || '',
    spend,
    impressions,
    clicks,
    leads,
    cpc: Math.round(cpc * 100) / 100,
    cpl: Math.round(cpl * 100) / 100,
    dateStart: insights.date_start,
    dateStop: insights.date_stop,
  };
}

/**
 * Facebook Marketing API client.
 * Uses Graph API v21.0 with native fetch.
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

function getAccessToken(): string {
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!token) throw new Error('FACEBOOK_ACCESS_TOKEN env var is not set');
  return token;
}

function getAdAccountId(): string {
  return process.env.FACEBOOK_AD_ACCOUNT_ID || 'act_1840092926437010';
}

/**
 * Generic Facebook Graph API request helper.
 */
async function fbGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${GRAPH_BASE_URL}${path}`);
  url.searchParams.set('access_token', getAccessToken());
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
 * Get all active campaigns for the ad account.
 */
export async function getActiveCampaigns(): Promise<FacebookCampaign[]> {
  const accountId = getAdAccountId();
  const result = await fbGet<{ data: FacebookCampaign[] }>(
    `/${accountId}/campaigns`,
    {
      fields: 'id,name,status,daily_budget,objective',
      filtering: JSON.stringify([{ field: 'status', operator: 'IN', value: ['ACTIVE'] }]),
      limit: '100',
    },
  );
  log.info({ count: result.data.length }, 'fetched active campaigns');
  return result.data;
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
 * Get aggregated insights for the entire ad account.
 */
export async function getAccountInsights(
  datePreset: DatePreset = 'today',
): Promise<AccountInsightsResult> {
  const accountId = getAdAccountId();
  const result = await fbGet<{ data: FacebookInsights[] }>(
    `/${accountId}/insights`,
    {
      fields: 'spend,impressions,clicks,actions,cost_per_action_type,cpc',
      date_preset: datePreset,
    },
  );

  const insights = result.data[0];
  if (!insights) {
    return {
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

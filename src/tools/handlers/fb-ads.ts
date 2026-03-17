import { z } from 'zod';
import type { ToolHandler } from '../types.js';

const FB_API = 'https://graph.facebook.com/v21.0';

// Known ad accounts — only these are accessible
const ALLOWED_ACCOUNTS: Record<string, string> = {
  'dekel': 'act_293504438925223',
  'alon.dev': 'act_1314904720689466',
  'alon_personal': 'act_1840092926437010',
};

const fbAdsSchema = z.object({
  action: z.enum([
    'list_campaigns',
    'campaign_insights',
    'adset_details',
    'ad_details',
    'update_budget',
    'update_status',
    'run_capi_sync',
    'account_overview',
  ]),
  account: z.string().optional(),
  campaign_id: z.string().optional(),
  adset_id: z.string().optional(),
  date_preset: z.string().optional(),
  new_budget: z.number().optional(),
  new_status: z.enum(['ACTIVE', 'PAUSED']).optional(),
  entity_id: z.string().optional(),
});

async function fbGet(path: string, params: Record<string, string>, token: string): Promise<any> {
  const url = new URL(`${FB_API}/${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

async function fbPost(path: string, data: Record<string, string>, token: string): Promise<any> {
  const body = new URLSearchParams(data);
  body.set('access_token', token);
  const res = await fetch(`${FB_API}/${path}`, { method: 'POST', body });
  return res.json();
}

function resolveAccount(input: string | undefined): string | null {
  if (!input) return ALLOWED_ACCOUNTS['dekel'];
  const lower = input.toLowerCase();
  if (ALLOWED_ACCOUNTS[lower]) return ALLOWED_ACCOUNTS[lower];
  // Allow direct act_ IDs only if in allowed list
  if (input.startsWith('act_') && Object.values(ALLOWED_ACCOUNTS).includes(input)) return input;
  return null;
}

const handler: ToolHandler = {
  name: 'fb_ads',
  definition: {
    name: 'fb_ads',
    description: `Facebook Ads Manager — manage campaigns for Dekel/Alon.dev.
Actions:
- list_campaigns: List all campaigns (account: dekel|alon.dev)
- campaign_insights: Get campaign performance (campaign_id, date_preset: last_7d|last_30d)
- adset_details: Get ad set details + learning status (campaign_id)
- ad_details: Get ad details (campaign_id)
- update_budget: Change daily budget in agorot (entity_id, new_budget: number)
- update_status: Pause/activate campaign or ad set (entity_id, new_status: ACTIVE|PAUSED)
- run_capi_sync: Run CAPI sync for Dekel (sends conversion events to Facebook)
- account_overview: High-level account stats`,
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list_campaigns', 'campaign_insights', 'adset_details', 'ad_details', 'update_budget', 'update_status', 'run_capi_sync', 'account_overview'],
        },
        account: { type: 'string', description: 'dekel or alon.dev (default: dekel)' },
        campaign_id: { type: 'string' },
        date_preset: { type: 'string', description: 'last_7d, last_30d, etc.' },
        new_budget: { type: 'number', description: 'Budget in agorot (e.g. 5000 = 50 NIS)' },
        new_status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        entity_id: { type: 'string', description: 'Campaign/adset/ad ID to update' },
      },
      required: ['action'],
    },
  },
  schema: fbAdsSchema,

  async execute(input, ctx) {
    const token = ctx.config.fbAccessToken;
    if (!token) return 'Error: FB_ACCESS_TOKEN not configured.';

    const { action } = input;

    try {
      switch (action) {
        case 'list_campaigns': {
          const accountId = resolveAccount(input.account);
          if (!accountId) return `Error: Unknown account "${input.account}". Use: dekel, alon.dev`;
          const data = await fbGet(`${accountId}/campaigns`, {
            fields: 'name,status,effective_status,daily_budget,lifetime_budget,created_time',
          }, token);
          if (data.error) return `FB Error: ${data.error.message}`;
          const campaigns = (data.data || []).map((c: any) => ({
            id: c.id,
            name: c.name,
            status: c.effective_status,
            daily_budget: c.daily_budget ? `${(parseInt(c.daily_budget) / 100).toFixed(0)}₪` : 'lifetime',
          }));
          return JSON.stringify(campaigns, null, 2);
        }

        case 'campaign_insights': {
          if (!input.campaign_id) return 'Error: campaign_id required';
          const preset = input.date_preset || 'last_7d';
          const data = await fbGet(`${input.campaign_id}/insights`, {
            fields: 'spend,impressions,reach,frequency,ctr,cpc,actions,cost_per_action_type',
            date_preset: preset,
          }, token);
          if (data.error) return `FB Error: ${data.error.message}`;
          if (!data.data?.length) return 'No data for this period.';
          const d = data.data[0];
          const leads = d.actions?.find((a: any) => a.action_type === 'lead')?.value || 0;
          const costPerLead = d.cost_per_action_type?.find((a: any) => a.action_type === 'lead')?.value || 'N/A';
          return JSON.stringify({
            spend: `${d.spend}₪`,
            impressions: d.impressions,
            reach: d.reach,
            frequency: d.frequency,
            ctr: `${d.ctr}%`,
            cpc: `${d.cpc}₪`,
            leads,
            cost_per_lead: costPerLead === 'N/A' ? 'N/A' : `${costPerLead}₪`,
            period: `${d.date_start} - ${d.date_stop}`,
          }, null, 2);
        }

        case 'adset_details': {
          if (!input.campaign_id) return 'Error: campaign_id required';
          const data = await fbGet(`${input.campaign_id}/adsets`, {
            fields: 'name,effective_status,daily_budget,learning_stage_info,optimization_goal',
          }, token);
          if (data.error) return `FB Error: ${data.error.message}`;
          const adsets = (data.data || []).map((a: any) => ({
            id: a.id,
            name: a.name,
            status: a.effective_status,
            daily_budget: a.daily_budget ? `${(parseInt(a.daily_budget) / 100).toFixed(0)}₪` : 'campaign budget',
            optimization: a.optimization_goal,
            learning: a.learning_stage_info?.status || 'N/A',
            conversions: a.learning_stage_info?.conversions ?? 'N/A',
          }));
          return JSON.stringify(adsets, null, 2);
        }

        case 'ad_details': {
          if (!input.campaign_id) return 'Error: campaign_id required';
          const data = await fbGet(`${input.campaign_id}/ads`, {
            fields: 'name,effective_status,issues_info',
          }, token);
          if (data.error) return `FB Error: ${data.error.message}`;
          const ads = (data.data || []).map((a: any) => ({
            id: a.id,
            name: a.name,
            status: a.effective_status,
            issues: a.issues_info || [],
          }));
          return JSON.stringify(ads, null, 2);
        }

        case 'update_budget': {
          if (!input.entity_id) return 'Error: entity_id required';
          if (!input.new_budget || input.new_budget < 500) return 'Error: new_budget required (min 500 agorot = 5₪)';
          const result = await fbPost(input.entity_id, { daily_budget: String(input.new_budget) }, token);
          if (result.error) return `FB Error: ${result.error.message}\n${result.error.error_user_msg || ''}`;
          return `Budget updated to ${(input.new_budget / 100).toFixed(0)}₪/day`;
        }

        case 'update_status': {
          if (!input.entity_id) return 'Error: entity_id required';
          if (!input.new_status) return 'Error: new_status required (ACTIVE or PAUSED)';
          const result = await fbPost(input.entity_id, { status: input.new_status }, token);
          if (result.error) return `FB Error: ${result.error.message}\n${result.error.error_user_msg || ''}`;
          return `Status updated to ${input.new_status}`;
        }

        case 'run_capi_sync': {
          const { execSync } = await import('child_process');
          const output = execSync('node sync-capi.mjs', {
            cwd: '/Users/oakhome/קלוד עבודות/דקל לפרישה',
            timeout: 60000,
            encoding: 'utf8',
          });
          return output.slice(-2000);
        }

        case 'account_overview': {
          const accountId = resolveAccount(input.account);
          if (!accountId) return `Error: Unknown account "${input.account}".`;
          const [acctInfo, insights] = await Promise.all([
            fbGet(accountId, { fields: 'name,account_status,amount_spent,spend_cap,balance,currency' }, token),
            fbGet(`${accountId}/insights`, { fields: 'spend,impressions,reach,actions', date_preset: 'last_7d' }, token),
          ]);
          if (acctInfo.error) return `FB Error: ${acctInfo.error.message}`;
          const i = insights.data?.[0] || {};
          const leads = i.actions?.find((a: any) => a.action_type === 'lead')?.value || 0;
          return JSON.stringify({
            name: acctInfo.name,
            status: acctInfo.account_status === 1 ? 'Active' : `Status ${acctInfo.account_status}`,
            total_spent: `${(parseInt(acctInfo.amount_spent || '0') / 100).toFixed(0)}₪`,
            balance: `${(parseInt(acctInfo.balance || '0') / 100).toFixed(0)}₪`,
            last_7d: {
              spend: i.spend ? `${i.spend}₪` : '0₪',
              impressions: i.impressions || 0,
              reach: i.reach || 0,
              leads,
            },
          }, null, 2);
        }

        default:
          return `Unknown action: ${action}`;
      }
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
};

export default handler;

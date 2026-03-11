/**
 * TypeScript types for Facebook Marketing API responses.
 */

export interface FacebookCampaign {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  effective_status?: string;
  daily_budget?: string;
  objective: string;
}

export interface FacebookInsights {
  spend: string;
  impressions: string;
  clicks: string;
  actions?: FacebookAction[];
  cost_per_action_type?: FacebookAction[];
  cpc?: string;
  cpm?: string;
  ctr?: string;
  date_start: string;
  date_stop: string;
}

export interface FacebookAction {
  action_type: string;
  value: string;
}

export interface CampaignInsightsResult {
  campaignId: string;
  campaignName?: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  cpc: number;
  cpl: number;
  dateStart: string;
  dateStop: string;
}

export interface AccountInsightsResult {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  cpc: number;
  cpl: number;
  dateStart: string;
  dateStop: string;
}

export type DatePreset = 'today' | 'yesterday' | 'last_7d' | 'last_30d';

export interface FacebookApiError {
  error: {
    message: string;
    type: string;
    code: number;
    fbtrace_id: string;
  };
}

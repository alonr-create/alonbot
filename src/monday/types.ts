export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'in-conversation'
  | 'quote-sent'
  | 'meeting-scheduled'
  | 'escalated'
  | 'closed-won'
  | 'closed-lost';

export interface MondayWebhookPayload {
  challenge?: string;
  event?: {
    type: string;
    pulseId: number;
    boardId: number;
    pulseName: string;
  };
}

export interface MondayItem {
  name: string;
  phone: string;
  interest: string;
}

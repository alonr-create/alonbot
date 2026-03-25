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
    /** Column change events */
    columnId?: string;
    columnType?: string;
    value?: { label?: { text?: string; index?: number } } | Record<string, any>;
    previousValue?: { label?: { text?: string; index?: number } } | Record<string, any>;
  };
}

export interface MondayItem {
  name: string;
  phone: string;
  interest: string;
  source: string;
}

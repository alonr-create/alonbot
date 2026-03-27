/**
 * Canonical lead status values — single source of truth.
 * Import from here instead of hardcoding strings.
 */

export const LEAD_STATUS = {
  NEW: 'new',
  CONTACTED: 'contacted',
  INTERESTED: 'interested',
  WAITING: 'waiting',
  VIP: 'vip',
  CLOSED: 'closed',
  NOT_RELEVANT: 'not_relevant',
  REFUSED: 'refused',
  BOOKED: 'booked',
  NO_SHOW: 'no_show',
} as const;

/** Union type of all valid lead status strings */
export type LeadStatus = typeof LEAD_STATUS[keyof typeof LEAD_STATUS];

/** All statuses as an array — useful for iteration, validation, SQL IN clauses */
export const ALL_LEAD_STATUSES: readonly LeadStatus[] = Object.values(LEAD_STATUS);

/** Pipeline stages used in kanban views (excludes 'booked' which is a flag) */
export const PIPELINE_STAGES: readonly LeadStatus[] = [
  LEAD_STATUS.NEW,
  LEAD_STATUS.CONTACTED,
  LEAD_STATUS.INTERESTED,
  LEAD_STATUS.WAITING,
  LEAD_STATUS.VIP,
  LEAD_STATUS.CLOSED,
  LEAD_STATUS.NOT_RELEVANT,
  LEAD_STATUS.REFUSED,
] as const;

/** Statuses that indicate a lead is terminal / done */
export const TERMINAL_STATUSES: readonly LeadStatus[] = [
  LEAD_STATUS.CLOSED,
  LEAD_STATUS.NOT_RELEVANT,
  LEAD_STATUS.REFUSED,
] as const;

/** Type guard — checks if an arbitrary string is a valid LeadStatus */
export function isValidLeadStatus(s: string): s is LeadStatus {
  return ALL_LEAD_STATUSES.includes(s as LeadStatus);
}

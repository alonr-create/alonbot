import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('calendar');

export interface TimeSlot {
  date: string;
  time: string;
  dayName: string;
}

export interface BookingResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

/**
 * Fetch available time slots from Google Calendar via Apps Script proxy.
 * Returns empty array on error or when not configured. Never throws.
 */
export async function getAvailableSlots(days = 3): Promise<TimeSlot[]> {
  const url = config.googleCalendarScriptUrl;
  if (!url) {
    log.warn('Google Calendar Script URL not configured');
    return [];
  }

  try {
    const response = await fetch(
      `${url}?action=freeBusy&days=${days}`,
      { signal: AbortSignal.timeout(10000) },
    );

    const data = (await response.json()) as { slots: TimeSlot[] };
    log.info({ count: data.slots?.length ?? 0 }, 'fetched available slots');
    return data.slots || [];
  } catch (err) {
    log.error({ err }, 'failed to fetch available slots');
    return [];
  }
}

/**
 * Book a meeting via Google Calendar Apps Script proxy.
 * Returns {success: false} on error. Never throws.
 */
export async function bookMeeting(
  date: string,
  time: string,
  leadName: string,
  phone: string,
  interest: string,
  summary: string,
): Promise<BookingResult> {
  const url = config.googleCalendarScriptUrl;
  if (!url) {
    log.warn('Google Calendar Script URL not configured');
    return { success: false, error: 'Calendar not configured' };
  }

  try {
    const params = new URLSearchParams({
      action: 'add',
      date,
      time,
      duration: '30',
      title: `פגישת היכרות - ${leadName}`,
      description: `שם: ${leadName}\nטלפון: ${phone}\nתחום עניין: ${interest}\nסיכום: ${summary}`,
    });
    const response = await fetch(
      `${url}?${params.toString()}`,
      { signal: AbortSignal.timeout(10000) },
    );

    const data = (await response.json()) as BookingResult;
    log.info({ success: data.success, eventId: data.eventId }, 'booking result');
    return data;
  } catch (err) {
    log.error({ err }, 'failed to book meeting');
    return { success: false, error: (err as Error).message };
  }
}

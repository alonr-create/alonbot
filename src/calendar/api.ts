import { google } from 'googleapis';
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

// Calendar ID — Alon's primary calendar
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

let calendarClient: ReturnType<typeof google.calendar> | null = null;

function getCalendar() {
  if (calendarClient) return calendarClient;

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    log.warn('GOOGLE_SERVICE_ACCOUNT_JSON not configured');
    return null;
  }

  try {
    const credentials = JSON.parse(saJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    calendarClient = google.calendar({ version: 'v3', auth });
    log.info('Google Calendar client initialized');
    return calendarClient;
  } catch (err) {
    log.error({ err }, 'Failed to initialize Google Calendar client');
    return null;
  }
}

const HEBREW_DAYS: Record<number, string> = {
  0: 'ראשון',
  1: 'שני',
  2: 'שלישי',
  3: 'רביעי',
  4: 'חמישי',
  5: 'שישי',
  6: 'שבת',
};

/**
 * Fetch available time slots from Google Calendar.
 * Checks free/busy for the next N days and returns open 15-min slots.
 */
export async function getAvailableSlots(days = 3): Promise<TimeSlot[]> {
  // If Apps Script URL is configured, use it (backward compat)
  if (config.googleCalendarScriptUrl) {
    return getAvailableSlotsViaAppsScript(days);
  }

  const calendar = getCalendar();
  if (!calendar) return [];

  try {
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        timeZone: 'Asia/Jerusalem',
        items: [{ id: CALENDAR_ID }],
      },
    });

    const busySlots = freeBusy.data.calendars?.[CALENDAR_ID]?.busy || [];

    // Generate available 15-min slots during business hours
    const slots: TimeSlot[] = [];
    const current = new Date(now);
    current.setMinutes(0, 0, 0);
    if (current < now) current.setHours(current.getHours() + 1);

    while (current < end && slots.length < 15) {
      const israelTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Jerusalem',
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      }).formatToParts(current);

      const weekday = israelTime.find(p => p.type === 'weekday')?.value;
      const hour = parseInt(israelTime.find(p => p.type === 'hour')?.value || '0');

      const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const dayNum = dayMap[weekday || ''] ?? -1;

      // Skip Shabbat and outside business hours
      const isBusinessHour =
        dayNum >= 0 && dayNum <= 4 && hour >= 9 && hour < 16 || // Sun-Thu 9-16
        dayNum === 5 && hour >= 9 && hour < 13; // Fri 9-13

      if (isBusinessHour) {
        const slotEnd = new Date(current.getTime() + 15 * 60 * 1000);
        const isBusy = busySlots.some(busy => {
          const busyStart = new Date(busy.start!);
          const busyEnd = new Date(busy.end!);
          return current < busyEnd && slotEnd > busyStart;
        });

        if (!isBusy) {
          const dateStr = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Jerusalem',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(current);

          const timeStr = `${String(hour).padStart(2, '0')}:${String(current.getMinutes()).padStart(2, '0')}`;

          slots.push({
            date: dateStr,
            time: timeStr,
            dayName: HEBREW_DAYS[dayNum] || '',
          });
        }
      }

      current.setMinutes(current.getMinutes() + 30); // Check every 30 min
    }

    log.info({ count: slots.length }, 'fetched available slots');
    return slots;
  } catch (err) {
    log.error({ err }, 'failed to fetch available slots');
    return [];
  }
}

/**
 * Book a meeting via Google Calendar API.
 */
export async function bookMeeting(
  date: string,
  time: string,
  leadName: string,
  phone: string,
  interest: string,
  summary: string,
): Promise<BookingResult> {
  // If Apps Script URL is configured, use it (backward compat)
  if (config.googleCalendarScriptUrl) {
    return bookMeetingViaAppsScript(date, time, leadName, phone, interest, summary);
  }

  const calendar = getCalendar();
  if (!calendar) {
    return { success: false, error: 'Calendar not configured' };
  }

  try {
    const [h, m] = time.split(':').map(Number);
    const totalMinutes = h * 60 + m + 15;
    const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const endM = String(totalMinutes % 60).padStart(2, '0');

    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `שיחת זום 15 דק׳ - ${leadName}`,
        description: [
          `שם: ${leadName}`,
          `טלפון: ${phone}`,
          `תחום עניין: ${interest}`,
          `סיכום: ${summary}`,
          '',
          'נקבע אוטומטית על ידי AalonBot',
        ].join('\n'),
        start: {
          dateTime: `${date}T${time}:00`,
          timeZone: 'Asia/Jerusalem',
        },
        end: {
          dateTime: `${date}T${endH}:${endM}:00`,
          timeZone: 'Asia/Jerusalem',
        },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: 15 }],
        },
      },
    });

    log.info({ eventId: res.data.id, date, time, leadName }, 'meeting booked');
    return { success: true, eventId: res.data.id || undefined };
  } catch (err) {
    log.error({ err }, 'failed to book meeting');
    return { success: false, error: (err as Error).message };
  }
}

// ---- Apps Script fallback (backward compat) ----

async function getAvailableSlotsViaAppsScript(days: number): Promise<TimeSlot[]> {
  const url = config.googleCalendarScriptUrl;
  try {
    const response = await fetch(`${url}?action=freeBusy&days=${days}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = (await response.json()) as { slots: TimeSlot[] };
    log.info({ count: data.slots?.length ?? 0 }, 'fetched available slots (Apps Script)');
    return data.slots || [];
  } catch (err) {
    log.error({ err }, 'failed to fetch available slots (Apps Script)');
    return [];
  }
}

async function bookMeetingViaAppsScript(
  date: string, time: string, leadName: string,
  phone: string, interest: string, summary: string,
): Promise<BookingResult> {
  const url = config.googleCalendarScriptUrl;
  try {
    const params = new URLSearchParams({
      action: 'add', date, time, duration: '15',
      title: `שיחת זום 15 דק׳ - ${leadName}`,
      description: `שם: ${leadName}\nטלפון: ${phone}\nתחום עניין: ${interest}\nסיכום: ${summary}`,
    });
    const response = await fetch(`${url}?${params.toString()}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = (await response.json()) as BookingResult;
    log.info({ success: data.success, eventId: data.eventId }, 'booking result (Apps Script)');
    return data;
  } catch (err) {
    log.error({ err }, 'failed to book meeting (Apps Script)');
    return { success: false, error: (err as Error).message };
  }
}

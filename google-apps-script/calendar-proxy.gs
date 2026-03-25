/**
 * Google Apps Script — Calendar Proxy for AalonBot
 * Provides freeBusy slots and booking via HTTP GET requests.
 *
 * SETUP:
 * 1. Go to https://script.google.com → New Project
 * 2. Paste this entire code
 * 3. Click Deploy → New Deployment → Web App
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy the URL and set it as GOOGLE_CALENDAR_SCRIPT_URL in Railway
 */

// ── Configuration ──
const CALENDAR_ID = 'primary'; // Use 'primary' for the main calendar
const TIMEZONE = 'Asia/Jerusalem';
const SLOT_DURATION_MINUTES = 30;

// Business hours (Israel)
const BUSINESS_HOURS = {
  0: { start: 9, end: 16 },  // Sunday
  1: { start: 9, end: 16 },  // Monday
  2: { start: 9, end: 16 },  // Tuesday
  3: { start: 9, end: 16 },  // Wednesday
  4: { start: 9, end: 16 },  // Thursday
  5: { start: 9, end: 13 },  // Friday
  6: null,                     // Saturday — closed
};

const DAY_NAMES_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ── Main handler ──
function doGet(e) {
  const action = e.parameter.action || '';

  try {
    let result;
    switch (action) {
      case 'freeBusy':
        result = getFreeBusy(parseInt(e.parameter.days || '3', 10));
        break;
      case 'add':
        result = addEvent(e.parameter);
        break;
      case 'ping':
        result = { status: 'ok', calendar: CALENDAR_ID, timezone: TIMEZONE };
        break;
      default:
        result = { error: 'Unknown action. Use: freeBusy, add, ping' };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      error: err.message || 'Unknown error',
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ── Get available time slots ──
function getFreeBusy(days) {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) {
    return { slots: [], error: 'Calendar not found' };
  }

  const now = new Date();
  const slots = [];

  for (let d = 0; d < days; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);

    const dayOfWeek = date.getDay();
    const hours = BUSINESS_HOURS[dayOfWeek];

    // Skip non-business days
    if (!hours) continue;

    // Skip if today and past business hours
    if (d === 0) {
      const currentHour = parseInt(Utilities.formatDate(now, TIMEZONE, 'H'), 10);
      const currentMinute = parseInt(Utilities.formatDate(now, TIMEZONE, 'm'), 10);
      if (currentHour >= hours.end) continue;
    }

    // Get all events for this day
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);
    const events = cal.getEvents(dayStart, dayEnd);

    // Check each slot
    for (let hour = hours.start; hour < hours.end; hour++) {
      for (let minute = 0; minute < 60; minute += SLOT_DURATION_MINUTES) {
        const slotStart = new Date(date);
        slotStart.setHours(hour, minute, 0, 0);

        const slotEnd = new Date(slotStart);
        slotEnd.setMinutes(slotEnd.getMinutes() + SLOT_DURATION_MINUTES);

        // Skip past slots for today
        if (d === 0 && slotStart <= now) continue;

        // Check for conflicts
        const hasConflict = events.some(function(event) {
          const eventStart = event.getStartTime();
          const eventEnd = event.getEndTime();
          return slotStart < eventEnd && slotEnd > eventStart;
        });

        if (!hasConflict) {
          const dateStr = Utilities.formatDate(slotStart, TIMEZONE, 'yyyy-MM-dd');
          const timeStr = Utilities.formatDate(slotStart, TIMEZONE, 'HH:mm');
          const dayName = DAY_NAMES_HE[dayOfWeek];

          slots.push({
            date: dateStr,
            time: timeStr,
            dayName: 'יום ' + dayName,
          });
        }
      }
    }
  }

  return { slots: slots };
}

// ── Book a meeting ──
function addEvent(params) {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) {
    return { success: false, error: 'Calendar not found' };
  }

  const date = params.date;       // YYYY-MM-DD
  const time = params.time;       // HH:mm
  const duration = parseInt(params.duration || '30', 10);
  const title = params.title || 'פגישה';
  const description = params.description || '';

  if (!date || !time) {
    return { success: false, error: 'Missing date or time' };
  }

  // Parse date and time
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);

  const startTime = new Date(year, month - 1, day, hour, minute, 0);
  const endTime = new Date(startTime);
  endTime.setMinutes(endTime.getMinutes() + duration);

  // Check for conflicts
  const events = cal.getEvents(startTime, endTime);
  if (events.length > 0) {
    return {
      success: false,
      error: 'Time slot is already booked',
      conflictWith: events[0].getTitle(),
    };
  }

  // Create event
  const event = cal.createEvent(title, startTime, endTime, {
    description: description,
  });

  return {
    success: true,
    eventId: event.getId(),
    date: date,
    time: time,
    title: title,
  };
}

/**
 * Google Apps Script — Calendar API for AlonBot
 *
 * Setup:
 * 1. Go to https://script.google.com → New Project
 * 2. Paste this entire file
 * 3. Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy the URL and set it as GOOGLE_CALENDAR_SCRIPT_URL in Render env vars
 */

function doGet(e) {
  const action = e.parameter.action;

  if (action === 'list') {
    const days = parseInt(e.parameter.days) || 7;
    return listEvents(days);
  }

  return jsonResponse({ error: 'Unknown action' });
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  if (data.action === 'add') {
    return addEvent(data);
  }

  return jsonResponse({ error: 'Unknown action' });
}

function listEvents(days) {
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // Read from ALL calendars (own + shared)
  const calendars = CalendarApp.getAllCalendars();
  const allEvents = [];

  calendars.forEach(function(cal) {
    const events = cal.getEvents(now, end);
    const calName = cal.getName();
    events.forEach(function(event) {
      const start = event.getStartTime();
      const isAllDay = event.isAllDayEvent();
      allEvents.push({
        title: event.getTitle(),
        calendar: calName,
        date: Utilities.formatDate(start, 'Asia/Jerusalem', 'yyyy-MM-dd'),
        time: isAllDay ? null : Utilities.formatDate(start, 'Asia/Jerusalem', 'HH:mm'),
        description: event.getDescription() || '',
        location: event.getLocation() || '',
        allDay: isAllDay,
      });
    });
  });

  // Sort by date+time
  allEvents.sort(function(a, b) {
    var da = a.date + (a.time || '00:00');
    var db = b.date + (b.time || '00:00');
    return da < db ? -1 : da > db ? 1 : 0;
  });

  return jsonResponse({ events: allEvents });
}

function addEvent(data) {
  try {
    const cal = CalendarApp.getDefaultCalendar();

    if (data.time) {
      // Timed event
      const startDate = new Date(data.date + 'T' + data.time + ':00');
      const durationMs = (data.duration_minutes || 60) * 60 * 1000;
      const endDate = new Date(startDate.getTime() + durationMs);

      const event = cal.createEvent(data.title, startDate, endDate, {
        description: data.description || '',
      });

      return jsonResponse({
        success: true,
        eventId: event.getId(),
        title: data.title,
        date: data.date,
        time: data.time,
      });
    } else {
      // All-day event
      const date = new Date(data.date + 'T00:00:00');
      const event = cal.createAllDayEvent(data.title, date, {
        description: data.description || '',
      });

      return jsonResponse({
        success: true,
        eventId: event.getId(),
        title: data.title,
        date: data.date,
      });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

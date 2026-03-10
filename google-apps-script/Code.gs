/**
 * Google Apps Script — Calendar proxy for Alon.dev WhatsApp Bot
 * Deploy as Web App (Execute as: Me, Access: Anyone)
 *
 * Endpoints:
 *   GET  ?action=freeBusy&days=3  → { slots: [{date, time, dayName}] }
 *   POST {action:"add", date, time, duration, title, description} → {success, eventId}
 */

// Israel business hours: Sun-Thu 09:00-18:00, Fri 09:00-13:00
var SLOT_DURATION = 30; // minutes
var START_HOUR = 9;
var END_HOUR_WEEKDAY = 16;
var END_HOUR_FRIDAY = 13;
var TIMEZONE = 'Asia/Jerusalem';

var HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || '';

  if (action === 'freeBusy') {
    var days = parseInt(e.parameter.days || '3', 10);
    var result = getFreeBusySlots(days);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: 'Unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (body.action === 'add') {
    var result = addEvent(body);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Find available 30-min slots in the next N business days.
 * Checks primary calendar for conflicts.
 */
function getFreeBusySlots(days) {
  var cal = CalendarApp.getDefaultCalendar();
  var now = new Date();
  var slots = [];
  var checked = 0;
  var d = new Date(now.getTime());

  // If we're past today's business hours, start from tomorrow
  var currentHour = getIsraelHour(d);
  var currentDay = getIsraelDayOfWeek(d);
  var endHour = currentDay === 5 ? END_HOUR_FRIDAY : END_HOUR_WEEKDAY;
  if (currentDay === 6 || currentHour >= endHour) {
    d.setDate(d.getDate() + 1);
    d = setIsraelHour(d, START_HOUR, 0);
  }

  while (checked < days && slots.length < 15) {
    var dayOfWeek = getIsraelDayOfWeek(d);

    // Skip Saturday
    if (dayOfWeek === 6) {
      d.setDate(d.getDate() + 1);
      d = setIsraelHour(d, START_HOUR, 0);
      continue;
    }

    var dayEndHour = dayOfWeek === 5 ? END_HOUR_FRIDAY : END_HOUR_WEEKDAY;
    var dayStart = setIsraelHour(new Date(d.getTime()), START_HOUR, 0);
    var dayEnd = setIsraelHour(new Date(d.getTime()), dayEndHour, 0);

    // Get events for this day
    var events = cal.getEvents(dayStart, dayEnd);
    var busyRanges = events.map(function(ev) {
      return { start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime() };
    });

    // Generate slots
    var slotStart = new Date(dayStart.getTime());
    // If today, start from next available slot after now
    if (isSameIsraelDay(slotStart, now) && now.getTime() > slotStart.getTime()) {
      // Round up to next 30-min boundary
      slotStart = new Date(now.getTime());
      var mins = slotStart.getMinutes();
      if (mins % 30 !== 0) {
        slotStart.setMinutes(mins + (30 - (mins % 30)));
        slotStart.setSeconds(0);
        slotStart.setMilliseconds(0);
      }
    }

    while (slotStart.getTime() + SLOT_DURATION * 60000 <= dayEnd.getTime()) {
      var slotEnd = new Date(slotStart.getTime() + SLOT_DURATION * 60000);
      var conflict = busyRanges.some(function(r) {
        return slotStart.getTime() < r.end && slotEnd.getTime() > r.start;
      });

      if (!conflict) {
        var dateStr = Utilities.formatDate(slotStart, TIMEZONE, 'yyyy-MM-dd');
        var timeStr = Utilities.formatDate(slotStart, TIMEZONE, 'HH:mm');
        slots.push({
          date: dateStr,
          time: timeStr,
          dayName: HEBREW_DAYS[dayOfWeek]
        });
      }

      slotStart = new Date(slotStart.getTime() + SLOT_DURATION * 60000);
    }

    checked++;
    d.setDate(d.getDate() + 1);
    d = setIsraelHour(d, START_HOUR, 0);
  }

  return { slots: slots };
}

/**
 * Add a calendar event.
 * body: { date: "2026-03-12", time: "10:00", duration: 30, title: "...", description: "..." }
 */
function addEvent(body) {
  try {
    var cal = CalendarApp.getDefaultCalendar();
    var dateTime = new Date(body.date + 'T' + body.time + ':00');

    // Adjust for Israel timezone
    var offset = getTimezoneOffset(dateTime);
    var startTime = new Date(dateTime.getTime() - offset);
    var duration = parseInt(body.duration || '30', 10);
    var endTime = new Date(startTime.getTime() + duration * 60000);

    var event = cal.createEvent(
      body.title || 'פגישת היכרות — Alon.dev',
      startTime,
      endTime,
      {
        description: body.description || '',
        location: 'Zoom (link will be sent)'
      }
    );

    return { success: true, eventId: event.getId() };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// --- Timezone helpers ---

function getIsraelDayOfWeek(date) {
  var str = Utilities.formatDate(date, TIMEZONE, 'u'); // 1=Mon, 7=Sun
  var iso = parseInt(str, 10);
  // Convert ISO (1=Mon..7=Sun) to JS (0=Sun..6=Sat)
  return iso === 7 ? 0 : iso;
}

function getIsraelHour(date) {
  var str = Utilities.formatDate(date, TIMEZONE, 'HH');
  return parseInt(str, 10);
}

function setIsraelHour(date, hour, minute) {
  // Get the current Israel date string
  var dateStr = Utilities.formatDate(date, TIMEZONE, 'yyyy-MM-dd');
  var h = hour < 10 ? '0' + hour : '' + hour;
  var m = minute < 10 ? '0' + minute : '' + minute;
  var target = new Date(dateStr + 'T' + h + ':' + m + ':00');
  var offset = getTimezoneOffset(target);
  return new Date(target.getTime() - offset);
}

function getTimezoneOffset(date) {
  // Get UTC offset for Israel at the given date
  var utcStr = Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd HH:mm:ss');
  var israelStr = Utilities.formatDate(date, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  var utcDate = new Date(utcStr.replace(' ', 'T'));
  var israelDate = new Date(israelStr.replace(' ', 'T'));
  return israelDate.getTime() - utcDate.getTime();
}

function isSameIsraelDay(d1, d2) {
  var s1 = Utilities.formatDate(d1, TIMEZONE, 'yyyy-MM-dd');
  var s2 = Utilities.formatDate(d2, TIMEZONE, 'yyyy-MM-dd');
  return s1 === s2;
}

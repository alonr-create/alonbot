const TIMEZONE = 'Asia/Jerusalem';

// Day of week in Israel: 0=Sunday, 1=Monday, ... 5=Friday, 6=Saturday
function getIsraelDay(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return dayMap[weekday || ''] ?? -1;
}

function getIsraelHour(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return hour + minute / 60;
}

/**
 * Check if the given date falls within Israel business hours.
 * Sun-Thu 09:00-18:00, Fri 09:00-13:00, Sat off.
 */
export function isBusinessHours(date?: Date): boolean {
  const d = date || new Date();
  const day = getIsraelDay(d);
  const hourDecimal = getIsraelHour(d);

  // Saturday — off
  if (day === 6) return false;

  // Friday — 09:00-13:00
  if (day === 5) return hourDecimal >= 9 && hourDecimal < 13;

  // Sunday-Thursday — 09:00-16:00
  return hourDecimal >= 9 && hourDecimal < 16;
}

/**
 * Get the next business day at 09:00 Israel time.
 * Skips Friday afternoon and Saturday.
 */
export function getNextBusinessDay(from?: Date): Date {
  const d = from ? new Date(from.getTime()) : new Date();

  // Move forward one day at a time until we find a business day
  // Start by advancing to next day
  d.setDate(d.getDate() + 1);

  // Keep advancing until we hit a business day (Sun-Thu, or Fri before 13:00)
  let day = getIsraelDay(d);
  while (day === 6 || day === 5) {
    // Skip Saturday and Friday (since we're looking for start of business day)
    d.setDate(d.getDate() + 1);
    day = getIsraelDay(d);
  }

  // Set to 09:00 Israel time by using formatter to find the current offset
  // Create a date at 09:00 Israel time on the target day
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

  // Parse back: dateStr is YYYY-MM-DD in Israel timezone
  // We need to find UTC time that corresponds to 09:00 Israel time on that date
  // Use a trial-and-error approach with Intl to get exact offset
  const trial = new Date(`${dateStr}T09:00:00`);
  // Get the Israel time of this trial date
  const trialHour = getIsraelHour(trial);
  // Adjust: if trialHour is not 9, adjust by the difference
  const diffMs = (trialHour - 9) * 60 * 60 * 1000;
  return new Date(trial.getTime() + diffMs);
}

/**
 * Format a date in Hebrew with weekday and time in Israel timezone.
 */
export function formatIsraelTime(date?: Date): string {
  const d = date || new Date();
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: TIMEZONE,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

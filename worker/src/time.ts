const DAY_MS = 86_400_000;

const clockFormats = new Map<string, Intl.DateTimeFormat>();

function clockFormat(tz: string): Intl.DateTimeFormat {
  let format = clockFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    clockFormats.set(tz, format);
  }
  return format;
}

export type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** What a clock in `tz` shows at the instant `ms`. */
export function wallClock(ms: number, tz: string): WallClock {
  const parts: Record<string, number> = {};
  for (const { type, value } of clockFormat(tz).formatToParts(ms)) parts[type] = Number(value);
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar day (YYYY-MM-DD) that the instant `ms` falls on in `tz`. */
export function dayOf(ms: number, tz: string): string {
  const { year, month, day } = wallClock(ms, tz);
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// Labels are built by hand because ICU's wording changes between versions.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Tue, Sep 22" */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]!.slice(0, 3)} ${date.getUTCDate()}`;
}

/** "September" */
export function monthName(day: string): string {
  return MONTHS[Number(day.slice(5, 7)) - 1]!;
}

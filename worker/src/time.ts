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

/** First instant of `day` (YYYY-MM-DD) in `tz`, as Unix milliseconds. */
export function startOfDay(day: string, tz: string): number {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  let ms = midnight;
  // The second pass corrects for an offset change between the guess and the answer.
  for (let pass = 0; pass < 2; pass++) ms = midnight - offsetAt(ms, tz);
  // Where a DST jump skips 00:00, the day starts at the first instant that is on `day`.
  while (dayOf(ms, tz) < day) ms += 15 * 60_000;
  return ms;
}

function offsetAt(ms: number, tz: string): number {
  const c = wallClock(ms, tz);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - (ms - (ms % 1000));
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// Labels are built by hand because ICU's wording ("Sep 22 at 23:47") changes between versions.
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

/** "Sep 22, 23:47" as seen in `tz` */
export function dateTimeLabel(ms: number, tz: string): string {
  const c = wallClock(ms, tz);
  return `${MONTHS[c.month - 1]!.slice(0, 3)} ${c.day}, ${pad(c.hour)}:${pad(c.minute)}`;
}

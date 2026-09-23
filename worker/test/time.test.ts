import { expect, test } from "bun:test";
import { addDays, dayOf, startOfDay } from "../src/time";

test("days start at local midnight", () => {
  expect(startOfDay("2026-09-22", "Asia/Tokyo")).toBe(Date.parse("2026-09-21T15:00:00Z"));
  expect(startOfDay("2026-09-22", "UTC")).toBe(Date.parse("2026-09-22T00:00:00Z"));
  expect(dayOf(Date.parse("2026-09-22T14:59:59Z"), "Asia/Tokyo")).toBe("2026-09-22");
  expect(dayOf(Date.parse("2026-09-22T15:00:00Z"), "Asia/Tokyo")).toBe("2026-09-23");
});

test("DST changes move the start of the day", () => {
  // New York springs forward at 02:00, so that midnight is still EST and the next is EDT.
  expect(startOfDay("2026-03-08", "America/New_York")).toBe(Date.parse("2026-03-08T05:00:00Z"));
  expect(startOfDay("2026-03-09", "America/New_York")).toBe(Date.parse("2026-03-09T04:00:00Z"));
  // Santiago jumps from 00:00 to 01:00, so the day starts at 01:00 local.
  expect(startOfDay("2026-09-06", "America/Santiago")).toBe(Date.parse("2026-09-06T04:00:00Z"));
});

test("adds calendar days across month and year ends", () => {
  expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
});

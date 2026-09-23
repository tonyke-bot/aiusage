import { expect, test } from "bun:test";
import { addDays, dayOf } from "../src/time";

test("days change at local midnight", () => {
  expect(dayOf(Date.parse("2026-09-22T14:59:59Z"), "Asia/Tokyo")).toBe("2026-09-22");
  expect(dayOf(Date.parse("2026-09-22T15:00:00Z"), "Asia/Tokyo")).toBe("2026-09-23");
  expect(dayOf(Date.parse("2026-09-22T23:59:59Z"), "UTC")).toBe("2026-09-22");
});

test("adds calendar days across month and year ends", () => {
  expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
});

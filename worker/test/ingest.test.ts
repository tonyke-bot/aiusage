import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { parseUpload, TOUCH_DEVICE, UPSERT_USAGE, type UsageRow } from "../src/ingest";

const tz = "Asia/Tokyo";
const schema = await Bun.file(new URL("../migrations/0001_init.sql", import.meta.url)).text();

const row = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  date: "2026-09-22",
  agent: "claude",
  model: "claude-opus-5",
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationTokens: 10,
  cacheReadTokens: 1000,
  costUsd: 1.5,
  ...overrides,
});

describe("parseUpload", () => {
  test("accepts rows, filling missing counts with zero and rounding cost", () => {
    const upload = parseUpload(
      { device: "laptop", tz, rows: [{ date: "2026-09-22", agent: "codex", model: "gpt-5.5", outputTokens: 7, costUsd: 0.1 + 0.2 }] },
      tz,
    );
    expect(upload).toEqual({
      device: "laptop",
      rows: [
        {
          date: "2026-09-22",
          agent: "codex",
          model: "gpt-5.5",
          inputTokens: 0,
          outputTokens: 7,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.3,
        },
      ],
    });
  });

  test("rejects a collector that cuts days in another zone", () => {
    expect(parseUpload({ device: "wb", tz: "UTC", rows: [] }, tz)).toBe(
      'the collector cuts days in "UTC" but this report uses "Asia/Tokyo"; run the collector with --timezone Asia/Tokyo',
    );
  });

  test("rejects bad devices, dates and counts", () => {
    expect(parseUpload({ device: "my laptop", tz, rows: [] }, tz)).toStartWith("device must be");
    expect(parseUpload({ device: "laptop", tz, rows: [row({ date: "2026-02-30" })] }, tz)).toBe("rows[0]: date must be YYYY-MM-DD");
    expect(parseUpload({ device: "laptop", tz, rows: [row(), row({ inputTokens: -1 })] }, tz)).toBe(
      "rows[1]: inputTokens must be a non-negative integer",
    );
    expect(parseUpload({ device: "laptop", tz, rows: [row({ costUsd: Number.NaN })] }, tz)).toBe(
      "rows[0]: costUsd must be a non-negative number",
    );
    expect(parseUpload("nope", tz)).toBe("body must be a JSON object");
  });
});

describe("storing uploads", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.run(schema);
  });

  const upsert = (device: string, rows: UsageRow[], now: number) =>
    db.query(UPSERT_USAGE).run(device, JSON.stringify(rows), now).changes;
  const stored = () =>
    db
      .query("SELECT device, date, input_tokens, output_tokens, cache_read_tokens, cost_usd, updated_at FROM usage ORDER BY device, date")
      .all();

  test("inserts new rows", () => {
    expect(upsert("laptop", [row(), row({ date: "2026-09-23" })], 1)).toBe(2);
    expect(stored()).toHaveLength(2);
  });

  test("raises each value to the larger one and never lowers it", () => {
    upsert("laptop", [row()], 1);
    expect(upsert("laptop", [row({ inputTokens: 90, outputTokens: 80, costUsd: 1.2 })], 2)).toBe(1);
    expect(stored()).toEqual([
      { device: "laptop", date: "2026-09-22", input_tokens: 100, output_tokens: 80, cache_read_tokens: 1000, cost_usd: 1.5, updated_at: 2 },
    ]);
  });

  test("leaves a row untouched when nothing grew", () => {
    upsert("laptop", [row()], 1);
    expect(upsert("laptop", [row({ inputTokens: 10, cacheReadTokens: 5 })], 2)).toBe(0);
    expect(stored()[0]).toMatchObject({ input_tokens: 100, cache_read_tokens: 1000, updated_at: 1 });
  });

  test("keeps each device's rows apart", () => {
    upsert("laptop", [row()], 1);
    upsert("server", [row({ inputTokens: 5 })], 2);
    expect(stored().map((r: any) => [r.device, r.input_tokens])).toEqual([
      ["laptop", 100],
      ["server", 5],
    ]);
  });

  test("tracks each device's latest upload", () => {
    db.query(TOUCH_DEVICE).run("laptop", 5);
    db.query(TOUCH_DEVICE).run("laptop", 3);
    expect(db.query("SELECT device, last_seen_at FROM devices").all()).toEqual([{ device: "laptop", last_seen_at: 5 }]);
  });
});

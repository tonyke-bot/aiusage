import { expect, test } from "bun:test";
import { buildBrief, dueBrief, formatBrief, sparkline, tokenCount, type UsageRecord } from "../src/report";

const tz = "Asia/Tokyo";

const usage: UsageRecord[] = [
  { date: "2026-09-22", agent: "claude", model: "claude-opus-5", tokens: 150_000_000, cost: 150 },
  { date: "2026-09-21", agent: "claude", model: "claude-opus-5", tokens: 0, cost: 63 },
  { date: "2026-09-22", agent: "codex", model: "gpt-5.5", tokens: 40_800_000, cost: 13.45 },
];

test("totals the day by agent and model, with week and month context", () => {
  const brief = buildBrief({ usage, devices: [], tz, day: "2026-09-22" });
  expect(brief.total).toEqual({ cost: 163.45, tokens: 190_800_000 });
  expect(brief.byAgent.map(([name, t]) => [name, t.cost])).toEqual([
    ["claude", 150],
    ["codex", 13.45],
  ]);
  expect(brief.byModel.map(([name]) => name)).toEqual(["claude-opus-5", "gpt-5.5"]);
  expect(brief.lastWeek).toEqual([0, 0, 0, 0, 0, 63, 163.45]);
  expect(brief.weekBeforeAvgCost).toBe(9);
  expect(brief.monthToDate).toEqual({ cost: 226.45, tokens: 190_800_000 });
});

test("flags devices whose last upload came before the day ended", () => {
  const brief = buildBrief({
    usage,
    // 2026-09-22 ends at 15:00 UTC in Tokyo.
    devices: [
      { device: "laptop", lastSeen: Date.parse("2026-09-22T15:05:00Z") },
      { device: "server", lastSeen: Date.parse("2026-09-22T14:47:00Z") },
    ],
    tz,
    day: "2026-09-22",
  });
  expect(brief.stale.map((s) => s.device)).toEqual(["server"]);
  expect(formatBrief(brief)).toContain("⚠️ server last reported Sep 22, 23:47, so its numbers may be incomplete");
});

test("formats Telegram HTML", () => {
  const html = formatBrief(buildBrief({ usage, devices: [], tz, day: "2026-09-22" }));
  expect(html).toStartWith("<b>AI usage · Tue, Sep 22</b>\n💰 <b>$163.45</b> · 190.8M tokens · ▲1716% vs 7-day avg");
  expect(html).toContain(
    [
      "<pre>agent            cost  tokens",
      "claude        $150.00  150.0M",
      "codex          $13.45   40.8M",
      "",
      "model            cost  tokens",
      "claude-opus-5 $150.00  150.0M",
      "gpt-5.5        $13.45   40.8M</pre>",
    ].join("\n"),
  );
  expect(html).toContain("🗓 September so far: $226.45 · 190.8M tokens");
});

test("shortens model names to fit the table", () => {
  const html = formatBrief(
    buildBrief({
      usage: [
        { date: "2026-09-22", agent: "claude", model: "claude-haiku-4-5-20251001", tokens: 1_000, cost: 1 },
        { date: "2026-09-22", agent: "claude", model: "claude-sonnet-4-5-20250929", tokens: 1_000, cost: 2 },
      ],
      devices: [],
      tz,
      day: "2026-09-22",
    }),
  );
  expect(html).toContain("\nclaude-sonnet-4… $2.00");
  expect(html).toContain("\nclaude-haiku-4-5 $1.00");
});

test("says so when a day has no usage", () => {
  expect(formatBrief(buildBrief({ usage: [], devices: [], tz, day: "2026-09-22" }))).toContain("No usage recorded.");
});

test("the brief comes due at the UTC hour, for the last day that had ended in the zone", () => {
  const at = (iso: string, zone: string, hourUtc: number) => dueBrief(Date.parse(iso), zone, hourUtc);
  expect(at("2026-09-23T00:00:00Z", tz, 0)).toBe("2026-09-22");
  // Sep 24 starts in Tokyo at 15:00 UTC, but the Sep 23 brief waits for 00:00 UTC.
  expect(at("2026-09-23T15:00:00Z", tz, 0)).toBe("2026-09-22");
  expect(at("2026-09-24T00:00:00Z", tz, 0)).toBe("2026-09-23");
  expect(at("2026-09-23T08:59:00Z", tz, 9)).toBeUndefined();
  expect(at("2026-09-23T09:00:00Z", tz, 9)).toBe("2026-09-22");
  // 00:00 UTC is 20:00 the evening before in New York, so the last finished day is two days back.
  expect(at("2026-09-23T00:00:00Z", "America/New_York", 0)).toBe("2026-09-21");
});

test("number helpers", () => {
  expect(tokenCount(999)).toBe("999");
  expect(tokenCount(1_234_567)).toBe("1.2M");
  expect(tokenCount(3_210_000_000)).toBe("3.2B");
  expect(sparkline([0, 1, 2, 4, 8])).toBe("▁▂▃▅█");
});

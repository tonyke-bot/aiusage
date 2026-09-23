import { expect, test } from "bun:test";
import { type DailyRow, parseOptions, toRows } from "../src/collector";

const required = ["--device", "laptop", "--api-url", "https://aiusage.example.workers.dev/", "--api-token", "t"];

test("takes every setting from arguments", () => {
  expect(parseOptions([...required, "--interval", "60", "--once"])).toEqual({
    device: "laptop",
    apiUrl: "https://aiusage.example.workers.dev",
    apiToken: "t",
    timezone: "UTC",
    intervalSeconds: 60,
    retrySeconds: 300,
    lookbackDays: 1,
    offline: false,
    once: true,
  });
});

test("rejects missing, unknown and malformed arguments", () => {
  expect(() => parseOptions(["--device", "laptop"])).toThrow("missing --api-url, --api-token");
  expect(() => parseOptions([...required, "--intervl", "60"])).toThrow("Unknown option '--intervl'");
  expect(() => parseOptions([...required, "--interval", "1h"])).toThrow('--interval must be a whole number, got "1h"');
  expect(() => parseOptions([...required, "--timezone", "CET+1"])).toThrow('--timezone "CET+1" is not an IANA time zone');
  expect(() => parseOptions([...required, "--device", "my laptop"])).toThrow("--device must be");
});

// Shaped like `ccusage daily --json --by-agent` output.
const daily: DailyRow[] = [
  {
    period: "2026-09-22",
    agent: "all",
    agents: [
      {
        agent: "claude",
        modelBreakdowns: [
          {
            modelName: "claude-opus-5",
            inputTokens: 1200,
            outputTokens: 340000,
            cacheCreationTokens: 2500000,
            cacheReadTokens: 98000000,
            cost: 42.5,
          },
        ],
      },
      {
        agent: "codex",
        modelBreakdowns: [{ modelName: "gpt-5.5", inputTokens: 900, outputTokens: 50, cacheReadTokens: 10000, cost: 1.8 }],
      },
    ],
  },
];

test("makes one row per day, agent and model", () => {
  expect(toRows(daily)).toEqual([
    {
      date: "2026-09-22",
      agent: "claude",
      model: "claude-opus-5",
      inputTokens: 1200,
      outputTokens: 340000,
      cacheCreationTokens: 2500000,
      cacheReadTokens: 98000000,
      costUsd: 42.5,
    },
    {
      date: "2026-09-22",
      agent: "codex",
      model: "gpt-5.5",
      inputTokens: 900,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 10000,
      costUsd: 1.8,
    },
  ]);
});

test("falls back to agent totals when there is no model breakdown", () => {
  expect(toRows([{ period: "2026-09-22", agent: "amp", outputTokens: 5, totalCost: 0.5 }])).toEqual([
    {
      date: "2026-09-22",
      agent: "amp",
      model: "unknown",
      inputTokens: 0,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0.5,
    },
  ]);
});

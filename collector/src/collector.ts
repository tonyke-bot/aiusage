import { $ } from "bun";
import { parseArgs } from "node:util";
import { assertZoneinfo, errorMessage, exitOnSignals, log } from "./util";

const DAY_MS = 86_400_000;
const UPLOAD_CHUNK = 500;

const USAGE = `usage: collector --device <name> --api-url <url> --api-token <token> [options]

  --device <name>        this machine's own name: letters, digits, . _ -
  --api-url <url>        the Worker's URL
  --api-token <token>    the Worker's API_TOKEN
  --timezone <zone>      zone that days are cut in, same as the Worker's REPORT_TZ (UTC)
  --interval <seconds>   time between uploads (900)
  --retry <seconds>      wait after a failed upload (300)
  --lookback <days>      extra days resent on each pass (1)
  --offline              price with ccusage's bundled prices instead of current ones
  --once                 upload once and exit`;

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
};

type ModelUsage = Usage & { modelName: string; cost?: number };

type AgentUsage = Usage & { agent: string; totalCost?: number; modelBreakdowns?: ModelUsage[] };

/** A row of `ccusage daily --json --by-agent`. */
export type DailyRow = AgentUsage & { period: string; agents?: AgentUsage[] };

/** A row as the Worker's /ingest endpoint takes it. */
export type UsageRow = {
  date: string;
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
};

export type Options = {
  device: string;
  apiUrl: string;
  apiToken: string;
  timezone: string;
  intervalSeconds: number;
  retrySeconds: number;
  lookbackDays: number;
  offline: boolean;
  once: boolean;
};

export function parseOptions(args: string[]): Options {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        device: { type: "string" },
        "api-url": { type: "string" },
        "api-token": { type: "string" },
        timezone: { type: "string", default: "UTC" },
        interval: { type: "string", default: "900" },
        retry: { type: "string", default: "300" },
        lookback: { type: "string", default: "1" },
        offline: { type: "boolean", default: false },
        once: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    throw new Error(`${errorMessage(error)}\n\n${USAGE}`);
  }
  const { device, "api-url": apiUrl, "api-token": apiToken, timezone } = values;
  if (!device || !apiUrl || !apiToken) {
    const missing = Object.entries({ device, "api-url": apiUrl, "api-token": apiToken }).filter(([, value]) => !value);
    throw new Error(`missing ${missing.map(([name]) => `--${name}`).join(", ")}\n\n${USAGE}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(device)) {
    throw new Error(`--device must be 1-64 letters, digits, dots, dashes or underscores, got "${device}"`);
  }
  if (!URL.canParse(apiUrl)) throw new Error(`--api-url must be a URL, got "${apiUrl}"`);
  // ccusage silently uses the system zone for a --timezone it can't resolve, so a bad name has
  // to be caught here.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`--timezone "${timezone}" is not an IANA time zone such as Europe/Berlin`);
  }
  return {
    device,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    apiToken,
    timezone,
    intervalSeconds: count("--interval", values.interval),
    retrySeconds: count("--retry", values.retry),
    lookbackDays: count("--lookback", values.lookback),
    offline: values.offline,
    once: values.once,
  };
}

function count(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return value;
}

export async function runCcusage(options: { tz: string; lastDays?: number; offline: boolean }): Promise<DailyRow[]> {
  // --single-thread: by default ccusage reads files on every core at once, which peaked at 1.5 GB
  // on a machine with hundreds of cores; one thread took 1.4s and 150 MB for the same logs.
  const args = ["daily", "--json", "--by-agent", "--single-thread", "--timezone", options.tz];
  // --last counts days in --timezone, today included.
  if (options.lastDays) args.push("--last", String(options.lastDays));
  if (options.offline) args.push("--offline");
  const result = await $`ccusage ${args}`.quiet().nothrow();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) throw new Error(`ccusage exited with ${result.exitCode}: ${stderr}`);
  if (stderr) log(`ccusage: ${stderr}`);
  return (JSON.parse(result.stdout.toString()) as { daily: DailyRow[] }).daily;
}

/** One row per day, agent and model. */
export function toRows(daily: DailyRow[]): UsageRow[] {
  return daily.flatMap((day) =>
    (day.agents ?? [day]).flatMap((agent) => {
      const models = agent.modelBreakdowns?.length
        ? agent.modelBreakdowns
        : [{ ...agent, modelName: "unknown", cost: agent.totalCost }];
      return models.map((model) => ({
        date: day.period,
        agent: agent.agent,
        model: model.modelName,
        inputTokens: model.inputTokens ?? 0,
        outputTokens: model.outputTokens ?? 0,
        cacheCreationTokens: model.cacheCreationTokens ?? 0,
        cacheReadTokens: model.cacheReadTokens ?? 0,
        costUsd: model.cost ?? 0,
      }));
    }),
  );
}

/** Sends rows to the Worker, which keeps the larger of the stored and sent values. */
async function upload(options: Options, rows: UsageRow[]): Promise<number> {
  const chunks: UsageRow[][] = [];
  for (let i = 0; i < rows.length; i += UPLOAD_CHUNK) chunks.push(rows.slice(i, i + UPLOAD_CHUNK));
  // An upload without rows still tells the Worker this device is alive.
  if (chunks.length === 0) chunks.push([]);
  let changed = 0;
  for (const chunk of chunks) {
    const response = await fetch(`${options.apiUrl}/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ device: options.device, tz: options.timezone, rows: chunk }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.text();
    if (!response.ok) {
      const hint = response.status === 401 ? " (check --api-token)" : "";
      throw new Error(`upload: HTTP ${response.status}${hint}: ${body.trim().slice(0, 300)}`);
    }
    changed += (JSON.parse(body) as { changed: number }).changed;
  }
  return changed;
}

async function main(): Promise<void> {
  exitOnSignals();
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return console.log(USAGE);
  const options = parseOptions(args);
  assertZoneinfo(options.timezone);

  const version = (await $`ccusage --version`.quiet().text()).trim();
  log(
    `${version}: device=${options.device} tz=${options.timezone}, uploading to ${options.apiUrl} every ${options.intervalSeconds}s`,
  );

  let lastSuccess: number | undefined;
  for (;;) {
    const startedAt = Date.now();
    // The first pass sends all history. Later passes cover every day since the last success
    // plus --lookback more, so crossing midnight or an outage can't leave a day short.
    const lastDays =
      lastSuccess === undefined ? undefined : Math.ceil((startedAt - lastSuccess) / DAY_MS) + 1 + options.lookbackDays;
    try {
      const rows = toRows(await runCcusage({ tz: options.timezone, lastDays, offline: options.offline }));
      const changed = await upload(options, rows);
      lastSuccess = startedAt;
      log(`uploaded ${rows.length} row(s) ${lastDays ? `for the last ${lastDays} days` : "of history"}, ${changed} added or raised`);
    } catch (error) {
      log(`upload failed: ${errorMessage(error)}`);
      if (options.once) process.exit(1);
      await Bun.sleep(options.retrySeconds * 1000);
      continue;
    }
    if (options.once) return;
    await Bun.sleep(options.intervalSeconds * 1000);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    log(errorMessage(error));
    process.exit(1);
  });
}

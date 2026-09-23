import { addDays, dayLabel, dayOf, monthName } from "./time";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The day whose brief is due at `now`: from `hourUtc` on each UTC day, the last day that had
 * ended in `tz` by then. Undefined before that hour.
 */
export function dueBrief(now: number, tz: string, hourUtc: number): string | undefined {
  const due = now - (now % DAY_MS) + hourUtc * HOUR_MS;
  return now < due ? undefined : addDays(dayOf(due, tz), -1);
}

/** A usage row reduced to what the brief shows. */
export type UsageRecord = { date: string; agent: string; model: string; tokens: number; cost: number };

export type Totals = { cost: number; tokens: number };
type Breakdown = [name: string, totals: Totals][];
type DayUsage = { total: Totals; byAgent: Map<string, Totals>; byModel: Map<string, Totals> };

export type Brief = {
  day: string;
  total: Totals;
  byAgent: Breakdown;
  byModel: Breakdown;
  /** Average daily cost over the seven days before `day`. */
  weekBeforeAvgCost: number;
  /** Daily cost for the seven days ending on `day`. */
  lastWeek: number[];
  monthToDate: Totals;
};

const zero = (): Totals => ({ cost: 0, tokens: 0 });

function add(map: Map<string, Totals>, key: string, cost: number, tokens: number): void {
  const totals = map.get(key) ?? zero();
  totals.cost += cost;
  totals.tokens += tokens;
  map.set(key, totals);
}

const byCost = (map: Map<string, Totals> | undefined): Breakdown =>
  [...(map ?? new Map<string, Totals>())].sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens);

export function buildBrief(input: { usage: UsageRecord[]; day: string }): Brief {
  const { day } = input;
  const days = new Map<string, DayUsage>();
  for (const { date, agent, model, tokens, cost } of input.usage) {
    let usage = days.get(date);
    if (!usage) days.set(date, (usage = { total: zero(), byAgent: new Map(), byModel: new Map() }));
    usage.total.cost += cost;
    usage.total.tokens += tokens;
    add(usage.byAgent, agent, cost, tokens);
    // Dated names like claude-haiku-4-5-20251001 would get cut off in the table.
    add(usage.byModel, model.replace(/-\d{8}$/, ""), cost, tokens);
  }
  const on = (date: string) => days.get(date)?.total ?? zero();
  const target = days.get(day);

  const monthToDate = zero();
  for (let date = `${day.slice(0, 8)}01`; date <= day; date = addDays(date, 1)) {
    monthToDate.cost += on(date).cost;
    monthToDate.tokens += on(date).tokens;
  }

  return {
    day,
    total: target?.total ?? zero(),
    byAgent: byCost(target?.byAgent),
    byModel: byCost(target?.byModel).filter(([, t]) => t.cost > 0 || t.tokens > 0),
    weekBeforeAvgCost: Array.from({ length: 7 }, (_, i) => on(addDays(day, i - 7)).cost).reduce((a, b) => a + b, 0) / 7,
    lastWeek: Array.from({ length: 7 }, (_, i) => on(addDays(day, i - 6)).cost),
    monthToDate,
  };
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const usd = (amount: number) =>
  `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function tokenCount(count: number): string {
  for (const [suffix, size] of [["B", 1e9], ["M", 1e6], ["K", 1e3]] as const) {
    if (count >= size) return `${(count / size).toFixed(1)}${suffix}`;
  }
  return String(Math.round(count));
}

const BARS = "▁▂▃▄▅▆▇█";

export function sparkline(values: number[]): string {
  const max = Math.max(...values);
  return values.map((v) => BARS[max > 0 ? Math.round((v / max) * (BARS.length - 1)) : 0]).join("");
}

function table(sections: [title: string, rows: Breakdown][]): string {
  const rows = sections.flatMap(([, r]) => r);
  const nameWidth = Math.min(16, Math.max(...sections.map(([title]) => title.length), ...rows.map(([name]) => name.length)));
  const costWidth = Math.max(4, ...rows.map(([, t]) => usd(t.cost).length));
  const fit = (name: string) => (name.length > nameWidth ? `${name.slice(0, nameWidth - 1)}…` : name.padEnd(nameWidth));
  const line = (name: string, cost: string, tokens: string) => `${fit(name)} ${cost.padStart(costWidth)} ${tokens.padStart(7)}`;
  // Telegram for iOS hides empty lines inside a code block, so the line between the tables holds a
  // zero-width space.
  return sections
    .map(([title, r]) => [line(title, "cost", "tokens"), ...r.map(([n, t]) => line(n, usd(t.cost), tokenCount(t.tokens)))].join("\n"))
    .join("\n\u200b\n");
}

/** The brief as Telegram HTML. */
export function formatBrief(brief: Brief): string {
  const { total } = brief;
  const lines = [`<b>AI usage · ${dayLabel(brief.day)}</b>`];
  if (total.cost === 0 && total.tokens === 0) {
    lines.push("No usage recorded.");
  } else {
    let headline = `💰 <b>${usd(total.cost)}</b> · ${tokenCount(total.tokens)} tokens`;
    if (brief.weekBeforeAvgCost > 0) {
      const change = (total.cost / brief.weekBeforeAvgCost - 1) * 100;
      headline += ` · ${change >= 0 ? "▲" : "▼"}${Math.abs(change).toFixed(0)}% vs 7-day avg`;
    }
    const sections: [string, Breakdown][] = [
      ["agent", brief.byAgent],
      ["model", brief.byModel],
    ];
    lines.push(headline, `<pre>${escapeHtml(table(sections))}</pre>`);
  }

  const week = brief.lastWeek.reduce((a, b) => a + b, 0);
  lines.push(
    "",
    `📈 7 days <code>${sparkline(brief.lastWeek)}</code> ${usd(week)} (${usd(week / 7)}/day)`,
    `🗓 ${monthName(brief.day)} so far: ${usd(brief.monthToDate.cost)} · ${tokenCount(brief.monthToDate.tokens)} tokens`,
  );
  return lines.join("\n");
}

/** Reads what the brief for `day` needs from D1 and renders it. */
export async function composeBrief(db: D1Database, day: string): Promise<string> {
  // Enough history for the month-to-date line and the week before `day`.
  const from = [`${day.slice(0, 8)}01`, addDays(day, -7)].sort()[0]!;
  const { results } = await db
    .prepare(
      `SELECT date, agent, model, cost_usd AS cost,
              input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens AS tokens
       FROM usage WHERE date BETWEEN ?1 AND ?2`,
    )
    .bind(from, day)
    .all<UsageRecord>();
  return formatBrief(buildBrief({ usage: results, day }));
}

/** Tokens and cost one device used on one day with one agent and model. */
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

export type Upload = { device: string; rows: UsageRow[] };

export const MAX_ROWS = 2000;
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"] as const;

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value);
}

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

function parseRow(value: unknown): UsageRow | string {
  if (typeof value !== "object" || value === null) return "must be an object";
  const row = value as Record<string, unknown>;
  if (!isDate(row.date)) return "date must be YYYY-MM-DD";
  if (!isName(row.agent)) return "agent must be a non-empty string";
  if (!isName(row.model)) return "model must be a non-empty string";
  const tokens = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  for (const field of TOKEN_FIELDS) {
    const count = row[field] ?? 0;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      return `${field} must be a non-negative integer`;
    }
    tokens[field] = count;
  }
  const cost = row.costUsd ?? 0;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return "costUsd must be a non-negative number";
  // Rounded so float noise between runs doesn't count as growth.
  return { date: row.date, agent: row.agent, model: row.model, ...tokens, costUsd: Math.round(cost * 1e6) / 1e6 };
}

/** Validates an /ingest body. Returns what is wrong with it as a string. */
export function parseUpload(body: unknown, reportTz: string): Upload | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { device, tz, rows } = body as Record<string, unknown>;
  if (typeof device !== "string" || !DEVICE.test(device)) {
    return "device must be 1-64 letters, digits, dots, dashes or underscores";
  }
  // Rows from collectors in different zones would split days differently and not add up.
  if (tz !== reportTz) {
    return `the collector cuts days in ${JSON.stringify(tz)} but this report uses "${reportTz}"; run the collector with --timezone ${reportTz}`;
  }
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return `rows must be an array of at most ${MAX_ROWS} items`;
  const parsed: UsageRow[] = [];
  for (const [index, value] of rows.entries()) {
    const row = parseRow(value);
    if (typeof row === "string") return `rows[${index}]: ${row}`;
    parsed.push(row);
  }
  return { device, rows: parsed };
}

/**
 * Inserts the rows in the JSON array ?2 for device ?1. An existing row only moves up: each value
 * becomes the larger of the stored and the uploaded one, and a row with nothing larger is left
 * untouched, so it doesn't count as a write.
 */
export const UPSERT_USAGE = `
INSERT INTO usage (device, date, agent, model, input_tokens, output_tokens,
                   cache_creation_tokens, cache_read_tokens, cost_usd, updated_at)
SELECT ?1,
       json_extract(value, '$.date'),
       json_extract(value, '$.agent'),
       json_extract(value, '$.model'),
       json_extract(value, '$.inputTokens'),
       json_extract(value, '$.outputTokens'),
       json_extract(value, '$.cacheCreationTokens'),
       json_extract(value, '$.cacheReadTokens'),
       json_extract(value, '$.costUsd'),
       ?3
FROM json_each(?2)
WHERE true -- an INSERT ... SELECT needs a WHERE clause before ON CONFLICT
ON CONFLICT (device, date, agent, model) DO UPDATE SET
  input_tokens = max(usage.input_tokens, excluded.input_tokens),
  output_tokens = max(usage.output_tokens, excluded.output_tokens),
  cache_creation_tokens = max(usage.cache_creation_tokens, excluded.cache_creation_tokens),
  cache_read_tokens = max(usage.cache_read_tokens, excluded.cache_read_tokens),
  cost_usd = max(usage.cost_usd, excluded.cost_usd),
  updated_at = excluded.updated_at
WHERE excluded.input_tokens > usage.input_tokens
   OR excluded.output_tokens > usage.output_tokens
   OR excluded.cache_creation_tokens > usage.cache_creation_tokens
   OR excluded.cache_read_tokens > usage.cache_read_tokens
   OR excluded.cost_usd > usage.cost_usd`;

export const TOUCH_DEVICE = `
INSERT INTO devices (device, last_seen_at) VALUES (?1, ?2)
ON CONFLICT (device) DO UPDATE SET last_seen_at = max(devices.last_seen_at, excluded.last_seen_at)`;

// Keeps each bound JSON parameter well under D1's size limits.
const ROWS_PER_STATEMENT = 500;

/** Stores an upload in one transaction and reports how many rows were added or raised. */
export async function storeUpload(db: D1Database, upload: Upload, now: number): Promise<{ rows: number; changed: number }> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < upload.rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = upload.rows.slice(i, i + ROWS_PER_STATEMENT);
    statements.push(db.prepare(UPSERT_USAGE).bind(upload.device, JSON.stringify(chunk), now));
  }
  statements.push(db.prepare(TOUCH_DEVICE).bind(upload.device, now));
  const results = await db.batch(statements);
  const changed = results.slice(0, -1).reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  return { rows: upload.rows.length, changed };
}

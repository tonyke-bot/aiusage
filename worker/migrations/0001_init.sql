-- One row per device, day, agent and model. Uploads can only raise values (see src/ingest.ts).
CREATE TABLE usage (
  device TEXT NOT NULL,
  date TEXT NOT NULL,                        -- YYYY-MM-DD, days cut in REPORT_TZ
  agent TEXT NOT NULL,                       -- claude, codex, ...
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,               -- Unix ms of the last increase
  PRIMARY KEY (device, date, agent, model)
);

CREATE INDEX usage_by_date ON usage (date);

-- Last upload per device, including uploads that carried no usage.
CREATE TABLE devices (
  device TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL              -- Unix ms
);

-- Days whose brief went out, so the hourly cron sends each one once.
CREATE TABLE briefs (
  date TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL                   -- Unix ms
);

# aiusage

This collects your daily Claude Code and Codex usage from every machine you work on and sends it
to you as a daily Telegram brief.

Each machine runs a small collector container. Every hour it runs
[ccusage](https://github.com/ryoppippi/ccusage) and uploads that machine's daily usage to a
Cloudflare Worker, which keeps it in D1. Once a day, the Worker sends you a brief of the previous
day:

```
AI usage · Mon, Sep 21
💰 $1,244.15 · 1.3B tokens · ▲19% vs 7-day avg
agent              cost  tokens
claude          $812.40  964.1M
codex           $431.75  318.6M

model              cost  tokens
claude-opus-5   $768.30  902.4M
gpt-5.5         $431.75  318.6M
claude-sonnet-5  $44.10   61.7M

📈 7 days █▆█▇▅▄█ $7,435.45 ($1,062.21/day)
🗓 September so far: $21,255.75 · 21.9B tokens
Days start at 00:00 UTC
```

```
laptop ─┐ collector: ccusage daily --by-agent   Cloudflare
        ├───────────── every hour ────────────▶ Worker POST /ingest ──▶ D1
server ─┘                                       Worker cron, hourly ──▶ Telegram, once a day
```

## Deploy

You need a Cloudflare account, [Bun](https://bun.sh), and Docker on each machine you collect from.

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) and send `/newbot`. It replies with the bot's token.
2. Send your new bot any message, because bots can't start a chat.
3. Open `https://api.telegram.org/bot<token>/getUpdates` and note `message.chat.id`. That is
   the chat the brief goes to.

### 2. Deploy the Worker

```bash
git clone https://github.com/tonyke-bot/aiusage.git
cd aiusage/worker
bun install
cp wrangler.example.jsonc wrangler.jsonc
bunx wrangler login
bunx wrangler d1 create aiusage
```

Put the `database_id` that `d1 create` prints into `wrangler.jsonc`. Set `REPORT_TZ` there to the
time zone your days should start in, and `BRIEF_HOUR_UTC` to the UTC hour the brief should go
out. Then:

```bash
bunx wrangler d1 migrations apply aiusage --remote
bunx wrangler deploy
bunx wrangler secret put API_TOKEN
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_CHAT_ID
```

`deploy` prints the Worker's URL. `API_TOKEN` can be any long random string, such as the output
of `openssl rand -hex 32`. The collectors send it with every upload.

To check the setup, send yesterday's brief right away:

```bash
curl -X POST -H "Authorization: Bearer <API_TOKEN>" https://aiusage.<your-subdomain>.workers.dev/report
```

### 3. Run a collector on each machine

```bash
docker run -d --name aiusage-collector --restart unless-stopped --init \
  --mount type=bind,src="$HOME/.claude/projects",dst=/root/.claude/projects,readonly \
  --mount type=bind,src="$HOME/.codex/sessions",dst=/root/.codex/sessions,readonly \
  --mount type=bind,src="$HOME/.codex/archived_sessions",dst=/root/.codex/archived_sessions,readonly \
  ghcr.io/tonyke-bot/aiusage-collector \
  --device laptop --timezone UTC \
  --api-url https://aiusage.<your-subdomain>.workers.dev --api-token <API_TOKEN>
```

- Give every machine its own `--device` name.
- Pass the same `--timezone` as the Worker's `REPORT_TZ`. The Worker rejects uploads from a
  collector that cuts days in another zone.
- Remove the `--mount` line of any tool the machine doesn't use. A missing folder is an error
  rather than an empty mount.

`docker logs aiusage-collector` should show `uploaded N row(s) of history`. The image supports
linux/amd64 and linux/arm64.

### Updating

To update a collector, run `docker pull ghcr.io/tonyke-bot/aiusage-collector` and
`docker rm -f aiusage-collector`, then run the same `docker run` command again.

To update the Worker, run `git pull`, then
`bunx wrangler d1 migrations apply aiusage --remote` and `bunx wrangler deploy` in `worker/`.

## How it works

### Days

A day starts at 00:00 in `REPORT_TZ`. Every collector runs ccusage with the same `--timezone`, so
a day means the same thing on every machine, whatever its own clock says. The image includes
tzdata, because ccusage quietly falls back to UTC when it can't find a zone.

### Collecting

A collector's first pass after it starts uploads all of the machine's history. Each later pass
uploads every day since its last successful upload, plus `--lookback` more days.

The collector mounts only the log folders, read-only, because `~/.claude` and `~/.codex` also
hold login tokens. Other agents that ccusage reads, such as OpenCode, aren't counted unless you
mount their data as well.

### Storing

| Table     | Key                          | Holds                                                                                                     |
| --------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `usage`   | `device, date, agent, model` | `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `cost_usd`, `updated_at`   |
| `devices` | `device`                     | `last_seen_at`, the time of the device's last upload                                                      |
| `briefs`  | `date`                       | `sent_at`, so each day's brief goes out once                                                              |

**Values only grow.** When an upload hits an existing row, each column keeps the larger of the
stored and the uploaded value. Rows that didn't grow aren't written. Collectors can resend
overlapping days as often as they like. After Claude Code deletes old transcripts, a resend can't
lower the days that were already stored.

This is also why every machine needs its own device name. Two machines under one name would keep
the larger of their numbers instead of adding them up.

To lower a number on purpose, delete its rows and restart that machine's collector, which then
resends all of its history:

```bash
bunx wrangler d1 execute aiusage --remote --command "DELETE FROM usage WHERE device = 'laptop' AND date = '2026-09-21'"
```

### The brief

An hourly cron runs the Worker. From `BRIEF_HOUR_UTC` on each day, it sends one brief for the
last day that has ended in `REPORT_TZ`. If the send fails, the next hour tries again.

The brief shows:

- the day's cost and tokens, compared with the average of the 7 days before it
- cost and tokens by agent and by model
- a 7-day sparkline and the month so far
- a warning for any device that hasn't uploaded since the day ended, since its numbers may be
  incomplete

Tokens are input, output, cache-write and cache-read tokens added together. Cache reads are
usually most of them, and they cost far less per token than the others.

## Reference

### Collector arguments

Everything is an argument after the image name. The collector reads no environment variables.
Run the image with `--help` to list the arguments.

| Argument               | Default  |                                                                                                   |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `--device <name>`      | required | this machine's name in the brief: up to 64 letters, digits, `.`, `_` or `-`                       |
| `--api-url <url>`      | required | the Worker's URL                                                                                  |
| `--api-token <token>`  | required | the Worker's `API_TOKEN`                                                                          |
| `--timezone <zone>`    | `UTC`    | the zone days start in. It must match the Worker's `REPORT_TZ`.                                   |
| `--interval <seconds>` | `3600`   | time between uploads                                                                              |
| `--retry <seconds>`    | `300`    | wait after a failed upload                                                                        |
| `--lookback <days>`    | `1`      | extra days resent on each pass                                                                    |
| `--offline`            | off      | use ccusage's bundled prices instead of current ones. Models newer than the bundle then cost $0.  |
| `--once`               | off      | upload once and exit. The exit code is non-zero if the upload fails.                              |

Anyone who can run `ps` on the host or `docker inspect` on the container can see the arguments,
including the token. Keep that in mind on shared machines.

### Worker settings

| Setting              | Where                      |                                                              |
| -------------------- | -------------------------- | ------------------------------------------------------------ |
| `REPORT_TZ`          | `vars` in `wrangler.jsonc` | the IANA zone days start in (default `UTC`)                  |
| `BRIEF_HOUR_UTC`     | `vars` in `wrangler.jsonc` | the UTC hour from which the daily brief goes out (default 0) |
| `API_TOKEN`          | secret                     | the token that collectors and `/report` requests must send   |
| `TELEGRAM_BOT_TOKEN` | secret                     | the bot's token from @BotFather                              |
| `TELEGRAM_CHAT_ID`   | secret                     | the chat the brief goes to                                   |

### Endpoints

Every request needs `Authorization: Bearer <API_TOKEN>`.

| Endpoint                       | Does                                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /ingest`                 | Takes `{device, tz, rows: [{date, agent, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUsd}]}`, up to 2000 rows per request. Returns `{device, rows, changed}`, where `changed` counts rows that were added or grew. |
| `GET /report?date=YYYY-MM-DD`  | Shows that day's brief as Telegram HTML without sending it. The date defaults to yesterday.                                                                                                                                                        |
| `POST /report?date=YYYY-MM-DD` | Sends that day's brief now. The day's scheduled brief still goes out.                                                                                                                                                                                |

### Collector image

CI builds the collector for linux/amd64 and linux/arm64 and pushes it to
`ghcr.io/tonyke-bot/aiusage-collector`:

| Tag          | Built from                   |
| ------------ | ---------------------------- |
| `latest`     | the latest commit on `main`  |
| `X.Y.Z`      | the git tag `vX.Y.Z`         |
| `sha-<hash>` | a single commit              |

## Development

```bash
cd worker
bun install
bun test && bun run typecheck
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
bunx wrangler d1 migrations apply aiusage --local
bun run dev                                  # http://localhost:8787, with a local D1
```

To run the cron as if it were a given time (Unix milliseconds), for example 00:00 UTC on
2026-09-23:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json&time=1790121600000"
```

After you change bindings or the compatibility date, regenerate `worker-configuration.d.ts` with
`bun run cf-typegen`.

The collector has its own `bun test` and `bun run typecheck` in `collector/`. To build its image
locally, run `docker build -t aiusage-collector collector`.

## Credits

The collector image bundles [ccusage](https://github.com/ryoppippi/ccusage) by ryoppippi, which is
under the MIT license. Its license is in the image at `/usr/share/licenses/ccusage/LICENSE`.

## License

[MIT](LICENSE)

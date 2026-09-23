import { isDate, parseUpload, storeUpload } from "./ingest";
import { composeBrief, dueBrief } from "./report";
import { sendTelegram } from "./telegram";
import { addDays, dayOf } from "./time";

export interface Env {
  DB: D1Database;
  /** IANA zone that days are cut in; collectors must use the same one. */
  REPORT_TZ: string;
  /** UTC hour (0-23) from which the daily brief goes out. */
  BRIEF_HOUR_UTC: string;
  /** Secrets, unset until `wrangler secret put` */
  API_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

const yesterday = (now: number, tz: string) => addDays(dayOf(now, tz), -1);

export default {
  async fetch(request, env): Promise<Response> {
    if (!authorized(request, env.API_TOKEN)) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);

    // Collectors upload their rows here every hour.
    if (url.pathname === "/ingest" && request.method === "POST") {
      const upload = parseUpload(await request.json().catch(() => undefined), env.REPORT_TZ);
      if (typeof upload === "string") return json({ error: upload }, 400);
      return json({ device: upload.device, ...(await storeUpload(env.DB, upload, Date.now())) });
    }

    // GET previews a day's brief (yesterday by default); POST sends it to Telegram now.
    if (url.pathname === "/report" && (request.method === "GET" || request.method === "POST")) {
      const day = url.searchParams.get("date") ?? yesterday(Date.now(), env.REPORT_TZ);
      if (!isDate(day)) return json({ error: "date must be YYYY-MM-DD" }, 400);
      const html = await composeBrief(env.DB, day);
      if (request.method === "GET") return new Response(html, { headers: { "content-type": "text/plain; charset=utf-8" } });
      try {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, html);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
      return json({ sent: day });
    }

    return json({ error: "not found" }, 404);
  },

  // Runs hourly. From BRIEF_HOUR_UTC on it sends the day's brief once, and a failed send is
  // retried the next hour.
  async scheduled(controller, env): Promise<void> {
    const now = controller.scheduledTime;
    const day = dueBrief(now, env.REPORT_TZ, Number(env.BRIEF_HOUR_UTC));
    if (!day) return;
    if (await env.DB.prepare("SELECT 1 FROM briefs WHERE date = ?1").bind(day).first()) return;
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, await composeBrief(env.DB, day));
    await env.DB.prepare("INSERT OR IGNORE INTO briefs (date, sent_at) VALUES (?1, ?2)").bind(day, now).run();
  },
} satisfies ExportedHandler<Env>;

/** Sends an HTML-formatted message through the Telegram Bot API. */
export async function sendTelegram(token: string | undefined, chatId: string | undefined, html: string): Promise<void> {
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // Network errors can echo the request URL, which contains the bot token.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Telegram request failed: ${message.replaceAll(token, "<token>")}`);
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!body.ok) throw new Error(`Telegram rejected the message: ${body.description ?? `HTTP ${response.status}`}`);
}

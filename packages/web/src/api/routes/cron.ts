import type { Context, Hono } from "hono";
import { runSchedulerTick } from "../lib/scheduler";

/**
 * Внешний «будильник» планировщика. Хостинг может усыплять процесс без запросов —
 * тогда setInterval не крутится, и напоминания/тревоги приходят только когда кто-то
 * открыл приложение. Внешний cron (например, cron-job.org) раз в минуту дёргает
 * GET/POST /api/cron/tick?key=<CRON_SECRET> (или заголовок X-Cron-Secret) — тик идёт на сервере.
 */
const cronSecret = () => process.env.CRON_SECRET || process.env.MAX_WEBHOOK_SECRET || "";

export function mountCron(app: Hono) {
  const handler = async (c: Context) => {
    const secret = cronSecret();
    const got = c.req.header("X-Cron-Secret") ?? c.req.query("key");
    if (!secret || got !== secret) return c.json({ ok: false, error: "unauthorized" }, 401);
    const started = Date.now();
    await runSchedulerTick();
    return c.json({ ok: true, ms: Date.now() - started });
  };
  app.get("/api/cron/tick", handler);
  app.post("/api/cron/tick", handler);
}

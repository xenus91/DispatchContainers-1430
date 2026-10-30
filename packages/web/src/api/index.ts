import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { ping } from "./routes/ping";
import { auth } from "./routes/auth";
import { staff } from "./routes/staff";
import { requests } from "./routes/requests";
import { settings } from "./routes/settings";
import { clients } from "./routes/clients";
import { points } from "./routes/points";
import { containerTypes } from "./routes/container-types";
import { operationTypes } from "./routes/operation-types";
import { requestTypes } from "./routes/request-types";
import { notifications } from "./routes/notifications";
import { sessions } from "./routes/sessions";
import { mountCron } from "./routes/cron";
import { ensureSeedAdmin } from "./lib/auth";
import { startScheduler } from "./lib/scheduler";
import { maxConfig } from "./max/client";
import { claimUpdate } from "./max/dedupe";
import { handleUpdate } from "./max/webhook";
import { longPollingEnabled, startLongPolling } from "./max/polling";
import type { MaxUpdate } from "./max/types";

// API features are oRPC procedures, one file per feature in ./routes/,
// composed into this router — typed end-to-end via the clients
// (web: src/web/lib/api.ts, mobile: lib/api.ts).
export const router = {
  ping,
  auth,
  staff,
  requests,
  settings,
  sessions,
  clients,
  points,
  containerTypes,
  operationTypes,
  requestTypes,
  notifications,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);
mountCron(app);

/** MAX Bot API webhook — subscribed via POST /subscriptions (platform-api2.max.ru). */
app.post("/api/webhooks/max", async (c) => {
  const secret = maxConfig.webhookSecret;
  if (secret) {
    const got = c.req.header("X-Max-Bot-Api-Secret");
    if (got !== secret) return c.json({ ok: false, error: "bad secret" }, 401);
  }
  let update: MaxUpdate;
  try {
    update = (await c.req.json()) as MaxUpdate;
  } catch {
    return c.json({ ok: false, error: "bad json" }, 400);
  }
  // MAX retries on non-2xx: answer fast, never fail the delivery on our bug.
  // claimUpdate отсекает повторную доставку того же события (ретраи MAX, второй инстанс).
  claimUpdate(update)
    .then((fresh) => (fresh ? handleUpdate(update) : undefined))
    .catch((err) => {
      console.error("[max webhook] handler failed", err);
    });
  return c.json({ ok: true });
});

void ensureSeedAdmin().catch((err) => console.error("[seed admin]", err));
startScheduler();

// Разработка/тестирование без публичного HTTPS: события бота забираем long polling.
// В продакшене — только вебхук (MAX_LONG_POLLING не выставляем).
if (longPollingEnabled()) startLongPolling();

export default app;

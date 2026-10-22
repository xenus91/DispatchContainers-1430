import { and, eq, isNull, isNotNull, notInArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { reminderMessage } from "../max/messages";
import { purgeProcessedUpdates } from "../max/dedupe";
import { runAccessChecks } from "./access";
import { CLOSED_STATUSES } from "./process-def";
import { notifyDispatchers, notifyStaff } from "./notify";
import { addHistory } from "./requests-service";
import { getSetting, getReminderMinutes } from "./settings";

const TICK_MS = 60_000;

/** Уже отправленные повторные пинги по неподтверждённым тревогам. */
const escalated = new Set<number>();

/** Напоминания водителям по времени выгрузки (интервал берётся из настроек, не из кода). */
async function runReminders() {
  const defaultMinutes = await getReminderMinutes();
  const rows = await db
    .select()
    .from(schema.requests)
    .where(
      and(
        notInArray(schema.requests.status, [...CLOSED_STATUSES]),
        isNull(schema.requests.reminderSentAt),
        isNotNull(schema.requests.unloadAt),
        isNotNull(schema.requests.driverId),
      ),
    );

  const now = Date.now();
  for (const request of rows) {
    if (!request.unloadAt || !request.driverId) continue;
    const minutes = request.reminderMinutes ?? defaultMinutes;
    const fireAt = request.unloadAt.getTime() - minutes * 60_000;
    if (now < fireAt) continue;
    // Срок выгрузки уже прошёл более чем на сутки — напоминание бессмысленно.
    if (now > request.unloadAt.getTime() + 86_400_000) continue;

    const left = Math.max(0, Math.round((request.unloadAt.getTime() - now) / 60_000));
    const result = await notifyStaff(request.driverId, reminderMessage(request, left));
    await db
      .update(schema.requests)
      .set({ reminderSentAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.requests.id, request.id));
    await addHistory({
      requestId: request.id,
      status: "reminder",
      actorKind: "system",
      comment: `Напоминание за ${minutes} мин${result.ok ? "" : ` (ошибка доставки: ${result.error ?? "неизвестно"})`}`,
    });
  }
}

/** Повторный пинг диспетчерам по тревогам, которые долго не подтверждены. */
async function runAlertEscalation() {
  const minutesRaw = await getSetting("alertEscalateMinutes");
  const minutes = Number.parseInt(minutesRaw, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const open = await db.select().from(schema.alerts).where(isNull(schema.alerts.acknowledgedAt));
  for (const alert of open) {
    if (escalated.has(alert.id)) continue;
    if (Date.now() - alert.createdAt.getTime() < minutes * 60_000) continue;
    const [request] = await db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.id, alert.requestId));
    escalated.add(alert.id);
    await notifyDispatchers({
      text:
        `❗️ *Тревога не подтверждена ${minutes} мин*\n` +
        `Заявка ${request?.number ?? alert.requestId} · ${alert.type === "failure" ? "Срыв заявки" : "Возможно опоздание"}\n` +
        `Водитель: ${alert.raisedByName ?? "—"}\nПодтвердите сигнал в панели диспетчеризации.`,
      format: "markdown",
    }, { event: "alert_escalation", request });
  }
}

async function tick() {
  try {
    await runReminders();
    await runAlertEscalation();
    await runAccessChecks();
    await purgeProcessedUpdates();
  } catch (e) {
    console.error("[scheduler] tick failed:", e instanceof Error ? e.message : e);
  }
}

/** Запускается один раз на процесс (защита от повторного запуска при hot-reload). */
export function startScheduler() {
  const g = globalThis as unknown as { __maxDispatchScheduler?: ReturnType<typeof setInterval> };
  if (g.__maxDispatchScheduler) return;
  g.__maxDispatchScheduler = setInterval(tick, TICK_MS);
  void tick();
  console.log("[scheduler] планировщик напоминаний запущен");
}

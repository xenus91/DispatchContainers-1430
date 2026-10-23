import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { reminderMessage } from "../max/messages";
import { purgeProcessedUpdates } from "../max/dedupe";
import { runAccessChecks } from "./access";
import { notifyDispatchers, notifyStaff } from "./notify";
import { addHistory, raiseAlert } from "./requests-service";
import { getStops, loadContext } from "./route";
import { ALERT_LABELS, stopDone } from "./route-def";
import { getReminderMinutes, getSetting, getStopLateMinutes } from "./settings";

const TICK_MS = 60_000;
const DAY_MS = 86_400_000;

/** Уже отправленные повторные пинги по неподтверждённым тревогам. */
const escalated = new Set<number>();

/**
 * По остановкам маршрута: напоминание водителю за N минут до планового прибытия
 * и тревога диспетчерам, если через M минут после плана остановка не начата.
 * И то и другое — не чаще одного раза на остановку (reminder_sent_at / late_alert_at).
 */
export async function runStopTimers() {
  const [defaultReminder, lateMinutes] = await Promise.all([getReminderMinutes(), getStopLateMinutes()]);
  const requests = await db
    .select()
    .from(schema.requests)
    .where(
      and(
        inArray(schema.requests.status, ["assigned", "accepted", "in_progress"]),
        isNotNull(schema.requests.driverId),
      ),
    );
  const now = Date.now();

  for (const request of requests) {
    if (!request.driverId) continue;
    const stops = (await getStops(request.id)).filter((s) => !s.doneAt);
    const current = stops[0];
    const reminderMinutes = request.reminderMinutes ?? defaultReminder;

    for (const stop of stops) {
      const planned = stop.plannedArrivalAt?.getTime();
      if (!planned || stop.reminderSentAt || stop.arrivedAt || stopDone(stop).length) continue;
      if (now < planned - reminderMinutes * 60_000 || now > planned + DAY_MS) continue;
      // Отметка до отправки: при сбое доставки повторов не будет.
      const [claimed] = await db
        .update(schema.requestStops)
        .set({ reminderSentAt: new Date() })
        .where(and(eq(schema.requestStops.id, stop.id), isNull(schema.requestStops.reminderSentAt)))
        .returning();
      if (!claimed) continue;
      const ctx = await loadContext(request);
      const view = ctx.stops.find((v) => v.stop.id === stop.id);
      if (!view) continue;
      const left = Math.max(0, Math.round((planned - now) / 60_000));
      const result = await notifyStaff(request.driverId, reminderMessage(ctx, view, left));
      await addHistory({
        requestId: request.id,
        status: "reminder",
        actorKind: "system",
        stopId: stop.id,
        comment: `Напоминание за ${reminderMinutes} мин${result.ok ? "" : ` (ошибка доставки: ${result.error ?? "неизвестно"})`}`,
      });
    }

    // Тревога — только по текущей (первой непройденной) остановке, если она не начата.
    const planned = current?.plannedArrivalAt?.getTime();
    if (!current || !planned || current.lateAlertAt || current.arrivedAt || stopDone(current).length) continue;
    if (now < planned + lateMinutes * 60_000 || now > planned + DAY_MS) continue;
    const [claimed] = await db
      .update(schema.requestStops)
      .set({ lateAlertAt: new Date() })
      .where(and(eq(schema.requestStops.id, current.id), isNull(schema.requestStops.lateAlertAt)))
      .returning();
    if (!claimed) continue;
    const [driver] = await db.select().from(schema.staff).where(eq(schema.staff.id, request.driverId));
    await raiseAlert({
      request,
      type: "stop_late",
      stopId: current.id,
      driver: driver ?? null,
      message: `Нет отметки через ${lateMinutes} мин после планового прибытия`,
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
        `Заявка ${request?.number ?? alert.requestId} · ${ALERT_LABELS[alert.type] ?? alert.type}\n` +
        (alert.raisedByName ? `Поднял: ${alert.raisedByName}\n` : "") +
        `Подтвердите сигнал в панели диспетчеризации.`,
      format: "markdown",
    }, { event: "alert_escalation", request });
  }
}

async function tick() {
  try {
    await runStopTimers();
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

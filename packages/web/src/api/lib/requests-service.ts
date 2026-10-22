import { and, desc, eq, isNull, like } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { alertNotification, statusNotification } from "../max/messages";
import { notifyDispatchers } from "./notify";
import { getProcess } from "./process";
import { isClosedStatus, nextStep, statusLabel, type ProcessDef } from "./process-def";

type RequestRow = typeof schema.requests.$inferSelect;
type StaffRow = typeof schema.staff.$inferSelect;

/** Следующий человекочитаемый номер заявки: З-2026-0001. */
export async function nextRequestNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `З-${year}-`;
  const [last] = await db
    .select({ number: schema.requests.number })
    .from(schema.requests)
    .where(like(schema.requests.number, `${prefix}%`))
    .orderBy(desc(schema.requests.number))
    .limit(1);
  const seq = last ? Number.parseInt(last.number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

export async function getRequest(id: number): Promise<RequestRow | null> {
  const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, id));
  return row ?? null;
}

export async function addHistory(entry: {
  requestId: number;
  status: string;
  actorKind?: "driver" | "dispatcher" | "system";
  actorId?: number | null;
  actorName?: string | null;
  comment?: string | null;
  latitude?: string | null;
  longitude?: string | null;
}) {
  const [row] = await db
    .insert(schema.statusHistory)
    .values({
      requestId: entry.requestId,
      status: entry.status,
      actorKind: entry.actorKind ?? "system",
      actorId: entry.actorId ?? null,
      actorName: entry.actorName ?? null,
      comment: entry.comment ?? null,
      latitude: entry.latitude ?? null,
      longitude: entry.longitude ?? null,
    })
    .returning();
  return row;
}

/** Разрешён ли переход водителем: только на следующий шаг процесса. */
export function canDriverAdvance(process: ProcessDef, current: string, target: string): boolean {
  if (isClosedStatus(current)) return false;
  return nextStep(process, current)?.key === target;
}

/**
 * Смена статуса водителем: атомарная запись (защита от двойного нажатия и
 * устаревших кнопок), история, уведомление диспетчерам по их настройкам.
 * Карточку водителя актуализирует вызывающий код.
 */
export async function applyDriverStatus(params: {
  request: RequestRow;
  driver: StaffRow;
  status: string;
  comment?: string | null;
  photos?: number;
  process?: ProcessDef;
}) {
  const { request, driver, status, comment, photos } = params;
  const process = params.process ?? (await getProcess());
  if (!canDriverAdvance(process, request.status, status)) {
    return {
      ok: false as const,
      error: `«${statusLabel(process, status)}» недоступно из статуса «${statusLabel(process, request.status)}»`,
    };
  }

  const patch: Partial<typeof schema.requests.$inferInsert> = {
    status,
    updatedAt: new Date(),
  };
  if (status === "delivered") patch.deliveredAt = new Date();

  // Условие по текущему статусу: повторное/запоздалое нажатие ничего не меняет.
  const [updated] = await db
    .update(schema.requests)
    .set(patch)
    .where(and(eq(schema.requests.id, request.id), eq(schema.requests.status, request.status)))
    .returning();
  if (!updated) {
    return { ok: false as const, error: "Статус заявки уже изменился — откройте актуальную карточку." };
  }

  await addHistory({
    requestId: request.id,
    status,
    actorKind: "driver",
    actorId: driver.id,
    actorName: driver.fullName,
    comment: comment ?? null,
  });

  await notifyDispatchers(
    statusNotification({ request: updated, status, driverName: driver.fullName, comment, photos, process }),
    // Исполнитель (например, админ на тестовом рейсе) сам себе дубль не получает.
    { event: `status:${status}`, request: updated, excludeStaffId: driver.id },
  );

  return { ok: true as const, request: updated };
}

/** Тревожное событие от водителя — выделенное уведомление диспетчерам. */
export async function raiseAlert(params: {
  request: RequestRow;
  type: "late" | "failure" | "security" | "no_contact";
  raisedBy?: StaffRow | null;
  message?: string | null;
}) {
  const { request, type, raisedBy, message } = params;

  // Повторное нажатие той же тревожной кнопки, пока диспетчер не подтвердил, — без новой рассылки.
  const [open] = await db
    .select()
    .from(schema.alerts)
    .where(
      and(
        eq(schema.alerts.requestId, request.id),
        eq(schema.alerts.type, type),
        isNull(schema.alerts.acknowledgedAt),
      ),
    )
    .limit(1);
  if (open) return { alert: open, duplicate: true as const };

  const [alert] = await db
    .insert(schema.alerts)
    .values({
      requestId: request.id,
      type,
      message: message ?? null,
      raisedById: raisedBy?.id ?? null,
      raisedByName: raisedBy?.fullName ?? null,
    })
    .returning();

  await addHistory({
    requestId: request.id,
    status: type === "failure" ? "alert_failure" : "alert_late",
    actorKind: raisedBy ? "driver" : "system",
    actorId: raisedBy?.id ?? null,
    actorName: raisedBy?.fullName ?? null,
    comment: message ?? null,
  });

  await notifyDispatchers(
    alertNotification({
      request,
      type,
      driverName: raisedBy?.fullName ?? "—",
      driverPhone: raisedBy?.phone ?? null,
      message,
    }),
    {
      event: type === "failure" ? "alert_failure" : "alert_late",
      request,
      // Диспетчер, поднявший тревогу из панели, сам себе сообщение не получает.
      // Тот, кто поднял тревогу (диспетчер из панели или админ на тестовом рейсе), сам её не получает.
      excludeStaffId: raisedBy?.id,
    },
  );

  return { alert, duplicate: false as const };
}

export async function addAttachment(entry: {
  requestId: number;
  historyId?: number | null;
  uploadedById?: number | null;
  kind: string;
  fileName?: string | null;
  maxToken?: string | null;
  maxUrl?: string | null;
  sizeBytes?: number | null;
}) {
  const [row] = await db
    .insert(schema.attachments)
    .values({
      requestId: entry.requestId,
      historyId: entry.historyId ?? null,
      uploadedById: entry.uploadedById ?? null,
      kind: entry.kind,
      fileName: entry.fileName ?? null,
      maxToken: entry.maxToken ?? null,
      maxUrl: entry.maxUrl ?? null,
      sizeBytes: entry.sizeBytes ?? null,
    })
    .returning();
  return row;
}

/** Активная заявка водителя — та, по которой он сейчас работает. */
export async function activeRequestForDriver(driverId: number): Promise<RequestRow | null> {
  const rows = await db
    .select()
    .from(schema.requests)
    .where(eq(schema.requests.driverId, driverId))
    .orderBy(desc(schema.requests.updatedAt));
  return rows.find((r) => !isClosedStatus(r.status)) ?? null;
}

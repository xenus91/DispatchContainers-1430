import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { dispatcherOnly } from "../lib/auth";
import { CLOSED_STATUSES, isClosedStatus } from "../lib/process-def";
import { notifyStaff, refreshDriverCard, reissueDriverCard, sendDriverCard } from "../lib/notify";
import {
  addHistory,
  getRequest,
  nextRequestNumber,
  raiseAlert,
} from "../lib/requests-service";

const requestFields = z.object({
  containerNo: z.string().min(2),
  containerType: z.string().optional(),
  cargoWeight: z.string().optional(),
  loadingPoint: z.string().optional(),
  tripDate: z.string().optional(),
  /** ISO-строка из формы */
  unloadAt: z.string().optional().nullable(),
  unloadAddress: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  consignee: z.string().optional(),
  returnPoint: z.string().optional(),
  returnAddress: z.string().optional(),
  coordinates: z.string().optional(),
  terminalPhone: z.string().optional(),
  schedule: z.string().optional(),
  comment: z.string().optional(),
  driverId: z.number().nullable().optional(),
  reminderMinutes: z.number().min(5).max(2880).nullable().optional(),
});

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeValues(input: z.infer<typeof requestFields>) {
  const trim = (v: string | undefined) => (v?.trim() ? v.trim() : null);
  return {
    containerNo: input.containerNo.trim().toUpperCase(),
    containerType: trim(input.containerType),
    cargoWeight: trim(input.cargoWeight),
    loadingPoint: trim(input.loadingPoint),
    tripDate: trim(input.tripDate),
    unloadAt: toDate(input.unloadAt),
    unloadAddress: trim(input.unloadAddress),
    contactName: trim(input.contactName),
    contactPhone: trim(input.contactPhone),
    consignee: trim(input.consignee),
    returnPoint: trim(input.returnPoint),
    returnAddress: trim(input.returnAddress),
    coordinates: trim(input.coordinates),
    terminalPhone: trim(input.terminalPhone),
    schedule: trim(input.schedule),
    comment: trim(input.comment),
    reminderMinutes: input.reminderMinutes ?? null,
  };
}

/**
 * Исполнитель заявки — водитель. Исключение для тестов: администратор может
 * назначить рейс на себя (только на себя), чтобы пройти весь процесс в боте.
 */
async function assertAssignable(driverId: number, actor: { id: number; role: string }) {
  const [driver] = await db.select().from(schema.staff).where(eq(schema.staff.id, driverId));
  const selfTest = !!driver && driver.role === "admin" && actor.role === "admin" && driver.id === actor.id;
  if (!driver || (driver.role !== "driver" && !selfTest)) {
    throw new ORPCError("BAD_REQUEST", { message: "Водитель не найден" });
  }
  if (driver.status === "blocked") {
    throw new ORPCError("BAD_REQUEST", { message: `${driver.fullName} заблокирован — назначение невозможно` });
  }
  // Водителя без регистрации в боте назначить можно: карточка заявки уйдёт ему
  // автоматически сразу после активации по инвайт-ссылке.
  return driver;
}

export const requests = {
  /** Список заявок с водителем и признаком открытой тревоги. */
  list: dispatcherOnly
    .input(
      z
        .object({
          scope: z.enum(["active", "all", "archive"]).default("active"),
          status: z.string().min(1).max(32).optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const scope = input?.scope ?? "active";
      const rows = input?.status
        ? await db.select().from(schema.requests).where(eq(schema.requests.status, input.status))
        : scope === "active"
          ? await db.select().from(schema.requests).where(notInArray(schema.requests.status, [...CLOSED_STATUSES]))
          : scope === "archive"
            ? await db
                .select()
                .from(schema.requests)
                .where(inArray(schema.requests.status, [...CLOSED_STATUSES]))
            : await db.select().from(schema.requests);

      const driverIds = [...new Set(rows.map((r) => r.driverId).filter((v): v is number => !!v))];
      const drivers = driverIds.length
        ? await db.select().from(schema.staff).where(inArray(schema.staff.id, driverIds))
        : [];
      const openAlerts = await db.select().from(schema.alerts).where(isNull(schema.alerts.acknowledgedAt));

      return rows
        .map((row) => {
          const driver = drivers.find((d) => d.id === row.driverId);
          const alerts = openAlerts.filter((a) => a.requestId === row.id);
          return {
            ...row,
            driverName: driver?.fullName ?? null,
            driverPhone: driver?.phone ?? null,
            driverVehicle: driver?.vehicle ?? null,
            openAlertTypes: alerts.map((a) => a.type),
            isLate:
              !!row.unloadAt &&
              row.unloadAt.getTime() < Date.now() &&
              !isClosedStatus(row.status),
          };
        })
        .sort((a, b) => {
          const aAlert = a.openAlertTypes.length ? 1 : 0;
          const bAlert = b.openAlertTypes.length ? 1 : 0;
          if (aAlert !== bAlert) return bAlert - aAlert;
          const aTime = a.unloadAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const bTime = b.unloadAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return aTime - bTime;
        });
    }),

  /** Карточка заявки: поля, история, вложения, тревоги. */
  get: dispatcherOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const request = await getRequest(input.id);
    if (!request) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });

    const [history, files, alertRows] = await Promise.all([
      db
        .select()
        .from(schema.statusHistory)
        .where(eq(schema.statusHistory.requestId, input.id))
        .orderBy(desc(schema.statusHistory.id)),
      db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.requestId, input.id))
        .orderBy(desc(schema.attachments.id)),
      db
        .select()
        .from(schema.alerts)
        .where(eq(schema.alerts.requestId, input.id))
        .orderBy(desc(schema.alerts.id)),
    ]);

    const driver = request.driverId
      ? (await db.select().from(schema.staff).where(eq(schema.staff.id, request.driverId)))[0]
      : null;

    return {
      request,
      driver: driver
        ? {
            id: driver.id,
            fullName: driver.fullName,
            phone: driver.phone,
            vehicle: driver.vehicle,
            status: driver.status,
          }
        : null,
      history,
      attachments: files,
      alerts: alertRows,
    };
  }),

  create: dispatcherOnly.input(requestFields).handler(async ({ input, context }) => {
    const values = normalizeValues(input);
    if (input.driverId) await assertAssignable(input.driverId, context.user);

    const number = await nextRequestNumber();
    const [row] = await db
      .insert(schema.requests)
      .values({
        ...values,
        number,
        status: input.driverId ? "assigned" : "new",
        driverId: input.driverId ?? null,
        createdById: context.user.id,
        assignedAt: input.driverId ? new Date() : null,
      })
      .returning();
    if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось создать заявку" });

    await addHistory({
      requestId: row.id,
      status: "created",
      actorKind: "dispatcher",
      actorId: context.user.id,
      actorName: context.user.fullName,
    });

    if (row.driverId) {
      await addHistory({
        requestId: row.id,
        status: "assigned",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
      });
      const sent = await sendDriverCard(row, `Новая заявка ${row.number}`);
      return { ...row, delivery: sent };
    }
    return { ...row, delivery: null };
  }),

  update: dispatcherOnly
    .input(requestFields.extend({ id: z.number() }))
    .handler(async ({ input, context }) => {
      const current = await getRequest(input.id);
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      if (current.status === "cancelled") {
        throw new ORPCError("BAD_REQUEST", { message: "Отменённую заявку нельзя редактировать" });
      }

      const values = normalizeValues(input);
      const reminderChanged =
        values.unloadAt?.getTime() !== current.unloadAt?.getTime() ||
        values.reminderMinutes !== current.reminderMinutes;

      const [row] = await db
        .update(schema.requests)
        .set({
          ...values,
          updatedAt: new Date(),
          reminderSentAt: reminderChanged ? null : current.reminderSentAt,
        })
        .where(eq(schema.requests.id, input.id))
        .returning();
      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось сохранить заявку" });

      await addHistory({
        requestId: row.id,
        status: "updated",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
      });

      if (row.driverId) {
        // Одна свежая карточка внизу чата; у прежней снимаются кнопки.
        await reissueDriverCard(row, `✏️ Заявка ${row.number} обновлена диспетчером — проверьте данные`);
      }
      return row;
    }),

  /** Назначение и переназначение водителя. */
  assign: dispatcherOnly
    .input(z.object({ id: z.number(), driverId: z.number() }))
    .handler(async ({ input, context }) => {
      const current = await getRequest(input.id);
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      if (current.status === "cancelled" || current.status === "delivered") {
        throw new ORPCError("BAD_REQUEST", { message: "Заявка уже закрыта" });
      }
      const driver = await assertAssignable(input.driverId, context.user);
      const previousDriverId = current.driverId;
      if (previousDriverId === driver.id) {
        throw new ORPCError("BAD_REQUEST", { message: "Заявка уже назначена этому водителю" });
      }

      // Старому водителю снимаем кнопки и уведомляем об отзыве.
      if (previousDriverId) {
        if (current.driverMessageId) {
          await refreshDriverCard(
            { ...current, status: "cancelled" },
            `Заявка ${current.number} переназначена другому водителю`,
          );
        }
        await notifyStaff(previousDriverId, {
          text: `🚫 *Заявка ${current.number} снята с вас* и передана другому водителю. Действия по ней больше недоступны.`,
          format: "markdown",
        });
      }

      const [row] = await db
        .update(schema.requests)
        .set({
          driverId: driver.id,
          status: "assigned",
          assignedAt: new Date(),
          driverMessageId: null,
          reminderSentAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.requests.id, input.id))
        .returning();
      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось назначить водителя" });

      await addHistory({
        requestId: row.id,
        status: previousDriverId ? "reassigned" : "assigned",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
        comment: `Водитель: ${driver.fullName}`,
      });

      const sent = await sendDriverCard(row, `Новая заявка ${row.number}`);
      return { ...row, delivery: sent };
    }),

  cancel: dispatcherOnly
    .input(z.object({ id: z.number(), reason: z.string().optional() }))
    .handler(async ({ input, context }) => {
      const current = await getRequest(input.id);
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      if (current.status === "cancelled") return current;

      const [row] = await db
        .update(schema.requests)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: input.reason?.trim() || null,
          updatedAt: new Date(),
        })
        .where(eq(schema.requests.id, input.id))
        .returning();
      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Не удалось отменить заявку" });

      await addHistory({
        requestId: row.id,
        status: "cancelled",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
        comment: input.reason?.trim() || null,
      });

      if (row.driverId) {
        await refreshDriverCard(row, `Заявка ${row.number} отменена`);
        await notifyStaff(row.driverId, {
          text:
            `🚫 *Заявка ${row.number} отменена диспетчером.*` +
            (input.reason?.trim() ? `\nПричина: ${input.reason.trim()}` : ""),
          format: "markdown",
        });
      }
      // Закрываем неподтверждённые тревоги по отменённой заявке.
      await db
        .update(schema.alerts)
        .set({ acknowledgedAt: new Date(), acknowledgedById: context.user.id })
        .where(and(eq(schema.alerts.requestId, row.id), isNull(schema.alerts.acknowledgedAt)));
      return row;
    }),

  /** Повторная отправка карточки водителю (если он «потерял» сообщение). */
  resendCard: dispatcherOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const request = await getRequest(input.id);
    if (!request) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
    if (!request.driverId) throw new ORPCError("BAD_REQUEST", { message: "Водитель не назначен" });
    return reissueDriverCard(request, `Заявка ${request.number}`);
  }),

  /** Диспетчер может добавить комментарий в историю (и переслать водителю). */
  addComment: dispatcherOnly
    .input(z.object({ id: z.number(), comment: z.string().min(1), notifyDriver: z.boolean().default(false) }))
    .handler(async ({ input, context }) => {
      const request = await getRequest(input.id);
      if (!request) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      await addHistory({
        requestId: request.id,
        status: "comment",
        actorKind: "dispatcher",
        actorId: context.user.id,
        actorName: context.user.fullName,
        comment: input.comment.trim(),
      });
      if (input.notifyDriver && request.driverId) {
        await notifyStaff(request.driverId, {
          text: `💬 *Диспетчер по заявке ${request.number}:*\n${input.comment.trim()}`,
          format: "markdown",
        });
      }
      return { ok: true };
    }),

  /** Лента открытых тревог для шапки панели. */
  openAlerts: dispatcherOnly.handler(async () => {
    const rows = await db
      .select()
      .from(schema.alerts)
      .where(isNull(schema.alerts.acknowledgedAt))
      .orderBy(desc(schema.alerts.id));
    const ids = [...new Set(rows.map((r) => r.requestId))];
    const reqs = ids.length
      ? await db.select().from(schema.requests).where(inArray(schema.requests.id, ids))
      : [];
    return rows.map((alert) => {
      const request = reqs.find((r) => r.id === alert.requestId);
      return {
        ...alert,
        requestNumber: request?.number ?? null,
        containerNo: request?.containerNo ?? null,
        unloadAt: request?.unloadAt ?? null,
        requestStatus: request?.status ?? null,
      };
    });
  }),

  acknowledgeAlert: dispatcherOnly
    .input(z.object({ alertId: z.number() }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .update(schema.alerts)
        .set({ acknowledgedAt: new Date(), acknowledgedById: context.user.id })
        .where(eq(schema.alerts.id, input.alertId))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Тревога не найдена" });
      return row;
    }),

  /** Диспетчер сам может поднять тревогу (например, водитель сообщил по телефону). */
  raiseAlert: dispatcherOnly
    .input(
      z.object({
        id: z.number(),
        type: z.enum(["late", "failure", "no_contact"]),
        message: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const request = await getRequest(input.id);
      if (!request) throw new ORPCError("NOT_FOUND", { message: "Заявка не найдена" });
      return raiseAlert({
        request,
        type: input.type,
        raisedBy: context.user,
        message: input.message?.trim() || null,
      });
    }),

  /** Сводка для дашборда. */
  stats: dispatcherOnly.handler(async () => {
    const rows = await db.select().from(schema.requests);
    const openAlerts = await db.select().from(schema.alerts).where(isNull(schema.alerts.acknowledgedAt));
    const active = rows.filter((r) => !isClosedStatus(r.status));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return {
      active: active.length,
      unassigned: rows.filter((r) => r.status === "new").length,
      late: active.filter((r) => r.unloadAt && r.unloadAt.getTime() < Date.now()).length,
      deliveredToday: rows.filter((r) => r.deliveredAt && r.deliveredAt >= today).length,
      openAlerts: openAlerts.length,
    };
  }),
};

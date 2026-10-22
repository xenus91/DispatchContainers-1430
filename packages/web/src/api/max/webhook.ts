import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { approveStaff, completeActivation, rejectStaff, signOutEverywhere } from "../lib/access";
import { findStaffByMaxUserId, logAccess, touchActivity } from "../lib/auth";
import { canExecute, normalizePhone } from "../lib/domain";
import {
  notifyDispatchers,
  refreshDriverCard,
  reissueDriverCard,
  rememberDriverCard,
  sendDriverCard,
} from "../lib/notify";
import { getProcess } from "../lib/process";
import { availableActions, isClosedStatus, nextStep, type ProcessDef } from "../lib/process-def";
import {
  activeRequestForDriver,
  addAttachment,
  addHistory,
  applyDriverStatus,
  getRequest,
  raiseAlert,
} from "../lib/requests-service";
import { answerCallback, sendMessage } from "./client";
import {
  awaitingApprovalMessage,
  CB,
  contactRequestMessage,
  driverCardMessage,
  keyboard,
  nameConfirmMessage,
  noAccessMessage,
  parseCallback,
  stepConfirmPrompt,
  stepPhotoPrompt,
} from "./messages";
import type { MaxNewMessageBody, MaxUpdate } from "./types";

type StaffRow = typeof schema.staff.$inferSelect;

/* ─────────────── состояние диалога ─────────────── */

async function getState(maxUserId: string) {
  const [row] = await db.select().from(schema.botState).where(eq(schema.botState.maxUserId, maxUserId));
  return row ?? null;
}

async function setState(
  maxUserId: string,
  patch: Partial<typeof schema.botState.$inferInsert>,
) {
  await db
    .insert(schema.botState)
    .values({ maxUserId, step: "idle", ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.botState.maxUserId,
      set: { ...patch, updatedAt: new Date() },
    });
}

async function clearStep(maxUserId: string) {
  await setState(maxUserId, { step: "idle", requestId: null, dataJson: null });
}

/** Телефон из VCF, который MAX присылает вместе с подписью `hash`. */
export function phoneFromVcf(vcf: string | undefined | null): string | null {
  if (!vcf) return null;
  const match = vcf.match(/TEL[^:]*:([+\d()\-\s]+)/i);
  if (!match) return null;
  const normalized = normalizePhone(match[1] ?? "");
  return normalized || null;
}

async function reply(maxUserId: string, staffId: number | null, body: Parameters<typeof sendMessage>[0]["body"]) {
  await sendMessage({ maxUserId, staffId, body });
}

/* ─────────────── bot_started: вход по инвайту ─────────────── */

async function handleBotStarted(update: MaxUpdate) {
  const maxUserId = String(update.user?.user_id ?? update.user_id ?? "");
  if (!maxUserId) return;
  const chatId = update.chat_id ? String(update.chat_id) : null;
  const code = (update.payload ?? "").trim().toUpperCase();

  const existing = await findStaffByMaxUserId(maxUserId);
  if (existing && existing.status === "active") {
    if (chatId && existing.maxChatId !== chatId) {
      await db.update(schema.staff).set({ maxChatId: chatId }).where(eq(schema.staff.id, existing.id));
    }
    const active = canExecute(existing.role) ? await activeRequestForDriver(existing.id) : null;
    if (active) {
      await reissueDriverCard(active, `С возвращением, ${existing.fullName}!\nАктивная заявка ${active.number}`);
      return;
    }
    await reply(maxUserId, existing.id, {
      text: `С возвращением, ${existing.fullName}! Активных заявок нет — ожидайте назначения от диспетчера.`,
      format: "markdown",
    });
    return;
  }
  if (existing && existing.status === "blocked") {
    await logAccess({ kind: "blocked_attempt", staffId: existing.id, maxUserId });
    await reply(maxUserId, existing.id, noAccessMessage);
    return;
  }
  if (existing && existing.status === "awaiting_approval") {
    await reply(maxUserId, existing.id, awaitingApprovalMessage);
    return;
  }

  if (!code) {
    await logAccess({ kind: "stranger", maxUserId, detail: "bot_started без инвайт-кода" });
    await reply(maxUserId, null, noAccessMessage);
    return;
  }

  const [invite] = await db.select().from(schema.invites).where(eq(schema.invites.code, code));
  if (!invite || invite.revokedAt || invite.usedAt) {
    await logAccess({
      kind: "invite_invalid",
      maxUserId,
      detail: invite ? "Инвайт уже использован или отозван" : `Код не найден: ${code}`,
    });
    await reply(maxUserId, null, noAccessMessage);
    return;
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    await logAccess({ kind: "invite_expired", staffId: invite.staffId, maxUserId, detail: code });
    await reply(maxUserId, null, {
      text: "Срок действия приглашения истёк. Попросите администратора выпустить новое.",
      format: "markdown",
    });
    return;
  }

  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, invite.staffId));
  if (!member || member.status === "blocked") {
    await logAccess({ kind: "invite_invalid", maxUserId, detail: "Карточка сотрудника недоступна" });
    await reply(maxUserId, null, noAccessMessage);
    return;
  }

  await logAccess({ kind: "invite_ok", staffId: member.id, maxUserId, detail: code });
  await setState(maxUserId, {
    step: "awaiting_contact",
    staffId: member.id,
    inviteId: invite.id,
    dataJson: chatId ? JSON.stringify({ chatId }) : null,
  });
  await reply(maxUserId, member.id, contactRequestMessage(member.fullName));
}

/* ─────────────── подтверждение телефона ─────────────── */

async function handleContact(update: MaxUpdate, maxUserId: string) {
  const attachment = update.message?.body?.attachments?.find((a) => a.type === "contact");
  const state = await getState(maxUserId);
  if (!state || state.step !== "awaiting_contact" || !state.staffId) {
    await reply(maxUserId, null, noAccessMessage);
    return;
  }
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, state.staffId));
  if (!member) return;

  const phone = phoneFromVcf(attachment?.payload?.vcf_info as string | undefined);
  if (!phone) {
    await reply(maxUserId, member.id, {
      text: "Не удалось прочитать номер из контакта. Нажмите кнопку «Поделиться контактом» ещё раз.",
      format: "markdown",
    });
    return;
  }

  if (phone !== member.phone) {
    await logAccess({
      kind: "phone_mismatch",
      staffId: member.id,
      phone,
      maxUserId,
      detail: `Ожидался +${member.phone}, получен +${phone}`,
    });
    await notifyDispatchers({
      text:
        `🔐 *Подозрительная попытка активации*\n` +
        `Инвайт выдан на ${member.fullName} (+${member.phone}), ` +
        `а контакт подтверждён с номера +${phone}. Доступ отклонён.`,
      format: "markdown",
    }, { event: "security" });
    await clearStep(maxUserId);
    await reply(maxUserId, member.id, {
      text: "Номер не совпадает с карточкой сотрудника. Доступ отклонён, диспетчер уведомлён.",
      format: "markdown",
    });
    return;
  }

  const chatId = update.message?.recipient?.chat_id ? String(update.message.recipient.chat_id) : null;
  await db
    .update(schema.staff)
    .set({
      maxUserId,
      maxChatId: chatId ?? member.maxChatId,
      maxUsername: update.message?.sender?.username ?? member.maxUsername,
      updatedAt: new Date(),
    })
    .where(eq(schema.staff.id, member.id));
  await setState(maxUserId, { step: "awaiting_name_confirm", staffId: member.id });
  await reply(maxUserId, member.id, nameConfirmMessage(member.fullName));
}

async function handleNameConfirm(maxUserId: string, confirmed: boolean) {
  const state = await getState(maxUserId);
  // Повторное нажатие на старой кнопке не должно второй раз запускать активацию.
  if (!state?.staffId || state.step !== "awaiting_name_confirm") return;
  const [member] = await db.select().from(schema.staff).where(eq(schema.staff.id, state.staffId));
  if (!member) return;

  if (!confirmed) {
    await logAccess({ kind: "name_rejected", staffId: member.id, maxUserId });
    await notifyDispatchers({
      text:
        `⚠️ *Регистрация приостановлена*\n` +
        `${member.fullName} (+${member.phone}) не подтвердил ФИО при активации. Требуется ручная проверка.`,
      format: "markdown",
    }, { event: "security" });
    await clearStep(maxUserId);
    await reply(maxUserId, member.id, {
      text: "Регистрация приостановлена. С вами свяжется диспетчер.",
      format: "markdown",
    });
    return;
  }

  if (state.inviteId) {
    await db
      .update(schema.invites)
      .set({ usedAt: new Date() })
      .where(eq(schema.invites.id, state.inviteId));
  }
  await clearStep(maxUserId);
  const [fresh] = await db.select().from(schema.staff).where(eq(schema.staff.id, member.id));
  await completeActivation(fresh ?? member, "инвайт-ссылка, контакт и ФИО");
}

/* ─────────────── callback-кнопки ─────────────── */

type RequestRow = typeof schema.requests.$inferSelect;

interface StepPhotoData {
  target: string;
  fromStatus: string;
  count: number;
}

function parseData<T>(raw: string | null | undefined): Partial<T> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    return {};
  }
}

const plain = (text: string): MaxNewMessageBody => ({ text, format: "markdown", attachments: [] });

/** Можно ли водителю сейчас работать с заявкой (своя и открытая). */
function ownOpen(request: RequestRow | null, member: StaffRow): request is RequestRow {
  return !!request && request.driverId === member.id && !isClosedStatus(request.status);
}

/**
 * Кнопка нажата на устаревшем сообщении (действие на этом шаге недоступно).
 * Если это актуальная карточка — перерисовываем её под текущий шаг, иначе
 * снимаем кнопки со старого сообщения, чтобы в чате оставалась одна клавиатура.
 */
async function answerStale(
  callbackId: string,
  request: RequestRow,
  pressedMid: string | undefined,
  process: ProcessDef,
  note = "Эта кнопка уже неактуальна",
) {
  const isCurrentCard = !!pressedMid && pressedMid === request.driverMessageId;
  if (isCurrentCard || !request.driverMessageId) {
    await answerCallback(callbackId, {
      message: driverCardMessage(request, undefined, process),
      notification: note,
    });
    if (pressedMid && !request.driverMessageId) await rememberDriverCard(request.id, pressedMid);
    return;
  }
  await answerCallback(callbackId, {
    message: plain(`Заявка ${request.number}: кнопки устарели. Актуальная карточка — ниже.`),
    notification: note,
  });
  await reissueDriverCard(request);
}

async function handleCallback(update: MaxUpdate) {
  const callback = update.callback;
  if (!callback) return;
  const maxUserId = String(callback.user.user_id);
  const pressedMid = update.message?.body?.mid;
  const { kind, a, b } = parseCallback(callback.payload);

  if (kind === "nm") {
    await answerCallback(callback.callback_id);
    await handleNameConfirm(maxUserId, a === "1");
    return;
  }

  const member = await findStaffByMaxUserId(maxUserId);
  if (member?.status === "awaiting_approval") {
    await answerCallback(callback.callback_id, { notification: "Ожидайте допуска администратора" });
    return;
  }
  if (!member || member.status !== "active") {
    await logAccess({ kind: member ? "blocked_attempt" : "stranger", staffId: member?.id, maxUserId });
    await answerCallback(callback.callback_id, { message: { ...noAccessMessage, attachments: [] } });
    return;
  }
  await touchActivity(member.id);

  if (kind === "so") {
    await signOutEverywhere(member, "Кнопка «Это не я» в MAX");
    await answerCallback(callback.callback_id, {
      message: plain("🚫 Все сеансы панели завершены. Чтобы войти снова, запросите новый код на странице входа."),
    });
    return;
  }
  if (kind === "ap" || kind === "rj") {
    if (member.role !== "admin") {
      await answerCallback(callback.callback_id, { notification: "Доступно только администратору" });
      return;
    }
    const staffId = Number.parseInt(a, 10);
    const result = kind === "ap" ? await approveStaff(staffId, member) : await rejectStaff(staffId, member);
    const who = result.ok ? `${result.member.fullName} (+${result.member.phone})` : "";
    await answerCallback(callback.callback_id, {
      message: plain(
        result.ok
          ? kind === "ap"
            ? `✅ Допущен: ${who}. Решение: ${member.fullName}.`
            : `⛔ Отклонён: ${who}. Привязка MAX снята. Решение: ${member.fullName}.`
          : `ℹ️ ${result.reason}`,
      ),
    });
    return;
  }

  if (kind === "esc") {
    await clearStep(maxUserId);
    await answerCallback(callback.callback_id, { message: plain("Отменено.") });
    return;
  }
  if (kind === "ok") {
    await clearStep(maxUserId);
    await answerCallback(callback.callback_id, { message: plain("Готово ✅ Файлы переданы в заявку.") });
    return;
  }

  const requestId = Number.parseInt(a, 10);
  const request = Number.isFinite(requestId) ? await getRequest(requestId) : null;
  if (!request) {
    await answerCallback(callback.callback_id, { message: plain("Заявка не найдена.") });
    return;
  }
  if (request.driverId !== member.id) {
    await logAccess({
      kind: "blocked_attempt",
      staffId: member.id,
      maxUserId,
      detail: `Попытка действия по чужой заявке ${request.number}`,
    });
    await answerCallback(callback.callback_id, { message: plain("Заявка больше не назначена на вас.") });
    return;
  }

  const process = await getProcess();
  const actions = availableActions(process, request.status);

  switch (kind) {
    case "cd": {
      // «Открыть заявку» из напоминания: свежая карточка внизу чата.
      await answerCallback(callback.callback_id);
      await reissueDriverCard(request);
      return;
    }

    case "st": {
      const next = nextStep(process, request.status);
      if (!next || next.key !== b) {
        await answerStale(callback.callback_id, request, pressedMid, process);
        return;
      }
      if (next.photoRequired) {
        await setState(maxUserId, {
          step: "awaiting_step_photo",
          staffId: member.id,
          requestId: request.id,
          dataJson: JSON.stringify({ target: next.key, fromStatus: request.status, count: 0 } satisfies StepPhotoData),
        });
        await answerCallback(callback.callback_id);
        await reply(maxUserId, member.id, stepPhotoPrompt(request, next, 0));
        return;
      }
      if (process.confirmTransitions) {
        await setState(maxUserId, {
          step: "awaiting_confirm",
          staffId: member.id,
          requestId: request.id,
          dataJson: JSON.stringify({ target: next.key, fromStatus: request.status }),
        });
        await answerCallback(callback.callback_id);
        await reply(maxUserId, member.id, stepConfirmPrompt(request, next));
        return;
      }

      const result = await applyDriverStatus({ request, driver: member, status: next.key, process });
      if (!result.ok) {
        const fresh = (await getRequest(request.id)) ?? request;
        await answerStale(callback.callback_id, fresh, pressedMid, process, result.error);
        return;
      }
      const isCurrentCard = !pressedMid || !request.driverMessageId || pressedMid === request.driverMessageId;
      if (isCurrentCard) {
        // Перерисовываем ту же карточку: новый статус и кнопки следующего шага.
        await answerCallback(callback.callback_id, {
          message: driverCardMessage(result.request, undefined, process),
          notification: `Отмечено: ${next.label}`,
        });
        if (pressedMid && pressedMid !== request.driverMessageId) await rememberDriverCard(request.id, pressedMid);
      } else {
        await answerCallback(callback.callback_id, { message: plain(`✅ Отмечено: ${next.label}`) });
        await reissueDriverCard(result.request);
      }
      return;
    }

    case "sc": {
      const state = await getState(maxUserId);
      const next = nextStep(process, request.status);
      if (!next || next.key !== b || state?.step !== "awaiting_confirm" || state.requestId !== request.id) {
        await answerCallback(callback.callback_id, { message: plain("Подтверждение устарело.") });
        return;
      }
      const result = await applyDriverStatus({ request, driver: member, status: next.key, process });
      await clearStep(maxUserId);
      if (!result.ok) {
        await answerCallback(callback.callback_id, { message: plain(`Не удалось: ${result.error}`) });
        return;
      }
      await answerCallback(callback.callback_id, { message: plain(`✅ Отмечено: ${next.label}`) });
      // Карточка стоит прямо над подтверждением — обновляем её на месте.
      if (result.request.driverMessageId) await refreshDriverCard(result.request);
      else await sendDriverCard(result.request);
      return;
    }

    case "sd": {
      const state = await getState(maxUserId);
      const data = parseData<StepPhotoData>(state?.dataJson);
      const next = nextStep(process, request.status);
      const step = process.steps.find((s) => s.key === b);
      if (
        !step ||
        !next ||
        next.key !== b ||
        state?.step !== "awaiting_step_photo" ||
        state.requestId !== request.id ||
        data.target !== b
      ) {
        await answerCallback(callback.callback_id, { message: plain("Этот запрос фото устарел.") });
        return;
      }
      const count = data.count ?? 0;
      if (count < 1) {
        const prompt = stepPhotoPrompt(request, step, 0);
        await answerCallback(callback.callback_id, {
          message: { ...prompt, text: `⚠️ Сначала пришлите хотя бы одно фото или скан.\n\n${prompt.text}` },
        });
        return;
      }
      const result = await applyDriverStatus({ request, driver: member, status: step.key, photos: count, process });
      await clearStep(maxUserId);
      if (!result.ok) {
        await answerCallback(callback.callback_id, { message: plain(`Не удалось: ${result.error}`) });
        return;
      }
      await answerCallback(callback.callback_id, { message: plain(`✅ Отмечено: ${step.label} · файлов: ${count}`) });
      await reissueDriverCard(result.request);
      return;
    }

    case "cm": {
      if (!actions.includes("comment")) {
        await answerStale(callback.callback_id, request, pressedMid, process);
        return;
      }
      await setState(maxUserId, { step: "awaiting_comment", staffId: member.id, requestId: request.id, dataJson: null });
      await answerCallback(callback.callback_id);
      await reply(maxUserId, member.id, {
        text: `💬 Напишите комментарий по заявке ${request.number} одним сообщением.`,
        format: "markdown",
        attachments: keyboard([[{ type: "callback", text: "✖ Отмена", payload: CB.cancelInput() }]]),
      });
      return;
    }

    case "ph": {
      if (!actions.includes("photo")) {
        await answerStale(callback.callback_id, request, pressedMid, process);
        return;
      }
      await setState(maxUserId, { step: "awaiting_photo", staffId: member.id, requestId: request.id, dataJson: null });
      await answerCallback(callback.callback_id);
      await reply(maxUserId, member.id, {
        text: `📷 Пришлите фото или сканы по заявке ${request.number}. Можно несколькими сообщениями.`,
        format: "markdown",
        attachments: keyboard([[{ type: "callback", text: "✖ Отмена", payload: CB.cancelInput() }]]),
      });
      return;
    }

    case "al": {
      const type = b === "failure" ? "failure" : "late";
      if (!actions.includes(type)) {
        await answerStale(callback.callback_id, request, pressedMid, process);
        return;
      }
      const { duplicate } = await raiseAlert({ request, type, raisedBy: member });
      await answerCallback(callback.callback_id, {
        notification: duplicate ? "Сигнал уже передан" : "Сигнал отправлен диспетчеру",
      });
      await reply(maxUserId, member.id, {
        text: duplicate
          ? "Этот сигнал уже передан диспетчеру и ещё не обработан. Ожидайте звонка."
          : type === "failure"
            ? "🚨 Сигнал «Срыв заявки» отправлен диспетчеру. Ожидайте звонка."
            : "⏳ Сигнал «Возможно опоздание» отправлен диспетчеру.",
        format: "markdown",
      });
      return;
    }

    default:
      await answerCallback(callback.callback_id, { notification: "Команда не распознана" });
  }
}

/* ─────────────── входящие сообщения ─────────────── */

const DOC_TYPES = ["image", "photo", "file"];
const MEDIA_TYPES = ["image", "photo", "video", "file", "audio"];

async function saveMedia(
  update: MaxUpdate,
  member: StaffRow,
  requestId: number,
  types: string[],
  note?: string,
) {
  const media = (update.message?.body?.attachments ?? []).filter((a) => types.includes(a.type));
  if (!media.length) return 0;
  const caption = update.message?.body?.text?.trim() || null;
  const history = await addHistory({
    requestId,
    status: "attachment",
    actorKind: "driver",
    actorId: member.id,
    actorName: member.fullName,
    comment: [note, caption].filter(Boolean).join(" · ") || null,
  });
  for (const item of media) {
    await addAttachment({
      requestId,
      historyId: history?.id ?? null,
      uploadedById: member.id,
      kind: item.type === "photo" ? "image" : item.type,
      fileName: item.filename ?? null,
      maxToken: (item.payload?.token as string | undefined) ?? null,
      maxUrl: (item.payload?.url as string | undefined) ?? null,
      sizeBytes: item.size ?? null,
    });
  }
  return media.length;
}

async function notifyAttachment(request: RequestRow, member: StaffRow, count: number) {
  await notifyDispatchers(
    {
      text: `📎 *Вложения по заявке ${request.number}*\nВодитель: ${member.fullName}\nФайлов: ${count}`,
      format: "markdown",
    },
    { event: "attachment", request, excludeStaffId: member.id },
  );
}

async function handleMessage(update: MaxUpdate) {
  const maxUserId = String(update.message?.sender?.user_id ?? "");
  if (!maxUserId) return;

  const hasContact = update.message?.body?.attachments?.some((a) => a.type === "contact");
  if (hasContact) {
    await handleContact(update, maxUserId);
    return;
  }

  const member = await findStaffByMaxUserId(maxUserId);
  if (member?.status === "awaiting_approval") {
    await reply(maxUserId, member.id, awaitingApprovalMessage);
    return;
  }
  if (!member || member.status !== "active") {
    const state = await getState(maxUserId);
    if (state?.step === "awaiting_contact") {
      const [pending] = state.staffId
        ? await db.select().from(schema.staff).where(eq(schema.staff.id, state.staffId))
        : [];
      if (pending) {
        await reply(maxUserId, pending.id, contactRequestMessage(pending.fullName));
        return;
      }
    }
    await logAccess({ kind: member ? "blocked_attempt" : "stranger", staffId: member?.id, maxUserId });
    await reply(maxUserId, member?.id ?? null, noAccessMessage);
    return;
  }

  await touchActivity(member.id);
  const process = await getProcess();
  const state = await getState(maxUserId);
  const text = (update.message?.body?.text ?? "").trim();
  const attachments = update.message?.body?.attachments ?? [];
  const stateRequest = state?.requestId ? await getRequest(state.requestId) : null;
  const stateValid = ownOpen(stateRequest, member);
  if (state && state.step !== "idle" && state.requestId && !stateValid) {
    // Заявку закрыли/переназначили, пока водитель отвечал.
    await clearStep(maxUserId);
  }

  /* — фото к шагу, без которого переход не засчитывается — */
  if (state?.step === "awaiting_step_photo" && stateValid) {
    const data = parseData<StepPhotoData>(state.dataJson);
    const step = process.steps.find((s) => s.key === data.target);
    const stillNext = step && nextStep(process, stateRequest.status)?.key === step.key;
    if (!step || !stillNext || data.fromStatus !== stateRequest.status) {
      await clearStep(maxUserId);
    } else {
      const saved = await saveMedia(update, member, stateRequest.id, DOC_TYPES, `К шагу «${step.label}»`);
      if (saved) {
        const count = (data.count ?? 0) + saved;
        await setState(maxUserId, { dataJson: JSON.stringify({ ...data, count } satisfies Partial<StepPhotoData>) });
        await reply(maxUserId, member.id, stepPhotoPrompt(stateRequest, step, count));
        return;
      }
      const prompt = stepPhotoPrompt(stateRequest, step, data.count ?? 0);
      await reply(maxUserId, member.id, {
        ...prompt,
        text: `Нужно фото или скан документа (картинка или файл).\n\n${prompt.text}`,
      });
      return;
    }
  }

  /* — геолокация — */
  const geo = attachments.find((a) => a.type === "location");
  if (geo) {
    const target = stateValid ? stateRequest : await activeRequestForDriver(member.id);
    if (target) {
      await addHistory({
        requestId: target.id,
        status: "comment",
        actorKind: "driver",
        actorId: member.id,
        actorName: member.fullName,
        comment: "Геолокация водителя",
        latitude: String(geo.payload?.latitude ?? ""),
        longitude: String(geo.payload?.longitude ?? ""),
      });
      await notifyDispatchers(
        {
          text:
            `📍 *Геолокация по заявке ${target.number}*\n` +
            `${member.fullName}: ${geo.payload?.latitude}, ${geo.payload?.longitude}`,
          format: "markdown",
        },
        { event: "geo", request: target, excludeStaffId: member.id },
      );
      await reply(maxUserId, member.id, { text: "Геолокация сохранена в заявке.", format: "markdown" });
      return;
    }
  }

  /* — произвольные вложения: по запросу «Фото/скан» или без запроса к активной заявке — */
  const hasMedia = attachments.some((a) => MEDIA_TYPES.includes(a.type));
  if (hasMedia && canExecute(member.role)) {
    const target =
      state?.step === "awaiting_photo" && stateValid ? stateRequest : await activeRequestForDriver(member.id);
    if (target) {
      const saved = await saveMedia(update, member, target.id, MEDIA_TYPES);
      if (saved) {
        await notifyAttachment(target, member, saved);
        await reply(maxUserId, member.id, {
          text: `Принято файлов: ${saved} · заявка ${target.number}.`,
          format: "markdown",
          ...(state?.step === "awaiting_photo"
            ? { attachments: keyboard([[{ type: "callback", text: "✅ Готово", payload: "ok", intent: "positive" }]]) }
            : {}),
        });
        return;
      }
    }
  }

  /* — комментарий — */
  if (state?.step === "awaiting_comment" && stateValid && text) {
    await addHistory({
      requestId: stateRequest.id,
      status: "comment",
      actorKind: "driver",
      actorId: member.id,
      actorName: member.fullName,
      comment: text,
    });
    await notifyDispatchers(
      {
        text: `💬 *Комментарий по заявке ${stateRequest.number}*\n${member.fullName}: ${text}`,
        format: "markdown",
      },
      { event: "comment", request: stateRequest, excludeStaffId: member.id },
    );
    await clearStep(maxUserId);
    await reply(maxUserId, member.id, { text: "Комментарий передан диспетчеру.", format: "markdown" });
    return;
  }

  // Свободный текст без контекста: одна актуальная карточка внизу чата или подсказка.
  const active = canExecute(member.role) ? await activeRequestForDriver(member.id) : null;
  if (active) {
    await reissueDriverCard(active, `Ваша активная заявка ${active.number}`);
    return;
  }
  await reply(maxUserId, member.id, {
    text:
      member.role === "driver"
        ? "Активных заявок нет. Новая заявка придёт в этот чат."
        : "Управление заявками — в панели диспетчеризации. Вход по номеру телефона и коду из этого чата.",
    format: "markdown",
  });
}

/* ─────────────── точка входа вебхука ─────────────── */

export async function handleUpdate(update: MaxUpdate) {
  switch (update.update_type) {
    case "bot_started":
      return handleBotStarted(update);
    case "message_created":
      return handleMessage(update);
    case "message_callback":
      return handleCallback(update);
    case "bot_stopped":
    case "bot_removed": {
      const maxUserId = String(update.user?.user_id ?? update.user_id ?? "");
      if (maxUserId) {
        await logAccess({ kind: "revoked", maxUserId, detail: update.update_type });
      }
      return;
    }
    default:
      return;
  }
}

import { db } from "../database";
import * as schema from "../database/schema";
import type { MaxNewMessageBody, MaxSendResult, MaxUser } from "./types";

/**
 * Тонкий клиент MAX Bot API — единственное место, где живут HTTP-вызовы к MAX.
 * Домен и методы API меняются часто, поэтому вся остальная система работает
 * только через этот адаптер.
 *
 * Проверено вживую: база — https://botapi.max.ru, авторизация — заголовок
 * `Authorization: <token>` без префикса Bearer (query-параметр access_token
 * помечен в API как deprecated).
 */

const BASE_URL = process.env.MAX_API_BASE_URL ?? "https://botapi.max.ru";
const TOKEN = process.env.MAX_BOT_TOKEN ?? "";

/** Режим заглушки: без токена (или при MAX_STUB=1) исходящие пишутся в bot_outbox. */
export const isStubMode = () => !TOKEN || process.env.MAX_STUB === "1";

export const maxConfig = {
  get baseUrl() {
    return BASE_URL;
  },
  get hasToken() {
    return Boolean(TOKEN);
  },
  get webhookSecret() {
    return process.env.MAX_WEBHOOK_SECRET ?? "";
  },
  get botUsername() {
    return process.env.MAX_BOT_USERNAME ?? "";
  },
  /** Публичный HTTPS-адрес панели — он же адрес мини-приложения MAX. */
  get miniAppUrl() {
    return process.env.MAX_MINIAPP_URL ?? "";
  },
};

/** MAX разрешает не более 2 сообщений в секунду на один диалог — троттлим по чату. */
const lastSentAt = new Map<string, number>();
const MIN_GAP_MS = 550;

async function throttle(key: string) {
  const prev = lastSentAt.get(key) ?? 0;
  const wait = prev + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSentAt.set(key, Date.now());
}

async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: TOKEN,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MAX API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** GET /me — проверка токена и получение профиля бота. */
export async function getBotInfo(): Promise<MaxUser | null> {
  if (isStubMode()) return null;
  return call<MaxUser>("GET", "/me");
}

/** POST /subscriptions — регистрация вебхука. */
export async function subscribeWebhook(url: string, secret: string) {
  return call<{ success: boolean; message?: string }>("POST", "/subscriptions", {
    body: {
      url,
      secret,
      update_types: [
        "message_created",
        "message_callback",
        "bot_started",
        "bot_stopped",
        "bot_added",
        "bot_removed",
      ],
    },
  });
}

/**
 * DELETE /subscriptions?url=... — снятие подписки.
 * Важно: пока активна хотя бы одна подписка, MAX не отдаёт события через
 * Long Polling. Поэтому для локальной разработки лишние подписки нужно снимать.
 */
export async function unsubscribeWebhook(url: string) {
  return call<{ success: boolean; message?: string }>("DELETE", "/subscriptions", {
    query: { url },
  });
}

/** GET /subscriptions — текущие подписки бота. */
export async function listSubscriptions() {
  if (isStubMode()) return { subscriptions: [] };
  return call<{ subscriptions: { url: string; time?: number; update_types?: string[] }[] }>(
    "GET",
    "/subscriptions",
  );
}

interface SendOptions {
  /** Кому: max_user_id сотрудника */
  maxUserId?: string | null;
  staffId?: number | null;
  body: MaxNewMessageBody;
}

/** POST /messages — отправка сообщения в личный диалог. */
export async function sendMessage({ maxUserId, staffId, body }: SendOptions): Promise<MaxSendResult> {
  const logRow = {
    staffId: staffId ?? null,
    maxUserId: maxUserId ?? null,
    text: body.text ?? "",
    payloadJson: JSON.stringify(body.attachments ?? []),
  };

  if (isStubMode() || !maxUserId) {
    await db.insert(schema.botOutbox).values({ ...logRow, state: "stub" });
    return { ok: true, stub: true };
  }

  try {
    await throttle(maxUserId);
    const res = await call<{ message?: { body?: { mid?: string } } }>("POST", "/messages", {
      query: { user_id: Number(maxUserId) },
      body: { notify: true, format: "markdown", ...body },
    });
    const mid = res.message?.body?.mid;
    await db.insert(schema.botOutbox).values({ ...logRow, state: "sent", maxMessageId: mid ?? null });
    return { ok: true, messageId: mid };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.insert(schema.botOutbox).values({ ...logRow, state: "failed", error });
    console.error("[max] sendMessage failed:", error);
    return { ok: false, error };
  }
}

/** PUT /messages — перезапись сообщения (например, снятие кнопок с отменённой заявки). */
export async function editMessage(messageId: string, body: MaxNewMessageBody): Promise<MaxSendResult> {
  if (isStubMode()) {
    await db.insert(schema.botOutbox).values({
      text: `[edit ${messageId}] ${body.text ?? ""}`,
      payloadJson: JSON.stringify(body.attachments ?? []),
      state: "stub",
    });
    return { ok: true, stub: true };
  }
  try {
    await throttle(`edit:${messageId}`);
    await call("PUT", "/messages", {
      query: { message_id: messageId },
      body: { format: "markdown", ...body },
    });
    return { ok: true, messageId };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[max] editMessage failed:", error);
    return { ok: false, error };
  }
}

/**
 * POST /answers — ответ на нажатие inline-кнопки.
 * `message` ЗАМЕНЯЕТ сообщение, на котором нажали кнопку (это не всплывашка!),
 * `notification` — одноразовое уведомление пользователю. Без параметров — просто
 * подтверждаем нажатие, сообщение остаётся как было.
 */
export async function answerCallback(
  callbackId: string,
  opts: { message?: MaxNewMessageBody; notification?: string } = {},
) {
  // MAX отклоняет пустой ответ (400 proto.payload) — без подтверждения кнопка «висит».
  const notification = opts.notification ?? (opts.message ? undefined : "Принято");
  if (isStubMode()) {
    await db.insert(schema.botOutbox).values({
      text: `[answer ${callbackId}] ${notification ?? ""}${opts.message?.text ? ` | ${opts.message.text}` : ""}`,
      payloadJson: JSON.stringify(opts.message?.attachments ?? []),
      state: "stub",
    });
    return { ok: true, stub: true };
  }
  const body: Record<string, unknown> = {};
  if (opts.message) body.message = { format: "markdown", ...opts.message };
  if (notification) body.notification = notification;
  try {
    await call("POST", "/answers", { query: { callback_id: callbackId }, body });
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[max] answerCallback failed:", error);
    // Повтор: только короткое уведомление (без правки сообщения), чтобы снять «зависание» кнопки.
    try {
      await call("POST", "/answers", {
        query: { callback_id: callbackId },
        body: { notification: notification ?? "Принято" },
      });
      return { ok: true, retried: true };
    } catch {
      return { ok: false, error };
    }
  }
}

/** Скачивание вложения по временной ссылке MAX (для переноса в постоянное хранилище). */
export async function downloadAttachment(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

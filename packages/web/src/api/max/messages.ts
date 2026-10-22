import { formatPhone } from "../lib/domain";
import { cachedProcess } from "../lib/process";
import {
  availableActions,
  nextStep,
  statusLabel,
  type ProcessDef,
  type ProcessStep,
} from "../lib/process-def";
import { maxConfig } from "./client";
import type * as schema from "../database/schema";
import type { MaxButton, MaxNewMessageBody } from "./types";

type RequestRow = typeof schema.requests.$inferSelect;

/** Формат payload кнопок: короткий, лимит MAX — 1024 символа. */
export const CB = {
  status: (requestId: number, status: string) => `st:${requestId}:${status}`,
  comment: (requestId: number) => `cm:${requestId}`,
  photo: (requestId: number) => `ph:${requestId}`,
  alert: (requestId: number, type: string) => `al:${requestId}:${type}`,
  card: (requestId: number) => `cd:${requestId}`,
  /** Фото к шагу приложены — выполнить переход */
  stepDone: (requestId: number, status: string) => `sd:${requestId}:${status}`,
  /** Подтверждение перехода «Да» */
  stepConfirm: (requestId: number, status: string) => `sc:${requestId}:${status}`,
  nameConfirm: (yes: boolean) => `nm:${yes ? "1" : "0"}`,
  cancelInput: () => "esc",
  /** Админ: допустить / отклонить нового сотрудника */
  approve: (staffId: number) => `ap:${staffId}`,
  reject: (staffId: number) => `rj:${staffId}`,
  /** Сотрудник: «Это не я» — завершить все сеансы панели */
  signOutAll: () => "so",
};

export function parseCallback(payload: string | undefined) {
  const parts = (payload ?? "").split(":");
  return { kind: parts[0] ?? "", a: parts[1] ?? "", b: parts[2] ?? "" };
}

const tz = "Europe/Moscow";

export function formatDateTime(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(value);
}

export function formatTime(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(value);
}

function line(label: string, value: string | null | undefined) {
  return value ? `*${label}:* ${value}\n` : "";
}

/** Текст карточки заявки для водителя — состав полей из «Договор-заявки». */
export function requestCardText(
  request: RequestRow,
  opts: { header?: string; process?: ProcessDef } = {},
): string {
  const process = opts.process ?? cachedProcess();
  const header = opts.header ?? `Заявка ${request.number}`;
  let text = `${header}\n\n`;
  text += line("№ контейнера", request.containerNo);
  text += line("Футовость", request.containerType);
  text += line("Вес груза", request.cargoWeight);
  text += line("Постановка груженого", request.loadingPoint);
  text += line("Дата", request.tripDate);
  text += line("Время выгрузки", request.unloadAt ? formatDateTime(request.unloadAt) : null);
  text += line("Адрес выгрузки", request.unloadAddress);
  text += line(
    "Контакт",
    request.contactName || request.contactPhone
      ? `${request.contactName ?? ""}${request.contactPhone ? `, ${formatPhone(request.contactPhone)}` : ""}`
      : null,
  );
  text += line("Грузополучатель", request.consignee);
  text += line("Возврат порожнего", request.returnPoint);
  text += line("Адрес возврата", request.returnAddress);
  text += line("Координаты", request.coordinates);
  text += line("Телефон терминала", formatPhone(request.terminalPhone) === "—" ? null : formatPhone(request.terminalPhone));
  text += line("Режим работы", request.schedule);
  text += line("Комментарий диспетчера", request.comment);
  text += `\n*Текущий статус:* ${statusLabel(process, request.status)}`;

  const next = nextStep(process, request.status);
  if (next?.photoRequired) {
    text += `\n\n📷 Для шага «${next.label}» понадобится фото: ${next.photoHint}`;
  }
  return text;
}

/** Клавиатура водителя: кнопка следующего шага + кнопки, разрешённые на текущем шаге. */
export function driverKeyboard(request: RequestRow, process: ProcessDef = cachedProcess()): MaxButton[][] {
  const actions = availableActions(process, request.status);
  const next = nextStep(process, request.status);
  const rows: MaxButton[][] = [];
  if (next) {
    rows.push([
      {
        type: "callback",
        text: next.buttonText,
        payload: CB.status(request.id, next.key),
        intent: "positive",
      },
    ]);
  }
  const extra: MaxButton[] = [];
  if (actions.includes("photo")) extra.push({ type: "callback", text: "📷 Фото/скан", payload: CB.photo(request.id) });
  if (actions.includes("comment")) {
    extra.push({ type: "callback", text: "💬 Комментарий", payload: CB.comment(request.id) });
  }
  if (extra.length) rows.push(extra);
  if (actions.includes("geo")) {
    rows.push([{ type: "request_geo_location", text: "📍 Отправить геолокацию", quick: true }]);
  }
  if (actions.includes("late")) {
    rows.push([
      { type: "callback", text: "⏳ Возможно опоздание", payload: CB.alert(request.id, "late"), intent: "negative" },
    ]);
  }
  if (actions.includes("failure")) {
    rows.push([
      { type: "callback", text: "🚨 Срыв заявки", payload: CB.alert(request.id, "failure"), intent: "negative" },
    ]);
  }
  return rows;
}

/** Запрос фото, без которого шаг не засчитывается. */
export function stepPhotoPrompt(request: RequestRow, step: ProcessStep, received: number): MaxNewMessageBody {
  const text =
    received === 0
      ? `📷 *${step.label}* · заявка ${request.number}\n` +
        `Пришлите: ${step.photoHint}.\nМожно несколькими сообщениями. Когда всё отправите — нажмите «Готово».`
      : `Принято файлов: ${received}. Пришлите ещё или нажмите «Готово», чтобы отметить «${step.label}».`;
  return {
    text,
    format: "markdown",
    attachments: keyboard([
      [
        { type: "callback", text: "✅ Готово", payload: CB.stepDone(request.id, step.key), intent: "positive" },
        { type: "callback", text: "✖ Отмена", payload: CB.cancelInput() },
      ],
    ]),
  };
}

/** Подтверждение перехода (если включено в процессе). */
export function stepConfirmPrompt(request: RequestRow, step: ProcessStep): MaxNewMessageBody {
  return {
    text: `Отметить «${step.label}» по заявке ${request.number}?`,
    format: "markdown",
    attachments: keyboard([
      [
        { type: "callback", text: "Да", payload: CB.stepConfirm(request.id, step.key), intent: "positive" },
        { type: "callback", text: "Нет", payload: CB.cancelInput() },
      ],
    ]),
  };
}

/**
 * Кнопка запуска панели как мини-приложения MAX.
 * Работает только после подключения мини-приложения в кабинете организации
 * (нужен HTTPS-адрес в MAX_MINIAPP_URL и username бота); пока адреса нет —
 * возвращаем null, и сообщение уходит без кнопки.
 */
export function openPanelButton(startParam?: string): MaxButton | null {
  if (!maxConfig.miniAppUrl || !maxConfig.botUsername) return null;
  return {
    type: "open_app",
    text: "🖥 Открыть панель",
    web_app: maxConfig.botUsername,
    ...(startParam ? { payload: startParam } : {}),
  };
}

/** Тот же переход ссылкой — для случаев, когда мини-приложение ещё не подключено. */
export function panelLinkButton(path = ""): MaxButton | null {
  if (!maxConfig.miniAppUrl) return null;
  return { type: "link", text: "🖥 Открыть панель", url: `${maxConfig.miniAppUrl}${path}` };
}

/** Кнопка панели: внутри MAX — мини-приложение, иначе обычная ссылка. */
export function panelButton(startParam?: string, path = ""): MaxButton | null {
  return openPanelButton(startParam) ?? panelLinkButton(path);
}

export function keyboard(buttons: MaxButton[][]): MaxNewMessageBody["attachments"] {
  if (!buttons.length) return undefined;
  return [{ type: "inline_keyboard", payload: { buttons } }];
}

export function driverCardMessage(
  request: RequestRow,
  header?: string,
  process: ProcessDef = cachedProcess(),
): MaxNewMessageBody {
  const buttons = driverKeyboard(request, process);
  return {
    text: requestCardText(request, { header, process }),
    // Пустой массив при правке снимает старую клавиатуру с закрытой заявки.
    attachments: buttons.length ? keyboard(buttons) : [],
    format: "markdown",
    notify: true,
  };
}

/** Сообщение-заглушка для тех, у кого нет доступа. */
export const awaitingApprovalMessage: MaxNewMessageBody = {
  text: "Данные подтверждены. Доступ откроется после подтверждения администратором — бот пришлёт сообщение.",
  format: "markdown",
};

const ROLE_NAMES: Record<string, string> = { admin: "Администратор", dispatcher: "Диспетчер", driver: "Водитель" };

export function approvalRequestMessage(
  member: { id: number; fullName: string; phone: string; role: string },
  via: string,
): MaxNewMessageBody {
  return {
    text:
      `🛂 *Запрос допуска*\n` +
      `${member.fullName} · ${ROLE_NAMES[member.role] ?? member.role}\n` +
      `Телефон +${member.phone} подтверждён в MAX (${via}).\n` +
      `Допустить к работе?`,
    format: "markdown",
    attachments: keyboard([
      [
        { type: "callback", text: "✅ Допустить", payload: CB.approve(member.id), intent: "positive" },
        { type: "callback", text: "⛔ Отклонить", payload: CB.reject(member.id), intent: "negative" },
      ],
    ]),
  };
}

export function newDeviceMessage(device: string, ip: string | null): MaxNewMessageBody {
  return {
    text:
      `🔐 *Вход в панель с нового устройства*\n` +
      `${device}${ip ? ` · IP ${ip}` : ""}\n` +
      `Если это были не вы — нажмите кнопку, все сеансы будут завершены.`,
    format: "markdown",
    attachments: keyboard([
      [{ type: "callback", text: "🚫 Это не я — завершить все сеансы", payload: CB.signOutAll(), intent: "negative" }],
    ]),
  };
}

export const noAccessMessage: MaxNewMessageBody = {
  text: "Доступ не предоставлен. Обратитесь к диспетчеру или администратору автопарка.",
  format: "markdown",
};

export function contactRequestMessage(fullName: string): MaxNewMessageBody {
  return {
    text:
      `Здравствуйте! Для подтверждения личности поделитесь контактом — ` +
      `номер должен совпадать с номером в карточке сотрудника (${fullName}).`,
    attachments: keyboard([
      [{ type: "request_contact", text: "📱 Поделиться контактом" }],
    ]),
    format: "markdown",
  };
}

export function nameConfirmMessage(fullName: string): MaxNewMessageBody {
  return {
    text: `Проверьте данные: *${fullName}*\nВсё верно?`,
    attachments: keyboard([
      [
        { type: "callback", text: "Да, это я", payload: CB.nameConfirm(true), intent: "positive" },
        { type: "callback", text: "Нет", payload: CB.nameConfirm(false), intent: "negative" },
      ],
    ]),
    format: "markdown",
  };
}

/** Уведомление диспетчеру о смене статуса. */
export function statusNotification(params: {
  request: RequestRow;
  status: string;
  driverName: string;
  comment?: string | null;
  photos?: number;
  process?: ProcessDef;
}): MaxNewMessageBody {
  const { request, status, driverName, comment, photos } = params;
  const process = params.process ?? cachedProcess();
  let text =
    `🔔 *${statusLabel(process, status)}*\n` +
    `Заявка ${request.number} · контейнер ${request.containerNo}\n` +
    `Водитель: ${driverName}\n` +
    `Выгрузка: ${formatDateTime(request.unloadAt)} — ${request.unloadAddress ?? "адрес не указан"}`;
  if (comment) text += `\nКомментарий: ${comment}`;
  if (photos) text += `\n📎 Приложено файлов: ${photos} (в карточке заявки)`;
  const open = panelButton(`request-${request.id}`, `/requests/${request.id}`);
  return {
    text,
    format: "markdown",
    notify: true,
    ...(open ? { attachments: keyboard([[open]]) } : {}),
  };
}

/** Выделенное уведомление о тревоге. */
export function alertNotification(params: {
  request: RequestRow;
  type: string;
  driverName: string;
  driverPhone?: string | null;
  message?: string | null;
}): MaxNewMessageBody {
  const { request, type, driverName, driverPhone, message } = params;
  const title = type === "failure" ? "🚨🚨 СРЫВ ЗАЯВКИ" : "⏳ ВОЗМОЖНО ОПОЗДАНИЕ";
  let text =
    `${title}\n` +
    `━━━━━━━━━━━━━━\n` +
    `*Заявка ${request.number}* · контейнер ${request.containerNo}\n` +
    `Водитель: *${driverName}*${driverPhone ? ` · ${formatPhone(driverPhone)}` : ""}\n` +
    `Статус на момент сигнала: ${statusLabel(cachedProcess(), request.status)}\n` +
    `Выгрузка: ${formatDateTime(request.unloadAt)}\n` +
    `Адрес: ${request.unloadAddress ?? "—"}`;
  if (message) text += `\nСообщение водителя: ${message}`;
  text += `\n━━━━━━━━━━━━━━\n❗ Требуется экстренная связь с водителем.`;
  const open = panelButton(`request-${request.id}`, `/requests/${request.id}`);
  return {
    text,
    format: "markdown",
    notify: true,
    ...(open ? { attachments: keyboard([[open]]) } : {}),
  };
}

export function reminderMessage(request: RequestRow, minutes: number): MaxNewMessageBody {
  return {
    text:
      `⏰ *Напоминание*\nЗаявка ${request.number} · контейнер ${request.containerNo}\n` +
      `До заявленного времени выгрузки (${formatDateTime(request.unloadAt)}) — ${minutes} мин.\n` +
      `Адрес: ${request.unloadAddress ?? "—"}\n` +
      `Текущий статус: ${statusLabel(cachedProcess(), request.status)}. Обновите статус, если он изменился.`,
    attachments: keyboard([
      [{ type: "callback", text: "🗂 Открыть заявку", payload: CB.card(request.id) }],
    ]),
    format: "markdown",
    notify: true,
  };
}

export function otpMessage(code: string): MaxNewMessageBody {
  return {
    text:
      `Код для входа в панель диспетчеризации: *${code}*\n` +
      `Код действует 5 минут. Никому его не сообщайте.`,
    format: "markdown",
    notify: true,
  };
}

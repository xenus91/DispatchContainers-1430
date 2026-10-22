/**
 * Модель процесса перевозки — общая для сервера, бота и панели (без импортов БД).
 *
 * Процесс — упорядоченный список шагов водителя. Заявка проходит:
 *   new → assigned → шаг 1 → шаг 2 → … → последний шаг (ключ всегда "delivered").
 * Для каждого шага настраивается: подпись статуса, текст кнопки, обязательное фото,
 * какие дополнительные кнопки доступны водителю на этом шаге, и уведомлять ли
 * диспетчеров по умолчанию.
 */

export type StepAction = "photo" | "comment" | "geo" | "late" | "failure";

export const STEP_ACTIONS: { key: StepAction; label: string; hint: string }[] = [
  { key: "photo", label: "Фото/скан", hint: "Водитель может приложить фото или скан" },
  { key: "comment", label: "Комментарий", hint: "Короткий текстовый комментарий" },
  { key: "geo", label: "Геолокация", hint: "Кнопка «Отправить геолокацию»" },
  { key: "late", label: "Возможно опоздание", hint: "Тревожная кнопка" },
  { key: "failure", label: "Срыв заявки", hint: "Тревожная кнопка" },
];

export interface ProcessStep {
  /** Ключ статуса в БД. Латиница/цифры/_; у последнего шага всегда "delivered". */
  key: string;
  /** Как статус называется в панели и карточке: «В пути». */
  label: string;
  /** Текст кнопки, которой водитель переходит на этот шаг: «🚚 Выехал». */
  buttonText: string;
  /** Переход на шаг только после фото/скана. */
  photoRequired: boolean;
  /** Что именно сфотографировать — показывается водителю. */
  photoHint: string;
  /** Кнопки, доступные водителю, пока заявка находится на этом шаге. */
  actions: StepAction[];
  /** Уведомлять диспетчеров о переходе на этот шаг (значение по умолчанию для каждого сотрудника). */
  notifyDefault: boolean;
}

export interface ProcessDef {
  version: number;
  /** Кнопки водителя до первого шага (заявка только назначена). */
  assignedActions: StepAction[];
  /** Просить водителя подтвердить нажатие перехода («Да / Нет») — защита от случайных нажатий. */
  confirmTransitions: boolean;
  steps: ProcessStep[];
}

export const FINAL_STEP_KEY = "delivered";
export const CLOSED_STATUSES = ["delivered", "cancelled"] as const;

export const DEFAULT_PROCESS: ProcessDef = {
  version: 1,
  assignedActions: ["comment", "failure"],
  confirmTransitions: false,
  steps: [
    {
      key: "accepted",
      label: "Принял",
      buttonText: "✅ Принял заявку",
      photoRequired: false,
      photoHint: "",
      actions: ["comment", "late", "failure"],
      notifyDefault: true,
    },
    {
      key: "en_route",
      label: "В пути",
      buttonText: "🚚 Выехал",
      photoRequired: false,
      photoHint: "",
      actions: ["comment", "geo", "late", "failure"],
      notifyDefault: false,
    },
    {
      key: "container_placed",
      label: "Поставил контейнер",
      buttonText: "📦 Поставил контейнер",
      photoRequired: true,
      photoHint: "Фото акта постановки и ТН с двух сторон",
      actions: ["photo", "comment", "geo", "late", "failure"],
      notifyDefault: true,
    },
    {
      key: "at_warehouse",
      label: "Прибыл на адрес склада",
      buttonText: "🏭 Прибыл на склад",
      photoRequired: false,
      photoHint: "",
      actions: ["photo", "comment", "geo", "late", "failure"],
      notifyDefault: false,
    },
    {
      key: FINAL_STEP_KEY,
      label: "Сдал контейнер",
      buttonText: "🏁 Сдал контейнер",
      photoRequired: true,
      photoHint: "Фото акта сдачи и ТН с печатью/подписью старшего смены",
      actions: [],
      notifyDefault: true,
    },
  ],
};

/** Подписи служебных статусов — не редактируются. */
export const SYSTEM_STATUS_LABELS: Record<string, string> = {
  new: "Новая",
  assigned: "Назначена",
  cancelled: "Отменена",
  created: "Заявка создана",
  reassigned: "Переназначена",
  updated: "Данные изменены",
  comment: "Комментарий",
  attachment: "Вложение",
  reminder: "Напоминание отправлено",
  alert_late: "Возможно опоздание",
  alert_failure: "Срыв заявки",
  name_confirmed: "Регистрация подтверждена",
};

export function statusLabel(process: ProcessDef, status: string): string {
  return process.steps.find((s) => s.key === status)?.label ?? SYSTEM_STATUS_LABELS[status] ?? status;
}

export function isClosedStatus(status: string): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(status);
}

/** Индекс шага: -1 — заявка ещё не принята (new/assigned) или статус неизвестен. */
export function stepIndex(process: ProcessDef, status: string): number {
  return process.steps.findIndex((s) => s.key === status);
}

export function currentStep(process: ProcessDef, status: string): ProcessStep | null {
  return process.steps[stepIndex(process, status)] ?? null;
}

/** Следующий шаг для водителя (или null, если заявка закрыта). */
export function nextStep(process: ProcessDef, status: string): ProcessStep | null {
  if (isClosedStatus(status)) return null;
  const idx = stepIndex(process, status);
  // Статус, которого больше нет в процессе (процесс изменили на ходу) — начинаем с первого шага.
  return process.steps[idx + 1] ?? null;
}

/** Кнопки, доступные водителю в текущем состоянии заявки. */
export function availableActions(process: ProcessDef, status: string): StepAction[] {
  if (isClosedStatus(status)) return [];
  const step = currentStep(process, status);
  return step ? step.actions : process.assignedActions;
}

/** Ключи статусов, которые считаются «в работе» (для фильтров панели). */
export function openStatusKeys(process: ProcessDef): string[] {
  return ["new", "assigned", ...process.steps.filter((s) => s.key !== FINAL_STEP_KEY).map((s) => s.key)];
}

/* ─────────────── события уведомлений ─────────────── */

export type NotifyEventGroup = "status" | "driver" | "alert" | "system";

export interface NotifyEvent {
  key: string;
  label: string;
  group: NotifyEventGroup;
  /** Включено по умолчанию для нового сотрудника. */
  defaultOn: boolean;
  /** Критичное — нельзя выключить (тревоги). */
  locked?: boolean;
}

export const NOTIFY_GROUP_LABELS: Record<NotifyEventGroup, string> = {
  status: "Смена статуса водителем",
  driver: "Действия водителя",
  alert: "Тревоги",
  system: "Доступ и система",
};

/** Все события, о которых бот может писать диспетчеру. Статусные — из текущего процесса. */
export function notifyEvents(process: ProcessDef): NotifyEvent[] {
  return [
    ...process.steps.map((s) => ({
      key: `status:${s.key}`,
      label: s.label,
      group: "status" as const,
      defaultOn: s.notifyDefault,
    })),
    { key: "attachment", label: "Водитель приложил фото/документ", group: "driver", defaultOn: false },
    { key: "comment", label: "Комментарий водителя", group: "driver", defaultOn: true },
    { key: "geo", label: "Геолокация водителя", group: "driver", defaultOn: false },
    { key: "alert_late", label: "Возможно опоздание", group: "alert", defaultOn: true, locked: true },
    { key: "alert_failure", label: "Срыв заявки", group: "alert", defaultOn: true, locked: true },
    { key: "alert_escalation", label: "Тревога не подтверждена вовремя", group: "alert", defaultOn: true },
    { key: "security", label: "Подозрительные попытки доступа", group: "system", defaultOn: true },
    { key: "staff_activated", label: "Сотрудник активирован в боте", group: "system", defaultOn: true },
  ];
}

export interface NotifyPrefs {
  /** Полностью выключить сообщения в MAX (кроме заблокированных тревог). */
  muted: boolean;
  /** all — по всем заявкам; mine — только по заявкам, которые создал этот сотрудник. */
  scope: "all" | "mine";
  /** Явные значения по событиям; отсутствующее — берётся defaultOn. */
  events: Record<string, boolean>;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { muted: false, scope: "all", events: {} };

export function isLockedEvent(process: ProcessDef, eventKey: string): boolean {
  return !!notifyEvents(process).find((e) => e.key === eventKey)?.locked;
}

export function isEventEnabled(process: ProcessDef, prefs: NotifyPrefs, eventKey: string): boolean {
  const ev = notifyEvents(process).find((e) => e.key === eventKey);
  if (ev?.locked) return true;
  if (prefs.muted) return false;
  if (eventKey in prefs.events) return !!prefs.events[eventKey];
  return ev?.defaultOn ?? true;
}

/* ─────────────── валидация ─────────────── */

const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
const RESERVED = new Set(["new", "assigned", "cancelled", ...Object.keys(SYSTEM_STATUS_LABELS)]);

export function validateProcess(p: ProcessDef): string | null {
  if (p.steps.length < 1) return "В процессе должен быть хотя бы один шаг";
  if (p.steps.length > 15) return "Не больше 15 шагов";
  const seen = new Set<string>();
  for (const [i, s] of p.steps.entries()) {
    const n = i + 1;
    if (!KEY_RE.test(s.key)) return `Шаг ${n}: ключ — латиница, цифры и «_», от 2 символов`;
    if (RESERVED.has(s.key)) return `Шаг ${n}: ключ «${s.key}» зарезервирован системой`;
    if (seen.has(s.key)) return `Шаг ${n}: ключ «${s.key}» повторяется`;
    seen.add(s.key);
    if (!s.label.trim()) return `Шаг ${n}: укажите название статуса`;
    if (!s.buttonText.trim()) return `Шаг ${n}: укажите текст кнопки`;
    if (s.buttonText.length > 64) return `Шаг ${n}: текст кнопки длиннее 64 символов`;
    if (s.photoRequired && !s.photoHint.trim()) return `Шаг ${n}: опишите, что нужно сфотографировать`;
  }
  const last = p.steps[p.steps.length - 1];
  if (last?.key !== FINAL_STEP_KEY) return `Последний шаг должен иметь ключ «${FINAL_STEP_KEY}» (закрытие заявки)`;
  if (p.steps.slice(0, -1).some((s) => s.key === FINAL_STEP_KEY)) {
    return `Ключ «${FINAL_STEP_KEY}» допустим только у последнего шага`;
  }
  return null;
}

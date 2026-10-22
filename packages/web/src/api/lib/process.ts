import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  CLOSED_STATUSES,
  DEFAULT_NOTIFY_PREFS,
  DEFAULT_PROCESS,
  type NotifyPrefs,
  type ProcessDef,
  type StepAction,
  validateProcess,
} from "./process-def";
import { getSetting, setSetting } from "./settings";

const PROCESS_KEY = "process";
const prefsKey = (staffId: number) => `notify:${staffId}`;
const VALID_ACTIONS: StepAction[] = ["photo", "comment", "geo", "late", "failure"];

/** Последний загруженный процесс — для синхронных построителей сообщений. */
let cached: ProcessDef = DEFAULT_PROCESS;

export function cachedProcess(): ProcessDef {
  return cached;
}

function sanitizeActions(raw: unknown): StepAction[] {
  if (!Array.isArray(raw)) return [];
  return VALID_ACTIONS.filter((a) => raw.includes(a));
}

/** Приводит произвольный JSON к ProcessDef (без валидации бизнес-правил). */
export function normalizeProcess(raw: unknown): ProcessDef {
  const obj = (raw ?? {}) as Partial<ProcessDef>;
  return {
    version: Number(obj.version) || 1,
    assignedActions: sanitizeActions(obj.assignedActions),
    confirmTransitions: !!obj.confirmTransitions,
    steps: (Array.isArray(obj.steps) ? obj.steps : []).map((s) => ({
      key: String(s?.key ?? "").trim(),
      label: String(s?.label ?? "").trim(),
      buttonText: String(s?.buttonText ?? "").trim(),
      photoRequired: !!s?.photoRequired,
      photoHint: String(s?.photoHint ?? "").trim(),
      actions: sanitizeActions(s?.actions),
      notifyDefault: !!s?.notifyDefault,
    })),
  };
}

/** Текущий процесс из настроек (или процесс по умолчанию). */
export async function getProcess(): Promise<ProcessDef> {
  const raw = await getSetting(PROCESS_KEY);
  if (!raw) {
    cached = DEFAULT_PROCESS;
    return cached;
  }
  try {
    const parsed = normalizeProcess(JSON.parse(raw));
    cached = validateProcess(parsed) ? DEFAULT_PROCESS : parsed;
  } catch {
    cached = DEFAULT_PROCESS;
  }
  return cached;
}

/**
 * Открытые заявки, чей текущий шаг отсутствует в новом процессе.
 * Такие изменения запрещены — иначе водитель «потеряет» свой шаг посреди рейса.
 */
export async function orphanedRequests(next: ProcessDef) {
  const keys = ["new", "assigned", ...next.steps.map((s) => s.key)];
  return db
    .select({ id: schema.requests.id, number: schema.requests.number, status: schema.requests.status })
    .from(schema.requests)
    .where(
      and(
        notInArray(schema.requests.status, [...CLOSED_STATUSES]),
        notInArray(schema.requests.status, keys),
      ),
    );
}

export async function saveProcess(input: unknown): Promise<
  { ok: true; process: ProcessDef } | { ok: false; error: string }
> {
  const current = await getProcess();
  const next = { ...normalizeProcess(input), version: current.version + 1 };
  const err = validateProcess(next);
  if (err) return { ok: false, error: err };

  const orphans = await orphanedRequests(next);
  if (orphans.length) {
    const list = orphans
      .slice(0, 5)
      .map((o) => o.number)
      .join(", ");
    return {
      ok: false,
      error:
        `Нельзя удалить или переименовать шаг, на котором сейчас находятся заявки: ${list}` +
        (orphans.length > 5 ? ` и ещё ${orphans.length - 5}` : "") +
        ". Дождитесь их закрытия или верните шаг.",
    };
  }

  await setSetting(PROCESS_KEY, JSON.stringify(next));
  cached = next;
  return { ok: true, process: next };
}

export async function resetProcess(): Promise<{ ok: true; process: ProcessDef } | { ok: false; error: string }> {
  return saveProcess(DEFAULT_PROCESS);
}

/* ─────────────── персональные настройки уведомлений ─────────────── */

export function normalizePrefs(raw: unknown): NotifyPrefs {
  const obj = (raw ?? {}) as Partial<NotifyPrefs>;
  const events: Record<string, boolean> = {};
  if (obj.events && typeof obj.events === "object") {
    for (const [k, v] of Object.entries(obj.events)) {
      if (typeof v === "boolean" && k.length <= 64) events[k] = v;
    }
  }
  return {
    muted: !!obj.muted,
    scope: obj.scope === "mine" ? "mine" : "all",
    events,
  };
}

export async function getNotifyPrefs(staffId: number): Promise<NotifyPrefs> {
  const raw = await getSetting(prefsKey(staffId));
  if (!raw) return { ...DEFAULT_NOTIFY_PREFS, events: {} };
  try {
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_NOTIFY_PREFS, events: {} };
  }
}

export async function getNotifyPrefsMap(staffIds: number[]): Promise<Map<number, NotifyPrefs>> {
  const map = new Map<number, NotifyPrefs>();
  if (!staffIds.length) return map;
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, staffIds.map(prefsKey)));
  for (const id of staffIds) {
    const row = rows.find((r) => r.key === prefsKey(id));
    let prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, events: {} };
    if (row) {
      try {
        prefs = normalizePrefs(JSON.parse(row.value));
      } catch {
        /* битая запись — значения по умолчанию */
      }
    }
    map.set(id, prefs);
  }
  return map;
}

export async function saveNotifyPrefs(staffId: number, prefs: unknown): Promise<NotifyPrefs> {
  const normalized = normalizePrefs(prefs);
  await setSetting(prefsKey(staffId), JSON.stringify(normalized));
  return normalized;
}

/** Есть ли сотрудник с таким id (для проверки в маршрутах). */
export async function staffExists(staffId: number) {
  const [row] = await db.select({ id: schema.staff.id }).from(schema.staff).where(eq(schema.staff.id, staffId));
  return !!row;
}

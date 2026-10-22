import { ORPCError } from "@orpc/server";
import { notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, authed } from "../lib/auth";
import { getProcess, resetProcess, saveProcess } from "../lib/process";
import { CLOSED_STATUSES, DEFAULT_PROCESS, STEP_ACTIONS } from "../lib/process-def";

const actionEnum = z.enum(["photo", "comment", "geo", "late", "failure"]);

const stepSchema = z.object({
  key: z.string().min(1).max(32),
  label: z.string().max(64),
  buttonText: z.string().max(64),
  photoRequired: z.boolean(),
  photoHint: z.string().max(200),
  actions: z.array(actionEnum),
  notifyDefault: z.boolean(),
});

const processSchema = z.object({
  assignedActions: z.array(actionEnum),
  confirmTransitions: z.boolean(),
  steps: z.array(stepSchema).min(1).max(15),
});

/** Сколько открытых заявок стоит на каждом статусе — чтобы конструктор не дал удалить занятый шаг. */
async function openUsage() {
  const rows = await db
    .select({ status: schema.requests.status })
    .from(schema.requests)
    .where(notInArray(schema.requests.status, [...CLOSED_STATUSES]));
  const usage: Record<string, number> = {};
  for (const r of rows) usage[r.status] = (usage[r.status] ?? 0) + 1;
  return usage;
}

export const process = {
  /** Процесс нужен всем авторизованным: подписи статусов в панели. */
  get: authed.handler(async () => {
    const proc = await getProcess();
    return {
      process: proc,
      actions: STEP_ACTIONS,
      defaults: DEFAULT_PROCESS,
      usage: await openUsage(),
    };
  }),

  save: adminOnly.input(processSchema).handler(async ({ input }) => {
    const result = await saveProcess({ version: 0, ...input });
    if (!result.ok) throw new ORPCError("BAD_REQUEST", { message: result.error });
    return result.process;
  }),

  reset: adminOnly.handler(async () => {
    const result = await resetProcess();
    if (!result.ok) throw new ORPCError("BAD_REQUEST", { message: result.error });
    return result.process;
  }),
};

import { z } from "zod";
import { dispatcherOnly } from "../lib/auth";
import { getNotifyPrefs, getProcess, saveNotifyPrefs } from "../lib/process";
import { NOTIFY_GROUP_LABELS, notifyEvents } from "../lib/process-def";

export const notifications = {
  /** Личные настройки уведомлений текущего диспетчера/админа и каталог событий. */
  get: dispatcherOnly.handler(async ({ context }) => {
    const proc = await getProcess();
    return {
      prefs: await getNotifyPrefs(context.user.id),
      events: notifyEvents(proc),
      groups: NOTIFY_GROUP_LABELS,
      inBot: context.user.status === "active" && !!context.user.maxUserId,
    };
  }),

  save: dispatcherOnly
    .input(
      z.object({
        muted: z.boolean(),
        scope: z.enum(["all", "mine"]),
        events: z.record(z.string().max(64), z.boolean()),
      }),
    )
    .handler(async ({ input, context }) => saveNotifyPrefs(context.user.id, input)),
};

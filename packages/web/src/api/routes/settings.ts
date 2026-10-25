import { z } from "zod";
import { adminOnly, authed } from "../lib/auth";
import { SETTINGS_DEFAULTS } from "../lib/domain";
import { securitySettings } from "../lib/access";
import { getSettings, setSetting } from "../lib/settings";
import {
  getBotInfo,
  isStubMode,
  listSubscriptions,
  maxConfig,
  subscribeWebhook,
  unsubscribeWebhook,
} from "../max/client";
import { longPollingEnabled } from "../max/polling";

import { schedulerHeartbeat } from "../lib/scheduler";

export const settings = {
  /** Настройки читает любой авторизованный (нужны для отображения времени/названия). */
  get: authed.handler(async () => {
    const map = await getSettings();
    return {
      reminderMinutes: Number.parseInt(map.reminderMinutes ?? "60", 10) || 60,
      stopLateMinutes: Number.parseInt(map.stopLateMinutes ?? "30", 10) || 30,
      alertEscalateMinutes: Number.parseInt(map.alertEscalateMinutes ?? "15", 10) || 15,
      timezone: map.timezone ?? SETTINGS_DEFAULTS.timezone,
      companyName: map.companyName ?? SETTINGS_DEFAULTS.companyName,
    };
  }),

  /** Политика доступа: ручной допуск, сроки сеансов, автоприостановка. */
  security: adminOnly.handler(() => securitySettings()),

  updateSecurity: adminOnly
    .input(
      z.object({
        requireApproval: z.boolean(),
        webSessionHours: z.number().int().min(1).max(720),
        miniAppSessionDays: z.number().int().min(1).max(365),
        inactivityDays: z.number().int().min(0).max(365),
      }),
    )
    .handler(async ({ input }) => {
      await setSetting("requireApproval", input.requireApproval ? "1" : "0");
      await setSetting("webSessionHours", String(input.webSessionHours));
      await setSetting("miniAppSessionDays", String(input.miniAppSessionDays));
      await setSetting("inactivityDays", String(input.inactivityDays));
      return securitySettings();
    }),

  update: adminOnly
    .input(
      z.object({
        reminderMinutes: z.number().min(5).max(2880).optional(),
        stopLateMinutes: z.number().min(5).max(1440).optional(),
        alertEscalateMinutes: z.number().min(1).max(720).optional(),
        timezone: z.string().min(3).optional(),
        companyName: z.string().min(1).optional(),
      }),
    )
    .handler(async ({ input }) => {
      if (input.stopLateMinutes !== undefined) {
        await setSetting("stopLateMinutes", String(input.stopLateMinutes));
      }
      if (input.reminderMinutes !== undefined) {
        await setSetting("reminderMinutes", String(input.reminderMinutes));
      }
      if (input.alertEscalateMinutes !== undefined) {
        await setSetting("alertEscalateMinutes", String(input.alertEscalateMinutes));
      }
      if (input.timezone) await setSetting("timezone", input.timezone);
      if (input.companyName) await setSetting("companyName", input.companyName.trim());
      return getSettings();
    }),

  /** Диагностика связи с MAX: токен, /me, активные подписки на webhook. */
  integration: adminOnly.handler(async () => {
    const base = {
      stub: isStubMode(),
      hasToken: maxConfig.hasToken,
      baseUrl: maxConfig.baseUrl,
      botUsername: maxConfig.botUsername,
      webhookSecretSet: !!maxConfig.webhookSecret,
      longPolling: longPollingEnabled(),
      scheduler: await schedulerHeartbeat(),
    };
    if (isStubMode()) {
      return { ...base, bot: null, subscriptions: [] as { url: string; time: number | null }[], error: null };
    }
    try {
      const [bot, subs] = await Promise.all([getBotInfo(), listSubscriptions()]);
      return {
        ...base,
        bot: bot ? { userId: bot.user_id, name: bot.first_name, username: bot.username ?? null } : null,
        subscriptions: (subs.subscriptions ?? []).map((s) => ({ url: s.url, time: s.time ?? null })),
        error: null,
      };
    } catch (err) {
      return {
        ...base,
        bot: null,
        subscriptions: [] as { url: string; time: number | null }[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }),

  /**
   * Подписать бота на вебхук по публичному HTTPS-адресу.
   * MAX требует валидный сертификат (в т.ч. Минцифры) и ответ 200 за 30 секунд.
   */
  subscribeWebhook: adminOnly
    .input(z.object({ url: z.string().url() }))
    .handler(async ({ input }) => {
      if (isStubMode()) return { ok: false, error: "Режим без бота MAX: подписка недоступна." };
      if (!input.url.startsWith("https://")) {
        return { ok: false, error: "MAX принимает только HTTPS-адреса." };
      }
      try {
        await subscribeWebhook(input.url, maxConfig.webhookSecret);
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),

  /**
   * Снять подписку. Нужно, если адрес устарел или если события должны
   * приходить через long polling (MAX отдаёт их только одним способом).
   */
  unsubscribeWebhook: adminOnly
    .input(z.object({ url: z.string().min(1) }))
    .handler(async ({ input }) => {
      if (isStubMode()) return { ok: false, error: "Режим без бота MAX: подписка недоступна." };
      try {
        await unsubscribeWebhook(input.url);
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
};

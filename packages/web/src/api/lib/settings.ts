import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { SETTINGS_DEFAULTS } from "./domain";

export type SettingsMap = Record<string, string>;

/** Все настройки с подстановкой значений по умолчанию. */
export async function getSettings(): Promise<SettingsMap> {
  const rows = await db.select().from(schema.settings);
  const map: SettingsMap = { ...SETTINGS_DEFAULTS };
  for (const row of rows) map[row.key] = row.value;
  return map;
}

export async function getSetting(key: keyof typeof SETTINGS_DEFAULTS | string): Promise<string> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  if (row) return row.value;
  return (SETTINGS_DEFAULTS as SettingsMap)[key] ?? "";
}

export async function getReminderMinutes(): Promise<number> {
  const raw = await getSetting("reminderMinutes");
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: new Date() },
    });
}

import { lt } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { MaxUpdate } from "./types";

/**
 * Устойчивый ключ события: у нажатия кнопки — callback_id, у сообщения — mid,
 * у остальных — тип + пользователь + время. MAX не даёт общего id события.
 */
export function updateKey(update: MaxUpdate): string | null {
  if (update.update_type === "message_callback" && update.callback?.callback_id) {
    return `cb:${update.callback.callback_id}`;
  }
  if (update.update_type === "message_created" && update.message?.body?.mid) {
    return `msg:${update.message.body.mid}`;
  }
  const user = update.user?.user_id ?? update.user_id ?? update.chat_id ?? "";
  if (!update.timestamp) return null;
  return `${update.update_type}:${user}:${update.timestamp}`;
}

/**
 * Атомарно «забирает» событие: true — обрабатываем, false — его уже обработал
 * кто-то другой (второй процесс, повтор вебхука). Ошибка БД не блокирует обработку.
 */
export async function claimUpdate(update: MaxUpdate): Promise<boolean> {
  const key = updateKey(update);
  if (!key) return true;
  try {
    const rows = await db
      .insert(schema.processedUpdates)
      .values({ key })
      .onConflictDoNothing()
      .returning({ key: schema.processedUpdates.key });
    return rows.length > 0;
  } catch (err) {
    console.error("[max] dedupe:", err instanceof Error ? err.message : err);
    return true;
  }
}

export async function purgeProcessedUpdates() {
  await db
    .delete(schema.processedUpdates)
    .where(lt(schema.processedUpdates.createdAt, new Date(Date.now() - 3 * 86_400_000)));
}

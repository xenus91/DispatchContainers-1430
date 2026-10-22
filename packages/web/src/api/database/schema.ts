import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Схема БД диспетчеризации контейнерных перевозок (MAX).
 * Применить: `bun run db:push` из packages/web.
 */

const now = () => new Date();

/** Сотрудники: admin / dispatcher / driver. Единый whitelist — доступ только по карточке. */
export const staff = sqliteTable(
  "staff",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** admin | dispatcher | driver */
    role: text("role").notNull().default("driver"),
    fullName: text("full_name").notNull(),
    /** Нормализованный телефон, только цифры с кодом страны: 79268776118 */
    phone: text("phone").notNull().unique(),
    /** Заполняется только после активации через бота */
    maxUserId: text("max_user_id"),
    maxChatId: text("max_chat_id"),
    maxUsername: text("max_username"),
    /** pending | awaiting_approval | active | blocked */
    status: text("status").notNull().default("pending"),
    /** Причина блокировки: manual | inactive | expired */
    blockReason: text("block_reason"),
    /** Доступ действует до этой даты (окончание договора); null — бессрочно */
    accessUntil: integer("access_until", { mode: "timestamp" }),
    /** Последнее действие в панели или боте — для автоприостановки неактивных */
    lastActivityAt: integer("last_activity_at", { mode: "timestamp" }),
    /** Подряд неверных кодов входа; при достижении лимита вход блокируется на время */
    loginFailures: integer("login_failures").notNull().default(0),
    loginLockedUntil: integer("login_locked_until", { mode: "timestamp" }),
    /** Гос. номер тягача — для водителей */
    vehicle: text("vehicle"),
    note: text("note"),
    createdById: integer("created_by_id"),
    activatedAt: integer("activated_at", { mode: "timestamp" }),
    blockedAt: integer("blocked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("staff_max_user_idx").on(t.maxUserId), index("staff_role_idx").on(t.role)],
);

/** Персональные одноразовые инвайты (deep-link payload у бота). */
export const invites = sqliteTable(
  "invites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull().unique(),
    staffId: integer("staff_id").notNull(),
    createdById: integer("created_by_id"),
    /** Выбранный пресет в часах: 1 / 24 / 72 / 168 */
    ttlHours: integer("ttl_hours").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("invites_staff_idx").on(t.staffId)],
);

/** OTP-коды для входа в панель (доставляются ботом в личный чат MAX). */
export const otpCodes = sqliteTable(
  "otp_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    staffId: integer("staff_id").notNull(),
    code: text("code").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("otp_staff_idx").on(t.staffId)],
);

/** Сессии панели (Bearer-токен в localStorage — работает и в iframe MAX). */
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull().unique(),
    staffId: integer("staff_id").notNull(),
    /** web — вход по коду в браузере, miniapp — из мини-приложения MAX */
    kind: text("kind").notNull().default("web"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("sessions_staff_idx").on(t.staffId)],
);

/** Заявки — состав полей из «Договор-заявки». */
export const requests = sqliteTable(
  "requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Человекочитаемый номер: З-2026-0001 */
    number: text("number").notNull().unique(),

    containerNo: text("container_no").notNull(),
    /** Футовость: 20DC / 40HC ... */
    containerType: text("container_type"),
    cargoWeight: text("cargo_weight"),
    /** Постановка груженого */
    loadingPoint: text("loading_point"),
    /** Дата рейса в свободной форме: 03.09–04.09 */
    tripDate: text("trip_date"),
    /** Время выгрузки — основной срок, от него считается напоминание */
    unloadAt: integer("unload_at", { mode: "timestamp" }),
    unloadAddress: text("unload_address"),
    /** Контакт на выгрузке */
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    consignee: text("consignee"),
    /** Возврат порожнего */
    returnPoint: text("return_point"),
    returnAddress: text("return_address"),
    coordinates: text("coordinates"),
    terminalPhone: text("terminal_phone"),
    /** Режим работы / перерывы */
    schedule: text("schedule"),
    comment: text("comment"),

    /** new | assigned | accepted | en_route | container_placed | at_warehouse | delivered | cancelled */
    status: text("status").notNull().default("new"),
    driverId: integer("driver_id"),
    createdById: integer("created_by_id"),

    /** Переопределение интервала напоминания (мин). null → глобальная настройка */
    reminderMinutes: integer("reminder_minutes"),
    reminderSentAt: integer("reminder_sent_at", { mode: "timestamp" }),

    /** id последнего отправленного водителю сообщения с карточкой — для актуализации кнопок */
    driverMessageId: text("driver_message_id"),

    assignedAt: integer("assigned_at", { mode: "timestamp" }),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    cancelReason: text("cancel_reason"),

    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("requests_status_idx").on(t.status),
    index("requests_driver_idx").on(t.driverId),
    index("requests_unload_idx").on(t.unloadAt),
  ],
);

/** История статусов и событий по заявке. */
export const statusHistory = sqliteTable(
  "status_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id").notNull(),
    /** статус или служебное событие: created | assigned | reassigned | updated | cancelled | alert_late ... */
    status: text("status").notNull(),
    /** driver | dispatcher | system */
    actorKind: text("actor_kind").notNull().default("driver"),
    actorId: integer("actor_id"),
    actorName: text("actor_name"),
    comment: text("comment"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("history_request_idx").on(t.requestId)],
);

/** Вложения от водителя (фото ТН, акты). */
export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id").notNull(),
    historyId: integer("history_id"),
    uploadedById: integer("uploaded_by_id"),
    /** image | video | file | audio */
    kind: text("kind").notNull().default("image"),
    fileName: text("file_name"),
    /** Токен вложения MAX (может истечь) */
    maxToken: text("max_token"),
    /** Временная ссылка MAX */
    maxUrl: text("max_url"),
    /** Постоянная ссылка в хранилище (Tigris) */
    storedUrl: text("stored_url"),
    sizeBytes: integer("size_bytes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("attachments_request_idx").on(t.requestId)],
);

/** Тревоги: «Возможно опоздание» / «Срыв заявки». */
export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id").notNull(),
    /** late | failure | security | no_contact */
    type: text("type").notNull(),
    message: text("message"),
    raisedById: integer("raised_by_id"),
    raisedByName: text("raised_by_name"),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
    acknowledgedById: integer("acknowledged_by_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("alerts_request_idx").on(t.requestId), index("alerts_ack_idx").on(t.acknowledgedAt)],
);

/** Журнал попыток доступа/регистрации — для раздела «Сотрудники». */
export const accessEvents = sqliteTable(
  "access_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** invite_ok | invite_invalid | phone_mismatch | stranger | blocked_attempt | otp_sent | otp_failed | login_ok | name_rejected */
    kind: text("kind").notNull(),
    staffId: integer("staff_id"),
    phone: text("phone"),
    maxUserId: text("max_user_id"),
    detail: text("detail"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("access_kind_idx").on(t.kind)],
);

/** Глобальные настройки key-value. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

/** Лог исходящих сообщений бота (и очередь режима заглушки). */
export const botOutbox = sqliteTable(
  "bot_outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    staffId: integer("staff_id"),
    maxUserId: text("max_user_id"),
    text: text("text").notNull(),
    payloadJson: text("payload_json"),
    /** stub | sent | failed */
    state: text("state").notNull().default("stub"),
    error: text("error"),
    maxMessageId: text("max_message_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("outbox_staff_idx").on(t.staffId)],
);

/** Диалоговое состояние бота (ожидание комментария/фото по конкретной заявке). */
export const botState = sqliteTable("bot_state", {
  maxUserId: text("max_user_id").primaryKey(),
  staffId: integer("staff_id"),
  /** idle | awaiting_contact | awaiting_name_confirm | awaiting_comment | awaiting_photo */
  step: text("step").notNull().default("idle"),
  requestId: integer("request_id"),
  inviteId: integer("invite_id"),
  dataJson: text("data_json"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

/**
 * Уже обработанные события MAX — защита от двойной обработки (повтор вебхука,
 * два опрашивающих процесса, перезапуск во время обработки). Чистится через 3 дня.
 */
export const processedUpdates = sqliteTable("processed_updates", {
  key: text("key").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

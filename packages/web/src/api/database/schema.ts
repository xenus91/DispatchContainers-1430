import { sqliteTable, text, integer, index, real } from "drizzle-orm/sqlite-core";

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

/* ─────────────── справочники ─────────────── */

/** Клиенты (заказчики перевозок). */
export const clients = sqliteTable(
  "clients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    inn: text("inn"),
    address: text("address"),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    comment: text("comment"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("clients_name_idx").on(t.name)],
);

/** Пункты маршрута: терминалы, склады, места обработки. */
export const points = sqliteTable(
  "points",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** terminal | warehouse | processing */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    lat: real("lat"),
    lon: real("lon"),
    contactName: text("contact_name"),
    phone: text("phone"),
    /** Режим работы / перерывы */
    schedule: text("schedule"),
    comment: text("comment"),
    /** Склад клиента — привязка к клиенту */
    clientId: integer("client_id"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("points_kind_idx").on(t.kind), index("points_client_idx").on(t.clientId)],
);

/** Типы контейнеров: 20DC, 40HC … */
export const containerTypes = sqliteTable("container_types", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name"),
  sort: integer("sort").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

/** Типы операций на остановке и действия водителя внутри них. */
export const operationTypes = sqliteTable("operation_types", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** JSON: виды пунктов, где операция допустима; пусто — любые */
  pointKindsJson: text("point_kinds_json").notNull().default("[]"),
  /** JSON: OperationAction[] */
  actionsJson: text("actions_json").notNull().default("[]"),
  /** JSON: доп. кнопки водителя на остановке (photo/comment/geo/late/failure) */
  extraActionsJson: text("extra_actions_json").notNull().default("[]"),
  sort: integer("sort").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

/** Типы заявок — шаблоны маршрута. */
export const requestTypes = sqliteTable("request_types", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  sort: integer("sort").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

/** Остановки шаблона маршрута. */
export const requestTypeStops = sqliteTable(
  "request_type_stops",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestTypeId: integer("request_type_id").notNull(),
    seq: integer("seq").notNull(),
    /** «Склад клиента №1» */
    label: text("label").notNull(),
    pointKind: text("point_kind").notNull(),
    operationTypeId: integer("operation_type_id").notNull(),
    optional: integer("optional", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("rts_type_idx").on(t.requestTypeId)],
);

/** Заявки: тип, клиент, контейнер и маршрут из остановок (request_stops). */
export const requests = sqliteTable(
  "requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Человекочитаемый номер: З-2026-0001 */
    number: text("number").notNull().unique(),
    requestTypeId: integer("request_type_id").notNull(),
    clientId: integer("client_id").notNull(),
    containerNo: text("container_no").notNull(),
    containerTypeId: integer("container_type_id").notNull(),
    /** Вес груза, тонн */
    cargoWeightT: real("cargo_weight_t").notNull(),
    comment: text("comment"),

    /** new | assigned | accepted | in_progress | done | cancelled */
    status: text("status").notNull().default("new"),
    driverId: integer("driver_id"),
    createdById: integer("created_by_id"),
    /** Тестовый рейс администратора на самого себя */
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),

    /** Переопределение «напомнить за N мин до прибытия». null → глобальная настройка */
    reminderMinutes: integer("reminder_minutes"),
    /** id последнего отправленного водителю сообщения с карточкой — для актуализации кнопок */
    driverMessageId: text("driver_message_id"),
    /** Текущая (первая непройденная) остановка */
    currentStopId: integer("current_stop_id"),

    assignedAt: integer("assigned_at", { mode: "timestamp" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp" }),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    cancelReason: text("cancel_reason"),

    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("requests_status_idx").on(t.status),
    index("requests_driver_idx").on(t.driverId),
    index("requests_client_idx").on(t.clientId),
  ],
);

/** Остановки маршрута заявки. */
export const requestStops = sqliteTable(
  "request_stops",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id").notNull(),
    seq: integer("seq").notNull(),
    pointId: integer("point_id").notNull(),
    operationTypeId: integer("operation_type_id").notNull(),
    /** JSON: OperationSnapshot — копия операции на момент создания заявки */
    operationSnapshotJson: text("operation_snapshot_json").notNull(),
    plannedArrivalAt: integer("planned_arrival_at", { mode: "timestamp" }),
    arrivedAt: integer("arrived_at", { mode: "timestamp" }),
    doneAt: integer("done_at", { mode: "timestamp" }),
    /** JSON: DoneAction[] — отмеченные водителем действия */
    doneActionsJson: text("done_actions_json").notNull().default("[]"),
    reminderSentAt: integer("reminder_sent_at", { mode: "timestamp" }),
    lateAlertAt: integer("late_alert_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("stops_request_idx").on(t.requestId)],
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
    /** Остановка маршрута и действие, к которым относится событие */
    stopId: integer("stop_id"),
    actionKey: text("action_key"),
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
    stopId: integer("stop_id"),
    actionKey: text("action_key"),
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
    /** late | failure | security | no_contact | stop_late */
    type: text("type").notNull(),
    stopId: integer("stop_id"),
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

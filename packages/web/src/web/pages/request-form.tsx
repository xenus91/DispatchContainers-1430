import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "../components/shell";
import { errorText } from "../lib/api";
import { minutesLabel, toLocalInput } from "../lib/format";
import { closingConfirmation } from "../lib/miniapp";
import { useCreateRequest, useRequest, useUpdateRequest } from "../queries/requests";
import { useDrivers } from "../queries/staff";
import { useSettings } from "../queries/settings";

type FormState = {
  containerNo: string;
  containerType: string;
  cargoWeight: string;
  loadingPoint: string;
  tripDate: string;
  unloadAt: string;
  unloadAddress: string;
  contactName: string;
  contactPhone: string;
  consignee: string;
  returnPoint: string;
  returnAddress: string;
  coordinates: string;
  terminalPhone: string;
  schedule: string;
  comment: string;
  driverId: string;
  reminderMinutes: string;
};

const EMPTY: FormState = {
  containerNo: "",
  containerType: "",
  cargoWeight: "",
  loadingPoint: "",
  tripDate: "",
  unloadAt: "",
  unloadAddress: "",
  contactName: "",
  contactPhone: "",
  consignee: "",
  returnPoint: "",
  returnAddress: "",
  coordinates: "",
  terminalPhone: "",
  schedule: "",
  comment: "",
  driverId: "",
  reminderMinutes: "",
};

function Input({
  label,
  value,
  onChange,
  placeholder,
  mono,
  required,
  type = "text",
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  required?: boolean;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        {label}
        {required && <span className="text-[var(--danger)]"> *</span>}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? "mono w-full" : "w-full"}
      />
      {hint && <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">{hint}</span>}
    </label>
  );
}

export default function RequestForm({ id }: { id?: string }) {
  const editing = !!id;
  const requestId = id ? Number(id) : null;
  const [, navigate] = useLocation();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  const existing = useRequest(editing ? requestId : null);
  const drivers = useDrivers();
  const settings = useSettings();
  const create = useCreateRequest();
  const update = useUpdateRequest();
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  useEffect(() => {
    if (!editing || loaded || !existing.data) return;
    const r = existing.data.request;
    setForm({
      containerNo: r.containerNo ?? "",
      containerType: r.containerType ?? "",
      cargoWeight: r.cargoWeight ?? "",
      loadingPoint: r.loadingPoint ?? "",
      tripDate: r.tripDate ?? "",
      unloadAt: toLocalInput(r.unloadAt),
      unloadAddress: r.unloadAddress ?? "",
      contactName: r.contactName ?? "",
      contactPhone: r.contactPhone ?? "",
      consignee: r.consignee ?? "",
      returnPoint: r.returnPoint ?? "",
      returnAddress: r.returnAddress ?? "",
      coordinates: r.coordinates ?? "",
      terminalPhone: r.terminalPhone ?? "",
      schedule: r.schedule ?? "",
      comment: r.comment ?? "",
      driverId: r.driverId ? String(r.driverId) : "",
      reminderMinutes: r.reminderMinutes ? String(r.reminderMinutes) : "",
    });
    setLoaded(true);
  }, [editing, loaded, existing.data]);

  const dirty = Object.values(form).some((v) => v !== "");

  // В мини-приложении MAX просим подтверждение закрытия, пока заявка не сохранена.
  useEffect(() => {
    closingConfirmation(dirty);
    return () => closingConfirmation(false);
  }, [dirty]);

  const set = (key: keyof FormState) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      containerNo: form.containerNo,
      containerType: form.containerType || undefined,
      cargoWeight: form.cargoWeight || undefined,
      loadingPoint: form.loadingPoint || undefined,
      tripDate: form.tripDate || undefined,
      unloadAt: form.unloadAt ? new Date(form.unloadAt).toISOString() : null,
      unloadAddress: form.unloadAddress || undefined,
      contactName: form.contactName || undefined,
      contactPhone: form.contactPhone || undefined,
      consignee: form.consignee || undefined,
      returnPoint: form.returnPoint || undefined,
      returnAddress: form.returnAddress || undefined,
      coordinates: form.coordinates || undefined,
      terminalPhone: form.terminalPhone || undefined,
      schedule: form.schedule || undefined,
      comment: form.comment || undefined,
      driverId: form.driverId ? Number(form.driverId) : null,
      reminderMinutes: form.reminderMinutes ? Number(form.reminderMinutes) : null,
    };

    if (editing && requestId) {
      await update.mutateAsync({ ...payload, id: requestId });
      navigate(`/requests/${requestId}`);
    } else {
      const created = await create.mutateAsync(payload);
      navigate(`/requests/${created.id}`);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => navigate(editing ? `/requests/${requestId}` : "/")}>
          <ArrowLeft className="size-4" />
          Назад
        </Button>
        <h1 className="text-xl font-extrabold tracking-tight">
          {editing ? `Редактирование ${existing.data?.request.number ?? ""}` : "Новая заявка"}
        </h1>
        <Button type="submit" size="sm" className="ml-auto" disabled={busy || form.containerNo.length < 2}>
          <Save className="size-4" />
          {busy ? "Сохраняем…" : editing ? "Сохранить" : "Создать заявку"}
        </Button>
      </div>

      {!!error && (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-4 py-3 text-sm font-semibold text-[var(--danger)]">
          {errorText(error)}
        </div>
      )}

      <Card title="Груз и контейнер">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Input label="Номер контейнера" value={form.containerNo} onChange={set("containerNo")} mono required placeholder="MSKU1234567" />
          <Input label="Тип контейнера" value={form.containerType} onChange={set("containerType")} placeholder="40HC" />
          <Input label="Вес груза" value={form.cargoWeight} onChange={set("cargoWeight")} placeholder="24 т" />
          <Input label="Место погрузки (терминал)" value={form.loadingPoint} onChange={set("loadingPoint")} />
          <Input label="Дата рейса" value={form.tripDate} onChange={set("tripDate")} placeholder="18.09.2026" />
          <Input label="Телефон терминала" value={form.terminalPhone} onChange={set("terminalPhone")} mono />
        </div>
      </Card>

      <Card title="Выгрузка">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Input label="Дата и время выгрузки" value={form.unloadAt} onChange={set("unloadAt")} type="datetime-local" />
          <Input label="Адрес склада" value={form.unloadAddress} onChange={set("unloadAddress")} />
          <Input label="Координаты" value={form.coordinates} onChange={set("coordinates")} mono placeholder="55.7558, 37.6173" />
          <Input label="Грузополучатель" value={form.consignee} onChange={set("consignee")} />
          <Input label="Контактное лицо" value={form.contactName} onChange={set("contactName")} />
          <Input label="Телефон контакта" value={form.contactPhone} onChange={set("contactPhone")} mono />
          <Input label="Режим работы склада" value={form.schedule} onChange={set("schedule")} placeholder="09:00–18:00, обед 13:00–14:00" />
        </div>
      </Card>

      <Card title="Возврат порожнего">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Место возврата" value={form.returnPoint} onChange={set("returnPoint")} />
          <Input label="Адрес возврата" value={form.returnAddress} onChange={set("returnAddress")} />
        </div>
      </Card>

      <Card title="Водитель и напоминание">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Водитель
            </span>
            <select value={form.driverId} onChange={(e) => set("driverId")(e.target.value)} className="w-full">
              <option value="">— не назначать —</option>
              {drivers.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.selfTest ? `Я — ${d.fullName} · тестовый рейс` : d.fullName}
                  {d.vehicle && !d.selfTest ? ` · ${d.vehicle}` : ""}
                  {d.inBot ? "" : " · не в боте"}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
              {drivers.data?.find((d) => String(d.id) === form.driverId && d.selfTest)
                ? "Тестовый рейс на вас: карточка с кнопками статусов придёт вам в чат бота MAX"
                : drivers.data?.find((d) => String(d.id) === form.driverId && !d.inBot)
                  ? "Водитель ещё не активирован в MAX — карточка заявки придёт ему сразу после регистрации"
                  : "Карточка заявки уйдёт водителю в MAX сразу после сохранения"}
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Напомнить водителю за
            </span>
            <select
              value={form.reminderMinutes}
              onChange={(e) => set("reminderMinutes")(e.target.value)}
              className="w-full"
            >
              <option value="">
                По умолчанию ({minutesLabel(settings.data?.reminderMinutes ?? 120)})
              </option>
              {[30, 60, 90, 120, 180, 240, 360, 720].map((m) => (
                <option key={m} value={m}>
                  {minutesLabel(m)} до выгрузки
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
              Переопределяет глобальную настройку только для этой заявки
            </span>
          </label>
        </div>
      </Card>

      <Card title="Комментарий диспетчера">
        <textarea
          value={form.comment}
          onChange={(e) => set("comment")(e.target.value)}
          rows={4}
          placeholder="Особые условия, пропуск, требования склада…"
          className="w-full"
        />
      </Card>
    </form>
  );
}

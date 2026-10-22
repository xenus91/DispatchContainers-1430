import { useState } from "react";
import { Link } from "wouter";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge, Card, Empty } from "../components/shell";
import { AlertBadge, StatusBadge } from "../components/status-badge";
import { fmtDateTime, fmtRelative } from "../lib/format";
import { formatPhone } from "../../api/lib/domain";
import {
  useAcknowledgeAlert,
  useOpenAlerts,
  useRequests,
  useStats,
  type RequestScope,
} from "../queries/requests";

const SCOPES: { key: RequestScope; label: string }[] = [
  { key: "active", label: "В работе" },
  { key: "archive", label: "Архив" },
  { key: "all", label: "Все" },
];

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-[var(--surface)] px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        {label}
      </div>
      <div className={cn("mono mt-1 text-2xl font-bold", tone)}>{value}</div>
    </div>
  );
}

export default function Requests() {
  const [scope, setScope] = useState<RequestScope>("active");
  const list = useRequests(scope);
  const stats = useStats();
  const alerts = useOpenAlerts();
  const ack = useAcknowledgeAlert();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Заявки на перевозку</h1>
          <p className="text-xs text-[var(--muted-foreground)]">
            Обновляется автоматически каждые 10 секунд
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
            <RefreshCw className={cn("size-4", list.isFetching && "animate-spin")} />
            Обновить
          </Button>
          <Button size="sm" asChild>
            <Link href="/requests/new">
              <Plus className="size-4" />
              Новая заявка
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="В работе" value={stats.data?.active ?? 0} />
        <Tile label="Без водителя" value={stats.data?.unassigned ?? 0} tone="text-[var(--warning)]" />
        <Tile label="Просрочено" value={stats.data?.late ?? 0} tone="text-[var(--danger)]" />
        <Tile label="Сдано сегодня" value={stats.data?.deliveredToday ?? 0} tone="text-[var(--success)]" />
        <Tile label="Открытых тревог" value={stats.data?.openAlerts ?? 0} tone="text-[var(--danger)]" />
      </div>

      {!!alerts.data?.length && (
        <Card title={`Тревоги без реакции · ${alerts.data.length}`}>
          <ul className="space-y-2">
            {alerts.data.map((alert) => (
              <li
                key={alert.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2"
              >
                <AlertBadge type={alert.type} />
                <Link
                  href={`/requests/${alert.requestId}`}
                  className="mono text-sm font-bold text-[var(--primary)] hover:underline"
                >
                  {alert.requestNumber ?? `#${alert.requestId}`}
                </Link>
                <span className="mono text-xs text-[var(--muted-foreground)]">{alert.containerNo}</span>
                <span className="min-w-0 flex-1 text-xs text-[var(--muted-foreground)]">
                  {alert.message || alert.raisedByName || "—"}
                </span>
                <span className="mono text-xs text-[var(--muted-foreground)]">
                  {fmtDateTime(alert.createdAt)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={ack.isPending}
                  onClick={() => ack.mutate({ alertId: alert.id })}
                >
                  Принял
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex gap-1 rounded-md border border-border bg-[var(--surface)] p-1">
        {SCOPES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setScope(s.key)}
            className={cn(
              "rounded px-3 py-1.5 text-xs font-bold transition-colors",
              scope === s.key
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "text-[var(--muted-foreground)] hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {list.isLoading ? (
        <Empty text="Загружаем заявки…" />
      ) : !list.data?.length ? (
        <Empty text="Заявок нет. Создайте первую по кнопке «Новая заявка»." />
      ) : (
        <>
          {/* Таблица — ПК */}
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-[var(--surface)] lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  <th className="px-4 py-2.5 font-semibold">Заявка</th>
                  <th className="px-4 py-2.5 font-semibold">Контейнер</th>
                  <th className="px-4 py-2.5 font-semibold">Водитель</th>
                  <th className="px-4 py-2.5 font-semibold">Статус</th>
                  <th className="px-4 py-2.5 font-semibold">Выгрузка</th>
                  <th className="px-4 py-2.5 font-semibold">Адрес склада</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((row) => (
                  <tr
                    key={row.id}
                    className={cn(
                      "border-b border-border/60 last:border-0 hover:bg-[var(--surface-2)]",
                      row.openAlertTypes.length &&
                        "bg-[color-mix(in_srgb,var(--danger)_7%,transparent)]",
                    )}
                  >
                    <td className="px-4 py-3 align-top">
                      <Link
                        href={`/requests/${row.id}`}
                        className="mono font-bold text-[var(--primary)] hover:underline"
                      >
                        {row.number}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.openAlertTypes.map((t) => (
                          <AlertBadge key={t} type={t} />
                        ))}
                      </div>
                    </td>
                    <td className="mono px-4 py-3 align-top">
                      {row.containerNo}
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {row.containerType ?? "—"} · {row.cargoWeight ?? "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {row.driverName ?? (
                        <span className="text-[var(--warning)]">не назначен</span>
                      )}
                      {row.driverVehicle && (
                        <div className="mono text-xs text-[var(--muted-foreground)]">
                          {row.driverVehicle}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="mono px-4 py-3 align-top">
                      {fmtDateTime(row.unloadAt)}
                      <div
                        className={cn(
                          "text-xs",
                          row.isLate ? "text-[var(--danger)]" : "text-[var(--muted-foreground)]",
                        )}
                      >
                        {fmtRelative(row.unloadAt)}
                      </div>
                    </td>
                    <td className="max-w-[260px] px-4 py-3 align-top text-xs text-[var(--muted-foreground)]">
                      {row.unloadAddress ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Карточки — телефон и Mini App */}
          <div className="space-y-3 lg:hidden">
            {list.data.map((row) => (
              <Link
                key={row.id}
                href={`/requests/${row.id}`}
                className={cn(
                  "block rounded-lg border border-border bg-[var(--surface)] p-3",
                  row.openAlertTypes.length &&
                    "border-[color-mix(in_srgb,var(--danger)_40%,transparent)]",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="mono text-sm font-bold text-[var(--primary)]">{row.number}</span>
                  <StatusBadge status={row.status} />
                </div>
                <div className="mono mt-2 text-sm">{row.containerNo}</div>
                <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {row.driverName ?? "водитель не назначен"} · выгрузка {fmtDateTime(row.unloadAt)}
                </div>
                {row.contactPhone && (
                  <div className="mono mt-1 text-xs text-[var(--muted-foreground)]">
                    {formatPhone(row.contactPhone)}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-1">
                  {row.openAlertTypes.map((t) => (
                    <AlertBadge key={t} type={t} />
                  ))}
                  {row.isLate && !row.openAlertTypes.length && <Badge tone="warning">просрочка</Badge>}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

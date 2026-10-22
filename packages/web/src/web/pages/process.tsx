import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Camera, Lock, Plus, RotateCcw, Save, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card } from "../components/shell";
import { errorText } from "../lib/api";
import { useProcess, useResetProcess, useSaveProcess } from "../queries/process";
import {
  FINAL_STEP_KEY,
  STEP_ACTIONS,
  availableActions,
  nextStep,
  statusLabel,
  validateProcess,
  type ProcessDef,
  type ProcessStep,
  type StepAction,
} from "../../api/lib/process-def";
import { Toggle } from "../components/ui/toggle";

const ACTION_ICONS: Record<StepAction, string> = {
  photo: "📷",
  comment: "💬",
  geo: "📍",
  late: "⏳",
  failure: "🚨",
};

const labelCls = "mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]";

function ActionChips({ value, onChange }: { value: StepAction[]; onChange: (v: StepAction[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {STEP_ACTIONS.map((a) => {
        const on = value.includes(a.key);
        return (
          <button
            key={a.key}
            type="button"
            title={a.hint}
            onClick={() => onChange(on ? value.filter((x) => x !== a.key) : [...value, a.key])}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
              on
                ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-[var(--primary)]"
                : "border-border text-[var(--muted-foreground)] hover:text-foreground",
            )}
          >
            {ACTION_ICONS[a.key]} {a.label}
          </button>
        );
      })}
    </div>
  );
}

/** Предпросмотр того, что увидит водитель в MAX на выбранном шаге. */
function DriverPreview({ process, status }: { process: ProcessDef; status: string }) {
  const next = nextStep(process, status);
  const actions = availableActions(process, status);
  const closed = status === FINAL_STEP_KEY;
  const rows: { text: string; tone: "pos" | "neg" | "def" }[][] = [];
  if (next) rows.push([{ text: next.buttonText || "—", tone: "pos" }]);
  const extra: { text: string; tone: "def" }[] = [];
  if (actions.includes("photo")) extra.push({ text: "📷 Фото/скан", tone: "def" });
  if (actions.includes("comment")) extra.push({ text: "💬 Комментарий", tone: "def" });
  if (extra.length) rows.push(extra);
  if (actions.includes("geo")) rows.push([{ text: "📍 Отправить геолокацию", tone: "def" }]);
  if (actions.includes("late")) rows.push([{ text: "⏳ Возможно опоздание", tone: "neg" }]);
  if (actions.includes("failure")) rows.push([{ text: "🚨 Срыв заявки", tone: "neg" }]);

  return (
    <div className="rounded-xl bg-[#e9edf2] p-3 text-[#1b1f24]">
      <div className="max-w-[300px] rounded-2xl rounded-tl-sm bg-white p-3 text-[13px] leading-snug shadow-sm">
        <div className="font-bold">Заявка З-2026-0042</div>
        <div className="mt-1 text-[12px] text-[#5b6470]">№ контейнера: MSKU 123456-7 · 40HC</div>
        <div className="mt-2">
          <b>Текущий статус:</b> {statusLabel(process, status)}
        </div>
        {next?.photoRequired && (
          <div className="mt-2 text-[12px]">
            📷 Для шага «{next.label}» понадобится фото: {next.photoHint || "…"}
          </div>
        )}
      </div>
      <div className="mt-1.5 max-w-[300px] space-y-1">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-1">
            {row.map((b) => (
              <div
                key={b.text}
                className={cn(
                  "flex-1 truncate rounded-lg px-2 py-1.5 text-center text-[12px] font-semibold",
                  b.tone === "pos" && "bg-[#2b8a3e] text-white",
                  b.tone === "neg" && "bg-white text-[#c92a2a]",
                  b.tone === "def" && "bg-white text-[#1864ab]",
                )}
              >
                {b.text}
              </div>
            ))}
          </div>
        ))}
        {!rows.length && (
          <div className="rounded-lg bg-white/70 px-2 py-1.5 text-center text-[12px] text-[#5b6470]">
            {closed ? "Заявка закрыта — кнопок нет" : "Кнопок нет"}
          </div>
        )}
      </div>
      {next?.photoRequired && (
        <div className="mt-2 text-[11px] text-[#5b6470]">
          После нажатия «{next.buttonText}» бот попросит фото и засчитает шаг только после кнопки «Готово».
        </div>
      )}
    </div>
  );
}

function uniqueKey(steps: ProcessStep[]) {
  let n = steps.length;
  while (steps.some((s) => s.key === `step_${n}`)) n += 1;
  return `step_${n}`;
}

export default function ProcessPage() {
  const q = useProcess();
  const save = useSaveProcess();
  const reset = useResetProcess();
  const [draft, setDraft] = useState<ProcessDef | null>(null);
  const [dirty, setDirty] = useState(false);
  // Своё подтверждение вместо window.confirm — в webview MAX системные диалоги не показываются.
  const [confirmReset, setConfirmReset] = useState(false);
  const [preview, setPreview] = useState<string>("assigned");

  useEffect(() => {
    if (q.data && !dirty) setDraft(structuredClone(q.data.process));
  }, [q.data, dirty]);

  const error = useMemo(() => (draft ? validateProcess(draft) : null), [draft]);

  if (!q.data || !draft) return <div className="text-sm text-[var(--muted-foreground)]">Загрузка…</div>;

  const usage = q.data.usage;
  const savedKeys = new Set(q.data.process.steps.map((s) => s.key));

  const set = (next: ProcessDef) => {
    setDraft(next);
    setDirty(true);
  };
  const setStep = (i: number, patch: Partial<ProcessStep>) =>
    set({ ...draft, steps: draft.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });
  const move = (i: number, dir: -1 | 1) => {
    const steps = [...draft.steps];
    const j = i + dir;
    if (j < 0 || j >= steps.length - 1) return; // финальный шаг всегда последний
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    set({ ...draft, steps });
  };
  const remove = (i: number) => set({ ...draft, steps: draft.steps.filter((_, idx) => idx !== i) });
  const addStep = () => {
    const steps = [...draft.steps];
    const step: ProcessStep = {
      key: uniqueKey(steps),
      label: "Новый шаг",
      buttonText: "▶️ Новый шаг",
      photoRequired: false,
      photoHint: "",
      actions: ["comment", "late", "failure"],
      notifyDefault: false,
    };
    steps.splice(steps.length - 1, 0, step);
    set({ ...draft, steps });
  };

  const previewOptions = [
    { key: "assigned", label: "Назначена (до первого шага)" },
    ...draft.steps.map((s, i) => ({ key: s.key, label: `${i + 1}. ${s.label || s.key}` })),
  ];
  const previewStatus = previewOptions.some((o) => o.key === preview) ? preview : "assigned";

  return (
    <div className="space-y-5 pb-24">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Процесс перевозки</h1>
        <p className="max-w-3xl text-xs text-[var(--muted-foreground)]">
          Шаги, которые водитель проходит кнопками в MAX. Здесь задаются кнопки на каждом шаге, обязательные фото и
          какие переходы уведомлять по умолчанию. Изменения применяются к боту сразу после сохранения — в том числе к
          заявкам в работе.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card title="Общие правила">
            <div className="space-y-4">
              <div>
                <span className={labelCls}>Кнопки водителя, пока заявка только назначена</span>
                <ActionChips
                  value={draft.assignedActions}
                  onChange={(v) => set({ ...draft, assignedActions: v })}
                />
                <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                  Плюс кнопка первого шага «{draft.steps[0]?.buttonText}».
                </span>
              </div>
              <div className="flex items-start gap-3">
                <Toggle
                  label="Подтверждать переходы"
                  checked={draft.confirmTransitions}
                  onChange={(v) => set({ ...draft, confirmTransitions: v })}
                />
                <span>
                  <span className="block text-sm font-bold">Подтверждать переходы</span>
                  <span className="block text-xs text-[var(--muted-foreground)]">
                    Бот спросит «Отметить …? Да / Нет» — защита от случайных нажатий. Шаги с фото подтверждаются
                    кнопкой «Готово».
                  </span>
                </span>
              </div>
            </div>
          </Card>

          <ol className="space-y-3">
            {draft.steps.map((s, i) => {
              const final = s.key === FINAL_STEP_KEY && i === draft.steps.length - 1;
              const used = usage[s.key] ?? 0;
              const keyLocked = final || (savedKeys.has(s.key) && used > 0);
              return (
                <li
                  key={i}
                  className={cn(
                    "rounded-lg border bg-[var(--surface)]",
                    previewStatus === s.key ? "border-[var(--primary)]" : "border-border",
                  )}
                >
                  <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                    <span className="mono grid size-6 place-items-center rounded-full bg-[var(--surface-2)] text-xs font-bold">
                      {i + 1}
                    </span>
                    <span className="truncate text-sm font-extrabold">{s.label || "Без названия"}</span>
                    {final && (
                      <span className="flex items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
                        <Lock className="size-3" /> закрывает заявку
                      </span>
                    )}
                    {used > 0 && (
                      <span className="rounded-full bg-[var(--surface-2)] px-2 text-[11px] font-semibold">
                        сейчас заявок: {used}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-xs font-semibold text-[var(--primary)] hover:bg-[var(--surface-2)]"
                        onClick={() => setPreview(s.key)}
                      >
                        Предпросмотр
                      </button>
                      {!final && (
                        <>
                          <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} title="Выше">
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={i >= draft.steps.length - 2}
                            onClick={() => move(i, 1)}
                            title="Ниже"
                          >
                            <ArrowDown className="size-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={used > 0 || draft.steps.length <= 2}
                            onClick={() => remove(i)}
                            title={used > 0 ? "На этом шаге есть заявки в работе" : "Удалить шаг"}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </header>

                  <div className="grid gap-3 p-4 sm:grid-cols-2">
                    <label className="block">
                      <span className={labelCls}>Название статуса</span>
                      <input
                        className="w-full"
                        aria-label="Название статуса"
                        value={s.label}
                        maxLength={64}
                        onChange={(e) => setStep(i, { label: e.target.value })}
                      />
                    </label>
                    <label className="block">
                      <span className={labelCls}>Текст кнопки у водителя</span>
                      <input
                        className="w-full"
                        aria-label="Текст кнопки"
                        value={s.buttonText}
                        maxLength={64}
                        onChange={(e) => setStep(i, { buttonText: e.target.value })}
                      />
                    </label>

                    <div className="sm:col-span-2">
                      <span className={labelCls}>Кнопки на этом шаге</span>
                      <ActionChips value={s.actions} onChange={(v) => setStep(i, { actions: v })} />
                    </div>

                    <div className="space-y-2 sm:col-span-2">
                      <div className="flex items-center gap-3">
                        <Toggle
                          label="Переход только с фото"
                          checked={s.photoRequired}
                          onChange={(v) => setStep(i, { photoRequired: v })}
                        />
                        <span className="flex items-center gap-1.5 text-sm font-semibold">
                          <Camera className="size-4" /> Переход только с фото/сканом
                        </span>
                      </div>
                      {s.photoRequired && (
                        <input
                          className="w-full"
                          aria-label="Что сфотографировать"
                          placeholder="Что сфотографировать, например: акт сдачи и ТН с печатью"
                          value={s.photoHint}
                          maxLength={200}
                          onChange={(e) => setStep(i, { photoHint: e.target.value })}
                        />
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      <Toggle
                        label="Уведомлять диспетчеров"
                        checked={s.notifyDefault}
                        onChange={(v) => setStep(i, { notifyDefault: v })}
                      />
                      <span className="text-sm">
                        Уведомлять диспетчеров
                        <span className="block text-[11px] text-[var(--muted-foreground)]">
                          по умолчанию; каждый может изменить у себя
                        </span>
                      </span>
                    </div>

                    <label className="block">
                      <span className={labelCls}>Системный ключ</span>
                      <input
                        className="mono w-full"
                        aria-label="Системный ключ"
                        value={s.key}
                        disabled={keyLocked}
                        maxLength={32}
                        onChange={(e) => setStep(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
                      />
                      <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                        {final
                          ? "Финальный шаг — всегда delivered"
                          : keyLocked
                            ? "Нельзя менять, пока на шаге есть заявки"
                            : "Латиница, цифры и «_»; хранится в истории заявок"}
                      </span>
                    </label>
                  </div>
                </li>
              );
            })}
          </ol>

          <Button variant="outline" onClick={addStep} disabled={draft.steps.length >= 15}>
            <Plus className="size-4" /> Добавить шаг перед финальным
          </Button>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
          <Card title="Так увидит водитель">
            <label className="mb-3 block">
              <span className={labelCls}>Состояние заявки</span>
              <select aria-label="Состояние заявки" className="w-full" value={previewStatus} onChange={(e) => setPreview(e.target.value)}>
                {previewOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <DriverPreview process={draft} status={previewStatus} />
          </Card>
          <Card title="Маршрут">
            <ol className="space-y-1 text-sm">
              <li className="text-[var(--muted-foreground)]">Новая → Назначена</li>
              {draft.steps.map((s, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="mono text-xs text-[var(--muted-foreground)]">{i + 1}</span>
                  <span className="font-semibold">{s.label || "—"}</span>
                  {s.photoRequired && <Camera className="size-3.5 text-[var(--muted-foreground)]" />}
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-[var(--surface)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3">
          <span className="mono text-xs text-[var(--muted-foreground)]">версия {q.data.process.version}</span>
          {error && <span className="text-xs font-semibold text-[var(--danger)]">{error}</span>}
          {!error && save.isError && (
            <span className="text-xs font-semibold text-[var(--danger)]">{errorText(save.error)}</span>
          )}
          {reset.isError && <span className="text-xs text-[var(--danger)]">{errorText(reset.error)}</span>}
          {save.isSuccess && !dirty && <span className="text-xs text-[var(--success)]">Сохранено, бот обновлён</span>}
          <div className="ml-auto flex gap-2">
            {confirmReset ? (
              <div className="flex items-center gap-2 rounded-md border border-[var(--warning)] px-2 py-1">
                <span className="text-xs font-semibold">Вернуть стандартные 5 шагов?</span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={reset.isPending}
                  onClick={() =>
                    reset.mutate(undefined, {
                      onSuccess: () => setDirty(false),
                      onSettled: () => setConfirmReset(false),
                    })
                  }
                >
                  Да, сбросить
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  Нет
                </Button>
              </div>
            ) : (
              <Button variant="ghost" disabled={reset.isPending} onClick={() => setConfirmReset(true)}>
                <RotateCcw className="size-4" /> По умолчанию
              </Button>
            )}
            <Button variant="outline" disabled={!dirty} onClick={() => setDirty(false)}>
              <Undo2 className="size-4" /> Отменить
            </Button>
            <Button
              disabled={!dirty || !!error || save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    assignedActions: draft.assignedActions,
                    confirmTransitions: draft.confirmTransitions,
                    steps: draft.steps,
                  },
                  { onSuccess: () => setDirty(false) },
                )
              }
            >
              <Save className="size-4" /> {save.isPending ? "Сохраняем…" : "Сохранить"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

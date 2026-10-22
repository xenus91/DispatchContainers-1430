import { ALERT_LABELS } from "../../api/lib/domain";
import { useStatusLabel } from "../queries/process";
import { Badge, type BadgeTone } from "./ui/badge";

const STATUS_TONES: Record<string, BadgeTone> = {
  new: "warning",
  assigned: "primary",
  accepted: "info",
  en_route: "info",
  container_placed: "info",
  at_warehouse: "info",
  delivered: "success",
  cancelled: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  const label = useStatusLabel();
  return <Badge tone={STATUS_TONES[status] ?? "info"}>{label(status)}</Badge>;
}

export function AlertBadge({ type }: { type: string }) {
  const tone: BadgeTone = type === "late" ? "warning" : "danger";
  return (
    <Badge tone={tone}>
      {type === "late" ? "⚠" : "⛔"} {ALERT_LABELS[type] ?? type}
    </Badge>
  );
}

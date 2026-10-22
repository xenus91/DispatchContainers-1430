import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_PROCESS, statusLabel } from "../../api/lib/process-def";
import { client, orpc } from "../lib/api";

export function useProcess() {
  return useQuery(orpc.process.get.queryOptions({ staleTime: 60_000 }));
}

/** Подпись статуса с учётом текущего процесса (шаги настраиваются админом). */
export function useStatusLabel() {
  const q = useProcess();
  const proc = q.data?.process ?? DEFAULT_PROCESS;
  return (status: string) => statusLabel(proc, status);
}

type SaveProcessInput = Parameters<typeof client.process.save>[0];

export function useSaveProcess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveProcessInput) => client.process.save(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.process.key() });
      void qc.invalidateQueries({ queryKey: orpc.notifications.key() });
    },
  });
}

export function useResetProcess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.process.reset(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.process.key() });
      void qc.invalidateQueries({ queryKey: orpc.notifications.key() });
    },
  });
}

export function useNotifications() {
  return useQuery(orpc.notifications.get.queryOptions({ staleTime: 30_000 }));
}

type SaveNotifyInput = Parameters<typeof client.notifications.save>[0];

export function useSaveNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveNotifyInput) => client.notifications.save(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.notifications.key() });
    },
  });
}

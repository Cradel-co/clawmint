import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

const BASE = `${API_BASE}/api/logs`;

export function useLogsConfig() {
  return useQuery({
    queryKey: ['logs-config'],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/config`);
      return res.json();
    },
  });
}

export function useLogsTail(lines = 100) {
  return useQuery({
    queryKey: ['logs-tail', lines],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/tail?lines=${lines}`);
      return res.json();
    },
    refetchInterval: 5_000,
  });
}

export function useUpdateLogsConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiFetch(`${BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logs-config'] }),
  });
}

export function useClearLogs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch(BASE, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logs-tail'] }),
  });
}

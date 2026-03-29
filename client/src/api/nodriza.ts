import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

const BASE = `${API_BASE}/api/nodriza`;

export function useNodrizaConfig() {
  return useQuery({
    queryKey: ['nodriza-config'],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/config`);
      return res.json();
    },
  });
}

export function useNodrizaStatus() {
  return useQuery({
    queryKey: ['nodriza-status'],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/status`);
      return res.json();
    },
    refetchInterval: 10_000,
  });
}

export function useUpdateNodriza() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cfg: { url?: string; serverId?: string; apiKey?: string; enabled?: boolean }) => {
      const res = await apiFetch(`${BASE}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nodriza-config'] }),
  });
}

export function useReconnectNodriza() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`${BASE}/reconnect`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nodriza-status'] }),
  });
}

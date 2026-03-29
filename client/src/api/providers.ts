import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import type { ProvidersResponse } from '../types/api';

const BASE = `${API_BASE}/api/providers`;

export function useProviders() {
  return useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: async () => {
      const res = await apiFetch(BASE);
      return res.json();
    },
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, apiKey, model }: { name: string; apiKey?: string; model?: string }) => {
      await apiFetch(`${BASE}/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useSetDefaultProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: string) => {
      await apiFetch(`${BASE}/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

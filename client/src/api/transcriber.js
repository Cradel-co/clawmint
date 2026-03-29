import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

const BASE = `${API_BASE}/api/transcriber`;

export function useTranscriberConfig() {
  return useQuery({
    queryKey: ['transcriber-config'],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/config`);
      return res.json();
    },
  });
}

export function useUpdateTranscriber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cfg) => {
      const res = await apiFetch(`${BASE}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transcriber-config'] }),
  });
}

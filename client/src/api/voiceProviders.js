import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

const BASE = `${API_BASE}/api/voice-providers`;

export function useVoiceProviders() {
  return useQuery({
    queryKey: ['voice-providers'],
    queryFn: async () => {
      const res = await apiFetch(BASE);
      return res.json();
    },
  });
}

export function useUpdateVoiceProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, apiKey, voice, model }) => {
      const res = await apiFetch(`${BASE}/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, voice, model }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice-providers'] }),
  });
}

export function useSetDefaultVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider) => {
      const res = await apiFetch(`${BASE}/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice-providers'] }),
  });
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

const BASE = `${API_BASE}/api/telegram`;

export function useTelegramBots() {
  return useQuery({
    queryKey: ['telegram-bots'],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/bots`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function useInvalidateTelegramBots() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['telegram-bots'] });
}

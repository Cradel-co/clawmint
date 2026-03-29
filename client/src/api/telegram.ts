import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import type { TelegramBot } from '../types/api';

const BASE = `${API_BASE}/api/telegram`;

export function useTelegramBots() {
  return useQuery<TelegramBot[]>({
    queryKey: ['telegram-bots'],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/bots`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    refetchInterval: 3000,
  });
}

export function useInvalidateTelegramBots() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['telegram-bots'] });
}

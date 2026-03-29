import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

const BASE = `${API_BASE}/api/reminders`;

export function useReminders() {
  return useQuery({
    queryKey: ['reminders'],
    queryFn: async () => {
      const res = await apiFetch(BASE);
      return res.json();
    },
    refetchInterval: 30_000,
  });
}

export function useCreateReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data) => {
      const res = await apiFetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error || 'Error');
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reminders'] }),
  });
}

export function useDeleteReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${BASE}/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reminders'] }),
  });
}

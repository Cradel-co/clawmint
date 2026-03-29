import { useQuery, useMutation } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

const BASE = `${API_BASE}/api/auth`;

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/me`);
      return res.json();
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) => {
      const res = await apiFetch(`${BASE}/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
  });
}

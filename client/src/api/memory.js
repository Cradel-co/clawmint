import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';

const BASE = `${API_BASE}/api/memory`;

export function useMemoryDebug(agentKey) {
  return useQuery({
    queryKey: ['memory-debug', agentKey],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/debug?agentKey=${encodeURIComponent(agentKey)}`);
      return res.json();
    },
    enabled: !!agentKey,
  });
}

export function useMemoryFiles(agentKey) {
  return useQuery({
    queryKey: ['memory-files', agentKey],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/${encodeURIComponent(agentKey)}`);
      return res.json();
    },
    enabled: !!agentKey,
  });
}

export function useMemorySearch(agentKey, q, tags) {
  return useQuery({
    queryKey: ['memory-search', agentKey, q, tags],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (tags) params.set('tags', tags);
      const res = await apiFetch(`${BASE}/${encodeURIComponent(agentKey)}/search?${params}`);
      return res.json();
    },
    enabled: !!agentKey && (!!q || !!tags),
  });
}

export function useMemoryFile(agentKey, filename) {
  return useQuery({
    queryKey: ['memory-file', agentKey, filename],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/${encodeURIComponent(agentKey)}/${encodeURIComponent(filename)}`);
      return res.json();
    },
    enabled: !!agentKey && !!filename,
  });
}

export function useSaveMemoryFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentKey, filename, content }) => {
      const res = await apiFetch(`${BASE}/${encodeURIComponent(agentKey)}/${encodeURIComponent(filename)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['memory-files', vars.agentKey] });
      qc.invalidateQueries({ queryKey: ['memory-file', vars.agentKey, vars.filename] });
    },
  });
}

export function useDeleteMemoryFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentKey, filename }) => {
      const res = await apiFetch(`${BASE}/${encodeURIComponent(agentKey)}/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['memory-files', vars.agentKey] });
      qc.invalidateQueries({ queryKey: ['memory-debug', vars.agentKey] });
    },
  });
}

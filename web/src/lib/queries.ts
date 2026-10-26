import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivityEntry,
  AppsDTO,
  AuthStatusDTO,
  Deploy,
  MonitoringStatus,
  NetworkDTO,
  Pm2Proc,
  PublicAccessDTO,
  QueryRangeDTO,
  SessionView,
  StateDTO,
  StatusDTO,
  SystemDTO,
  TunnelView,
  UserView,
} from '../../../src/shared/types';
import { get } from './api';

const visible = () => !document.hidden;

export const useAppState = () => useQuery({ queryKey: ['state'], queryFn: () => get<StateDTO>('/api/state') });
export const useStatus = () =>
  useQuery({ queryKey: ['status'], queryFn: () => get<StatusDTO>('/api/status'), refetchInterval: () => (visible() ? 15_000 : false) });
export const useApps = () =>
  useQuery({ queryKey: ['apps'], queryFn: () => get<AppsDTO>('/api/apps'), refetchInterval: () => (visible() ? 5000 : false) });
export const useSystem = () =>
  useQuery({ queryKey: ['system'], queryFn: () => get<SystemDTO>('/api/system'), refetchInterval: () => (visible() ? 10_000 : false) });
export const usePm2 = () =>
  useQuery({
    queryKey: ['pm2'],
    queryFn: () => get<{ list: Pm2Proc[]; error: string | null }>('/api/pm2'),
    refetchInterval: () => (visible() ? 10_000 : false),
  });
export const useSiteHealth = () =>
  useQuery({
    queryKey: ['health'],
    queryFn: () => get<Record<string, boolean>>('/api/sites/health'),
    refetchInterval: () => (visible() ? 15_000 : false),
  });
export const useTunnels = () =>
  useQuery({ queryKey: ['tunnels'], queryFn: () => get<{ tunnels: TunnelView[] }>('/api/tunnels'), retry: false });
export const useMonitoring = () =>
  useQuery({
    queryKey: ['monitoring'],
    queryFn: () => get<MonitoringStatus>('/api/monitoring'),
    refetchInterval: () => (visible() ? 15_000 : false),
  });
export const useLogs = () =>
  useQuery({
    queryKey: ['logs'],
    queryFn: () => get<{ logs: ActivityEntry[] }>('/api/logs'),
    refetchInterval: () => (visible() ? 5000 : false),
  });

export const useMetric = (preset: string, range: number, app?: string) =>
  useQuery({
    queryKey: ['metric', preset, range, app],
    queryFn: () =>
      get<QueryRangeDTO>(`/api/monitoring/query?preset=${preset}&range=${range}${app ? `&app=${encodeURIComponent(app)}` : ''}`),
    refetchInterval: () => (visible() ? 30_000 : false),
    placeholderData: (prev) => prev,
  });

export const useDeploys = (appId?: string) =>
  useQuery({
    queryKey: ['deploys', appId],
    queryFn: () => get<{ deploys: Deploy[] }>(`/api/deploys${appId ? `?app=${appId}` : ''}`),
    refetchInterval: () => (visible() ? 5000 : false),
  });

export interface CommitRow {
  sha: string;
  msg: string;
  author: string;
  date: string;
  deployedOk: boolean;
}
export const useCommits = (appId: string) =>
  useQuery({
    queryKey: ['commits', appId],
    queryFn: () => get<{ commits: CommitRow[]; current: string | null }>(`/api/apps/${appId}/commits`),
  });

export const useCaddyfile = () =>
  useQuery({ queryKey: ['caddyfile'], queryFn: () => get<{ generated: string; current: string | null; file: string }>('/api/caddyfile') });

/** Invalidate everything a config change can affect. */
export function useRefresh() {
  const qc = useQueryClient();
  return (...keys: string[]) =>
    Promise.all(
      (keys.length ? keys : ['state', 'status', 'apps', 'tunnels', 'pm2', 'health', 'system', 'monitoring', 'deploys', 'caddyfile']).map(
        (k) => qc.invalidateQueries({ queryKey: [k] }),
      ),
    );
}

export const useAuth = () =>
  useQuery({ queryKey: ['auth'], queryFn: () => get<AuthStatusDTO>('/api/auth/status'), retry: 2, staleTime: 30_000 });
export const useSessions = () => useQuery({ queryKey: ['auth', 'sessions'], queryFn: () => get<SessionView[]>('/api/auth/sessions') });
export const usePublicAccess = () => useQuery({ queryKey: ['auth', 'public'], queryFn: () => get<PublicAccessDTO>('/api/auth/public') });
export const useNetwork = () => useQuery({ queryKey: ['auth', 'network'], queryFn: () => get<NetworkDTO>('/api/auth/network') });
export const useUsers = () => useQuery({ queryKey: ['auth', 'users'], queryFn: () => get<UserView[]>('/api/auth/users') });

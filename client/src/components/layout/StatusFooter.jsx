import { useMemo } from 'react';
import { Cpu, MemoryStick, HardDrive, Clock, Wifi, WifiOff, Users, Bot, Radio } from 'lucide-react';
import { useSystemStats } from '../../hooks/useSystemStats';
import { useUIStore } from '../../stores/uiStore';
import styles from './StatusFooter.module.css';

function fmtBytes(bytes) {
  if (!bytes) return '0';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + 'G';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(0) + 'M';
  return (bytes / 1024).toFixed(0) + 'K';
}

function fmtUptime(s) {
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function barColor(pct) {
  if (pct >= 90) return 'error';
  if (pct >= 70) return 'warn';
  return 'ok';
}

export default function StatusFooter() {
  const { stats } = useSystemStats(5000);
  const wsConnected = useUIStore((s) => s.wsConnected);

  const cpu  = stats?.system?.cpu;
  const ram  = stats?.system?.ram;
  const disk = stats?.system?.disk;
  const up   = stats?.server?.uptime;
  const sessions = stats?.sessions?.pty ?? 0;
  const bots     = stats?.telegram?.running ?? 0;
  const nodriza  = stats?.nodriza;

  const cpuPct  = cpu?.percent ?? 0;
  const ramPct  = ram?.percent ?? 0;
  const diskPct = disk?.percent ?? 0;

  const cpuStatus  = useMemo(() => barColor(cpuPct),  [cpuPct]);
  const ramStatus  = useMemo(() => barColor(ramPct),  [ramPct]);
  const diskStatus = useMemo(() => barColor(diskPct), [diskPct]);

  return (
    <footer className={styles.footer} aria-label="Estado del sistema">
      <div className={`${styles.metric} ${styles[cpuStatus]}`} title={`CPU: ${cpuPct}% · ${cpu?.count || 0} cores · load ${cpu?.load?.[0]?.toFixed(1) || '—'}`}>
        <Cpu size={12} aria-hidden="true" />
        <span className={styles.label}>CPU</span>
        <span className={styles.value}>{cpuPct}%</span>
        <span className={styles.bar}><span className={styles.barFill} style={{ width: `${cpuPct}%` }} /></span>
      </div>

      <div className={`${styles.metric} ${styles[ramStatus]}`} title={`RAM: ${fmtBytes(ram?.used)} / ${fmtBytes(ram?.total)}`}>
        <MemoryStick size={12} aria-hidden="true" />
        <span className={styles.label}>RAM</span>
        <span className={styles.value}>{fmtBytes(ram?.used)}/{fmtBytes(ram?.total)}</span>
        <span className={styles.bar}><span className={styles.barFill} style={{ width: `${ramPct}%` }} /></span>
      </div>

      <div className={`${styles.metric} ${styles[diskStatus]}`} title={`Disco: ${diskPct}%`}>
        <HardDrive size={12} aria-hidden="true" />
        <span className={styles.label}>DISK</span>
        <span className={styles.value}>{diskPct}%</span>
        <span className={styles.bar}><span className={styles.barFill} style={{ width: `${diskPct}%` }} /></span>
      </div>

      <div className={styles.divider} aria-hidden="true" />

      <div className={styles.metricSimple} title="Uptime del servidor">
        <Clock size={12} aria-hidden="true" />
        <span className={styles.label}>UP</span>
        <span className={styles.value}>{fmtUptime(up)}</span>
      </div>

      <div className={styles.spacer} />

      <div className={styles.metricSimple} title={`${sessions} sesiones PTY activas`}>
        <Users size={12} aria-hidden="true" />
        <span className={styles.value}>{sessions}</span>
        <span className={styles.label}>sess</span>
      </div>

      {bots > 0 && (
        <div className={styles.metricSimple} title={`${bots} bots Telegram activos`}>
          <Bot size={12} aria-hidden="true" />
          <span className={styles.value}>{bots}</span>
          <span className={styles.label}>bots</span>
        </div>
      )}

      {nodriza?.enabled && (
        <div className={`${styles.metricSimple} ${nodriza.connected ? styles.ok : styles.error}`} title={`Nodriza: ${nodriza.connected ? 'conectada' : 'desconectada'} · ${nodriza.peers} peers`}>
          <Radio size={12} aria-hidden="true" />
          <span className={styles.label}>P2P</span>
          <span className={styles.value}>{nodriza.peers}</span>
        </div>
      )}

      <div className={`${styles.status} ${wsConnected ? styles.ok : styles.error}`} title={wsConnected ? 'WebSocket conectado' : 'WebSocket desconectado'}>
        {wsConnected ? <Wifi size={12} aria-hidden="true" /> : <WifiOff size={12} aria-hidden="true" />}
        <span>{wsConnected ? 'ONLINE' : 'OFFLINE'}</span>
      </div>
    </footer>
  );
}

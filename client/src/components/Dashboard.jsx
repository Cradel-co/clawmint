import { useEffect, useMemo, useState } from 'react';
import { Cpu, MemoryStick, HardDrive, Clock, Server, Wifi, Bot as BotIcon, Radio, Activity, Users, Zap, MapPin, Wind, Droplets } from 'lucide-react';
import { useSystemStats } from '../hooks/useSystemStats';
import { useWeather } from '../hooks/useWeather';
import { useUIStore } from '../stores/uiStore';
import { API_BASE } from '../config';
import { getStoredTokens } from '../authUtils';
import styles from './Dashboard.module.css';

const AGENT_COLORS = [
  '#f97316', // orange
  '#fbbf24', // cyan
  '#a855f7', // purple
  '#10b981', // green
  '#ec4899', // pink
  '#fb923c', // blue
  '#f59e0b', // yellow
  '#14b8a6', // teal
];

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function fmtUptime(s) {
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function barColor(pct) {
  if (pct >= 90) return 'error';
  if (pct >= 70) return 'warn';
  return 'ok';
}

function MetricTile({ icon: Icon, label, value, subtitle, percent, status = 'ok', accent = 'orange' }) {
  return (
    <article className={`${styles.metricTile} ${styles[`accent-${accent}`]}`}>
      <header className={styles.metricHeader}>
        <span className={styles.metricIcon}><Icon size={16} aria-hidden="true" /></span>
        <span className={styles.metricLabel}>{label}</span>
      </header>
      <div className={styles.metricValue}>
        {value}
        {percent !== undefined && <span className={styles.metricPercent}>{percent}%</span>}
      </div>
      {subtitle && <div className={styles.metricSubtitle}>{subtitle}</div>}
      {percent !== undefined && (
        <div className={`${styles.progress} ${styles[status]}`}>
          <span className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
      )}
    </article>
  );
}

function StatusCard({ label, value, subtitle, accent = 'orange', icon: Icon }) {
  return (
    <article className={`${styles.statusCard} ${styles[`accent-${accent}`]}`}>
      <div className={styles.statusCardHeader}>
        {Icon && <Icon size={14} aria-hidden="true" />}
        <span>{label}</span>
      </div>
      <div className={styles.statusCardValue}>{value}</div>
      {subtitle && <div className={styles.statusCardSub}>{subtitle}</div>}
    </article>
  );
}

function WeatherWidget() {
  const { data, error, loading, coords, weatherMeta } = useWeather();
  const current = data?.current_weather;
  const daily = data?.daily;
  const today = current ? weatherMeta(current.weathercode) : null;

  return (
    <aside className={styles.weatherCard}>
      <header className={styles.weatherHead}>
        <span className={styles.weatherLocation}>
          <MapPin size={12} aria-hidden="true" />
          {coords?.name || (coords ? `${coords.latitude.toFixed(2)}, ${coords.longitude.toFixed(2)}` : '—')}
        </span>
        <span className={styles.weatherNow}>
          {new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>
      {loading && <div className={styles.weatherLoading}>Obteniendo clima…</div>}
      {error && !current && <div className={styles.weatherError}>Sin datos de clima</div>}
      {current && (
        <>
          <div className={styles.weatherMain}>
            <div className={styles.weatherIcon} aria-hidden="true">{today?.icon}</div>
            <div>
              <div className={styles.weatherTemp}>{Math.round(current.temperature)}°</div>
              <div className={styles.weatherDesc}>{today?.label}</div>
            </div>
          </div>
          <div className={styles.weatherStats}>
            <span title="Viento"><Wind size={11} /> {Math.round(current.windspeed)} km/h</span>
            {daily?.precipitation_probability_max?.[0] !== undefined && (
              <span title="Probabilidad de lluvia"><Droplets size={11} /> {daily.precipitation_probability_max[0]}%</span>
            )}
          </div>
          {daily && (
            <div className={styles.weatherForecast}>
              {daily.time?.slice(1, 4).map((date, i) => {
                const code = daily.weathercode?.[i + 1];
                const meta = weatherMeta(code);
                const d = new Date(date);
                const dayLabel = d.toLocaleDateString('es-ES', { weekday: 'short' });
                return (
                  <div key={date} className={styles.forecastDay}>
                    <span className={styles.forecastLabel}>{dayLabel}</span>
                    <span className={styles.forecastIcon}>{meta.icon}</span>
                    <span className={styles.forecastTemp}>
                      {Math.round(daily.temperature_2m_max?.[i + 1])}°
                      <span className={styles.forecastMin}> / {Math.round(daily.temperature_2m_min?.[i + 1])}°</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

export default function Dashboard() {
  const { stats, loading, error } = useSystemStats(3000);
  const setSection = useUIStore((s) => s.setSection);
  const [agents, setAgents] = useState([]);

  useEffect(() => {
    const token = getStoredTokens()?.accessToken;
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/agents`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setAgents(Array.isArray(data) ? data : (data.agents || []));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const cpu  = stats?.system?.cpu;
  const ram  = stats?.system?.ram;
  const disk = stats?.system?.disk;
  const host = stats?.system?.host;
  const srv  = stats?.server;
  const tg   = stats?.telegram;
  const nodz = stats?.nodriza;
  const sess = stats?.sessions;
  const prov = stats?.providers;
  const ws   = stats?.ws;

  const cpuPct  = cpu?.percent  ?? 0;
  const ramPct  = ram?.percent  ?? 0;
  const diskPct = disk?.percent ?? 0;

  const totalsSubtitle = useMemo(() => {
    if (!host) return '—';
    return `${host.platform} · ${host.arch} · node ${host.node}`;
  }, [host]);

  return (
    <div className={styles.dashboard}>
      <header className={styles.hero}>
        <div>
          <h1 className={styles.title}>
            <span className={styles.titleMark} aria-hidden="true" />
            Mission Control
          </h1>
          <p className={styles.subtitle}>
            {host?.hostname ? `${host.hostname} — ` : ''}
            Estado del servidor Clawmint y agentes en vivo
          </p>
        </div>
        <div className={styles.heroStats}>
          <span className={styles.heroStat}>
            <Clock size={13} aria-hidden="true" /> UPTIME {fmtUptime(srv?.uptime)}
          </span>
          <span className={`${styles.heroStat} ${error ? styles.heroStatError : ''}`}>
            <Activity size={13} aria-hidden="true" /> {error ? 'OFFLINE' : loading ? 'SYNC…' : 'LIVE'}
          </span>
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert">
          <strong>No se pueden leer las métricas del servidor.</strong>
          <span>
            {error.message.includes('404')
              ? ' El endpoint /api/system/stats no existe — reiniciá el server (cd server && npm run dev).'
              : error.message.includes('401') || error.message.includes('403')
              ? ' Sesión expirada o sin permisos. Cerrá y volvé a entrar.'
              : ` Error: ${error.message}`}
          </span>
        </div>
      )}

      <div className={styles.primaryRow}>
        <section className={styles.metricGrid} aria-label="Métricas del sistema">
          <MetricTile
            icon={Cpu}
            label="CPU"
            accent="orange"
            value={cpu ? `${cpuPct}%` : '—'}
            subtitle={cpu ? `${cpu.count} cores · load ${cpu.load?.[0]?.toFixed(1) || '—'}` : ''}
            percent={cpuPct}
            status={barColor(cpuPct)}
          />
          <MetricTile
            icon={MemoryStick}
            label="Memoria"
            accent="cyan"
            value={ram ? fmtBytes(ram.used) : '—'}
            subtitle={ram ? `de ${fmtBytes(ram.total)} totales` : ''}
            percent={ramPct}
            status={barColor(ramPct)}
          />
          <MetricTile
            icon={HardDrive}
            label="Disco"
            accent="purple"
            value={disk?.total ? fmtBytes(disk.used) : '—'}
            subtitle={disk?.total ? `de ${fmtBytes(disk.total)} disponibles` : 'N/A'}
            percent={diskPct}
            status={barColor(diskPct)}
          />
          <MetricTile
            icon={Server}
            label="Servidor"
            accent="green"
            value={fmtUptime(srv?.uptime)}
            subtitle={totalsSubtitle}
          />
        </section>
        <WeatherWidget />
      </div>

      <section className={styles.statusGrid} aria-label="Estado del servidor">
        <StatusCard
          label="WebSocket"
          icon={Wifi}
          accent="cyan"
          value={ws?.clients ?? 0}
          subtitle="clientes conectados"
        />
        <StatusCard
          label="Sesiones PTY"
          icon={Users}
          accent="orange"
          value={sess?.pty ?? 0}
          subtitle={`${sess?.web ?? 0} webchat activas`}
        />
        <StatusCard
          label="Telegram"
          icon={BotIcon}
          accent="blue"
          value={`${tg?.running ?? 0}/${tg?.total ?? 0}`}
          subtitle="bots activos"
        />
        <StatusCard
          label="Providers IA"
          icon={Zap}
          accent="yellow"
          value={prov?.total ?? 0}
          subtitle={prov?.names?.slice(0, 3).join(' · ') || '—'}
        />
        {nodz?.enabled && (
          <StatusCard
            label="P2P Nodriza"
            icon={Radio}
            accent={nodz.connected ? 'green' : 'red'}
            value={nodz.peers ?? 0}
            subtitle={nodz.connected ? 'conectada · peers' : 'desconectada'}
          />
        )}
      </section>

      <section className={styles.agentsSection} aria-label="Agentes">
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.sectionTitleMark} aria-hidden="true" />
            Multi-Agent System
          </h2>
          <button className={styles.sectionLink} onClick={() => setSection('config', { configTab: 'agents' })}>
            Gestionar agentes →
          </button>
        </header>

        {agents.length === 0 ? (
          <div className={styles.agentsEmpty}>
            Sin agentes configurados. <button className={styles.linkBtn} onClick={() => setSection('config', { configTab: 'agents' })}>Crear agente</button>
          </div>
        ) : (
          <div className={styles.agentsGrid}>
            {agents.slice(0, 8).map((a, i) => {
              const color = AGENT_COLORS[i % AGENT_COLORS.length];
              const initial = (a.name || a.key || '?')[0]?.toUpperCase();
              return (
                <article
                  key={a.key || a.id || i}
                  className={styles.agentCard}
                  style={{ '--agent-color': color }}
                  onClick={() => setSection('chat')}
                >
                  <div className={styles.agentIcon}>{initial}</div>
                  <div className={styles.agentName}>{a.name || a.key}</div>
                  <div className={styles.agentModel}>{a.model || a.provider || 'sin modelo'}</div>
                  <div className={styles.agentStatus}>
                    <span className={styles.agentDot} /> Connected
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

'use strict';

const os = require('os');
const { execSync } = require('child_process');

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(0)   + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

/**
 * Retorna estadísticas del sistema (CPU, RAM, disco, uptime).
 * Cross-platform: Windows y Linux.
 * @returns {{ cpu: string, ram: string, disk: string, uptime: string }}
 */
function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const memPct   = Math.round((usedMem / totalMem) * 100);
  const [l1, l5, l15] = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct   = Math.min(100, Math.round((l1 / cpuCount) * 100));
  const uptimeSecs = os.uptime();
  const days  = Math.floor(uptimeSecs / 86400);
  const hours = Math.floor((uptimeSecs % 86400) / 3600);
  const mins  = Math.floor((uptimeSecs % 3600) / 60);

  let disk = 'N/A';
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /format:csv', { encoding: 'utf8', timeout: 3000 });
      const parts = out.trim().split('\n').pop()?.split(',');
      if (parts && parts.length >= 3) {
        const free = parseInt(parts[1], 10), total = parseInt(parts[2], 10);
        const used = total - free;
        const fmt = (b) => (b / (1024 ** 3)).toFixed(1) + 'G';
        disk = `${fmt(used)} / ${fmt(total)} (${Math.round((used / total) * 100)}%)`;
      }
    } else {
      const df  = execSync('df -h /', { encoding: 'utf8', timeout: 3000 });
      const row = df.trim().split('\n')[1]?.split(/\s+/);
      if (row) disk = `${row[2]} / ${row[1]} (${row[4]})`;
    }
  } catch {}

  return {
    cpu:    `${cpuPct}% (load: ${l1.toFixed(1)}, ${l5.toFixed(1)}, ${l15.toFixed(1)})`,
    ram:    `${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPct}%)`,
    disk,
    uptime: `${days}d ${hours}h ${mins}m`,
  };
}

module.exports = { getSystemStats, formatBytes };

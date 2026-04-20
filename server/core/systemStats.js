'use strict';

const os = require('os');
const fs = require('fs');

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(0)   + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function getDiskRaw() {
  try {
    const target = process.platform === 'win32' ? 'C:\\' : '/';
    const s = fs.statfsSync(target);
    const bsize = Number(s.bsize);
    const total = Number(s.blocks) * bsize;
    const free  = Number(s.bfree)  * bsize;
    return { total, free, used: total - free };
  } catch {}
  return null;
}

/**
 * Retorna estadísticas del sistema (strings pre-formateados).
 * Cross-platform: Windows y Linux. Usado por comandos de Telegram.
 */
function getSystemStats() {
  const d = getSystemStatsDetailed();
  const diskStr = d.disk.total
    ? `${formatBytes(d.disk.used)} / ${formatBytes(d.disk.total)} (${d.disk.percent}%)`
    : 'N/A';
  return {
    cpu:    `${d.cpu.percent}% (load: ${d.cpu.load[0].toFixed(1)}, ${d.cpu.load[1].toFixed(1)}, ${d.cpu.load[2].toFixed(1)})`,
    ram:    `${formatBytes(d.ram.used)} / ${formatBytes(d.ram.total)} (${d.ram.percent}%)`,
    disk:   diskStr,
    uptime: `${d.uptime.days}d ${d.uptime.hours}h ${d.uptime.minutes}m`,
  };
}

/**
 * Retorna estadísticas detalladas (estructura numérica) para el dashboard del cliente.
 * @returns {{ cpu: {percent, count, load:[number,number,number]}, ram: {used,total,free,percent}, disk: {used,total,free,percent}, uptime: {seconds,days,hours,minutes}, host: {platform,arch,hostname,node} }}
 */
function getSystemStatsDetailed() {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const memPct   = Math.round((usedMem / totalMem) * 100);
  const load     = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct   = Math.min(100, Math.round((load[0] / cpuCount) * 100));

  const uptimeSecs = Math.floor(os.uptime());
  const days    = Math.floor(uptimeSecs / 86400);
  const hours   = Math.floor((uptimeSecs % 86400) / 3600);
  const minutes = Math.floor((uptimeSecs % 3600) / 60);

  const diskRaw = getDiskRaw();
  const disk = diskRaw
    ? { ...diskRaw, percent: Math.round((diskRaw.used / diskRaw.total) * 100) }
    : { used: 0, total: 0, free: 0, percent: 0 };

  return {
    cpu: { percent: cpuPct, count: cpuCount, load },
    ram: { used: usedMem, total: totalMem, free: freeMem, percent: memPct },
    disk,
    uptime: { seconds: uptimeSecs, days, hours, minutes },
    host: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      node: process.version,
    },
  };
}

module.exports = { getSystemStats, getSystemStatsDetailed, formatBytes };

'use strict';

const os = require('os');
const https = require('https');

/**
 * LocationService — agrega información de ubicación/red del server.
 *
 * Combina 4 fuentes:
 *   1. LAN local — `os.networkInterfaces()` filtrando IPv4 no internas.
 *   2. Tailscale — IPs en el rango 100.64.0.0/10 (CGNAT, usado por TS).
 *   3. IP pública + geo — fetch a ip-api.com (free, sin key, JSON).
 *      Cache 24h para no abusar (free tier: 45 req/min).
 *   4. Override manual — coords lat/lon ingresadas por admin via UI,
 *      persistidas en SystemConfigRepository.
 *
 * No spawnea procesos — usa solo APIs nativas de Node + un fetch HTTP.
 */
class LocationService {
  /**
   * @param {object} deps
   * @param {object} [deps.systemConfigRepo] — para leer overrides manuales
   * @param {object} [deps.logger]
   * @param {number} [deps.publicIpTtlMs] — TTL del cache de IP pública (default 24h)
   */
  constructor({ systemConfigRepo = null, logger = console, publicIpTtlMs = 24 * 60 * 60 * 1000 } = {}) {
    this._configRepo = systemConfigRepo;
    this._logger = logger;
    this._publicIpTtl = publicIpTtlMs;
    this._publicIpCache = null; // { data, fetchedAt }
    this._publicIpInflight = null; // promesa en vuelo, evita stampede
  }

  /** IPs LAN locales (excluye loopback + IPv6 link-local). */
  getLanInterfaces() {
    const ifaces = os.networkInterfaces();
    const out = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.internal) continue;
        if (addr.family !== 'IPv4' && addr.family !== 4) continue;
        out.push({
          interface: name,
          address: addr.address,
          netmask: addr.netmask,
          mac: addr.mac,
          isTailscale: this._isTailscaleIp(addr.address),
        });
      }
    }
    return out;
  }

  /** Tailscale IPs específicamente (subset de las LAN). */
  getTailscaleInterfaces() {
    return this.getLanInterfaces().filter(i => i.isTailscale);
  }

  _isTailscaleIp(ip) {
    // Tailscale usa CGNAT range 100.64.0.0/10 → 100.64.* a 100.127.*
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    if (parts[0] !== '100') return false;
    const second = parseInt(parts[1], 10);
    return second >= 64 && second <= 127;
  }

  /**
   * IP pública + geolocalización aproximada.
   * Cache 24h (free tier de ip-api: 45 req/min, no necesitamos refrescar tan seguido).
   * Si force=true bypasea cache.
   */
  async getPublicGeo(force = false) {
    const now = Date.now();
    if (!force && this._publicIpCache && (now - this._publicIpCache.fetchedAt) < this._publicIpTtl) {
      return this._publicIpCache.data;
    }
    if (this._publicIpInflight) return this._publicIpInflight;
    this._publicIpInflight = (async () => {
      try {
        const data = await this._fetchPublicGeo();
        this._publicIpCache = { data, fetchedAt: Date.now() };
        return data;
      } catch (err) {
        this._logger.warn?.(`[LocationService] no pude obtener IP pública: ${err.message}`);
        // Si falla pero hay cache viejo, devolverlo. Si no, null.
        return this._publicIpCache?.data || null;
      } finally {
        this._publicIpInflight = null;
      }
    })();
    return this._publicIpInflight;
  }

  _fetchPublicGeo() {
    // ipwho.is — free, sin API key, soporta HTTPS, ~10k req/mes anónimas.
    return new Promise((resolve, reject) => {
      const req = https.get('https://ipwho.is/?fields=ip,success,message,country,country_code,region,city,postal,latitude,longitude,timezone', (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.success === false) return reject(new Error(json.message || 'ipwho.is error'));
            resolve({
              ip:          json.ip,
              country:     json.country,
              countryCode: json.country_code,
              region:      json.region,
              city:        json.city,
              zip:         json.postal,
              latitude:    json.latitude,
              longitude:   json.longitude,
              timezone:    json.timezone?.id || json.timezone,
              source:      'ipwho.is',
            });
          } catch (e) { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  /** Override manual (admin lo setea via UI). null si no hay. */
  getManualLocation() {
    if (!this._configRepo) return null;
    try {
      const lat  = this._configRepo.get('location:manual:latitude');
      const lon  = this._configRepo.get('location:manual:longitude');
      const name = this._configRepo.get('location:manual:name');
      if (lat == null || lon == null) return null;
      return {
        latitude:  Number(lat),
        longitude: Number(lon),
        name:      name || null,
        source:    'manual',
      };
    } catch { return null; }
  }

  /** Guarda override manual. Pasar null para limpiar. */
  setManualLocation({ latitude, longitude, name } = {}) {
    if (!this._configRepo) throw new Error('SystemConfigRepository no disponible');
    if (latitude == null || longitude == null) {
      this._configRepo.remove('location:manual:latitude');
      this._configRepo.remove('location:manual:longitude');
      this._configRepo.remove('location:manual:name');
      return null;
    }
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('latitude/longitude inválidas');
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error('coords fuera de rango');
    this._configRepo.set('location:manual:latitude',  String(lat));
    this._configRepo.set('location:manual:longitude', String(lon));
    if (name) this._configRepo.set('location:manual:name', String(name));
    return this.getManualLocation();
  }

  /**
   * Snapshot completo. Combina las 4 fuentes.
   * @param {object} opts
   * @param {boolean} [opts.includePublic] — si true intenta fetch público (default true)
   * @param {boolean} [opts.forcePublic]   — si true bypasea cache
   */
  async getLocation({ includePublic = true, forcePublic = false } = {}) {
    const lan = this.getLanInterfaces();
    const tailscale = lan.filter(i => i.isTailscale);
    const lanOnly = lan.filter(i => !i.isTailscale);

    let publicGeo = null;
    if (includePublic) {
      try { publicGeo = await this.getPublicGeo(forcePublic); } catch { publicGeo = null; }
    }

    const manual = this.getManualLocation();

    // Resolved = la coord "preferida" para usar (manual gana, sino public, sino null).
    let resolved = null;
    if (manual) resolved = { ...manual, preferred: 'manual' };
    else if (publicGeo) resolved = {
      latitude: publicGeo.latitude,
      longitude: publicGeo.longitude,
      name: publicGeo.city ? `${publicGeo.city}, ${publicGeo.country || ''}`.trim().replace(/,$/, '') : null,
      preferred: 'public-ip',
    };

    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch:     process.arch,
      lan:       lanOnly,
      tailscale,
      public:    publicGeo,
      manual,
      resolved,
      timestamp: Date.now(),
    };
  }
}

module.exports = LocationService;

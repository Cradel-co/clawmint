'use strict';

/**
 * rateLimiter — rate limiting in-memory por IP.
 *
 * @param {number} maxAttempts — intentos máximos por ventana.
 * @param {number} windowMs — ventana de tiempo en ms.
 */
function rateLimiter(maxAttempts, windowMs) {
  const attempts = new Map(); // ip -> [timestamps]

  // Limpiar entradas viejas cada 5 minutos
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of attempts) {
      const filtered = times.filter(t => t > cutoff);
      if (filtered.length === 0) attempts.delete(ip);
      else attempts.set(ip, filtered);
    }
  }, 5 * 60 * 1000).unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    const cutoff = now - windowMs;

    let times = attempts.get(ip) || [];
    times = times.filter(t => t > cutoff);

    if (times.length >= maxAttempts) {
      const retryAfter = Math.ceil((times[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Demasiados intentos. Intente de nuevo más tarde.',
        retryAfter,
      });
    }

    times.push(now);
    attempts.set(ip, times);
    next();
  };
}

module.exports = rateLimiter;

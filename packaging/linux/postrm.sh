#!/bin/sh
# postrm.sh — corre después de `dpkg -r` o `dpkg --purge`.
# Con --purge: borrar user + dir de datos (irreversible).
# Con -r solo: mantiene datos para reinstall.
set -e

case "$1" in
  purge)
    echo "[clawmint] purge: removiendo user, group y datos..."
    if id -u clawmint >/dev/null 2>&1; then
      deluser --system clawmint || true
    fi
    if getent group clawmint >/dev/null 2>&1; then
      delgroup --system clawmint || true
    fi
    rm -rf /var/lib/clawmint || true
    ;;
  remove|upgrade|failed-upgrade|abort-install|abort-upgrade|disappear)
    ;;
esac

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi

exit 0

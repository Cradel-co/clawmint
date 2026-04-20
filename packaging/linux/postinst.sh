#!/bin/sh
# postinst.sh — corre después de `dpkg -i clawmint*.deb`.
# Crea el user de sistema, ajusta permisos y habilita el service.
set -e

# 1. Crear user + group de sistema (no login shell, sin home)
if ! getent group clawmint >/dev/null 2>&1; then
  addgroup --system clawmint
fi
if ! id -u clawmint >/dev/null 2>&1; then
  adduser --system --ingroup clawmint --no-create-home --home /var/lib/clawmint \
          --shell /usr/sbin/nologin clawmint
fi

# 2. Dir de datos
mkdir -p /var/lib/clawmint/config /var/lib/clawmint/data /var/lib/clawmint/data/memory \
         /var/lib/clawmint/logs /var/lib/clawmint/models /var/lib/clawmint/mcps
chown -R clawmint:clawmint /var/lib/clawmint
chmod 750 /var/lib/clawmint

# 3. Permiso exec del node runtime y server entry
chmod 755 /opt/clawmint/resources/node || true
chmod 644 /opt/clawmint/resources/server/index.js || true

# 4. Habilitar + arrancar el service
systemctl daemon-reload
systemctl enable clawmint.service
systemctl start clawmint.service || echo "[clawmint] primer start falló — revisar con 'systemctl status clawmint'"

echo "[clawmint] instalado. Abrí el panel en http://localhost:3001 o desde el menú de apps."
exit 0

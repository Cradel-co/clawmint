#!/bin/sh
# prerm.sh — corre antes de `dpkg -r clawmint`. Detiene y desactiva el service.
# Por default NO borra /var/lib/clawmint (datos del user); el paquete .deb con
# `dpkg --purge` es el que invoca postrm.sh para borrado completo.
set -e

if command -v systemctl >/dev/null 2>&1; then
  systemctl stop clawmint.service || true
  systemctl disable clawmint.service || true
fi

exit 0

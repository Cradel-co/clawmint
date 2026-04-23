# Linux packaging

Dos tipos de distribución soportados:

| Tipo | Install | Datos | Service |
|---|---|---|---|
| `.deb` | `sudo dpkg -i clawmint*.deb` | `/var/lib/clawmint/` (systemd) | systemd system unit (`clawmint.service`) |
| `.AppImage` | `chmod +x && ./clawmint.AppImage` | `~/.config/clawmint/` (XDG) | no — corre mientras tenés el AppImage abierto |

El **.deb** instala como service system-wide con user dedicado `clawmint` (más seguro, pero requiere sudo).

El **.AppImage** es portable y corre como el user actual — ideal para probar sin instalar.

## Build

```bash
# Host: Ubuntu 22.04 recomendado (glibc compat con mayoría de distros)
node packaging/build/bundle-server.js --target=linux-x64
cd packaging/tauri
cargo tauri build --target x86_64-unknown-linux-gnu
# Output:
#   packaging/tauri/target/release/bundle/deb/clawmint_<v>_amd64.deb
#   packaging/tauri/target/release/bundle/appimage/clawmint_<v>_amd64.AppImage
```

## Scripts `.deb`

- `postinst.sh` — corre en instalación: crea user `clawmint`, dir `/var/lib/clawmint`, habilita service.
- `prerm.sh` — corre antes de remove: detiene y desactiva service.
- `postrm.sh` — con `--purge` borra user, group, datos.

Estos se referencian desde `tauri.conf.json` via `bundle.linux.deb.files` y
`postInstallScript` / `preRemoveScript` cuando Tauri los soporte, o se pueden
aplicar manualmente post-build.

## Verificar service

```bash
systemctl status clawmint
systemctl start clawmint
journalctl -u clawmint -f    # logs en vivo
```

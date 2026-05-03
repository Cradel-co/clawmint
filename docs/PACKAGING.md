# Packaging Clawmint — instalables desktop

Guía para mantenedores que quieren buildear `.exe` (Windows) y `.AppImage`/`.deb` (Linux) de Clawmint.

## Arquitectura en 30 segundos

```
packaging/
├── tauri/              ← shell Rust (Tauri v2) que spawnea Node como sidecar
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/main.rs
│   └── resources/      ← generado por bundle-server.js (no commitear)
│       ├── node[.exe]  ← runtime Node copiado del host
│       ├── server/     ← código del server + node_modules production
│       ├── client/dist ← React build
│       └── nssm.exe    ← solo Windows
├── build/
│   └── bundle-server.js  ← pre-build: builda client, copia server, instala deps, copia node
├── windows/
│   ├── installer.nsi   ← template NSIS custom (registra Windows Service)
│   ├── nssm.exe        ← SERVICE MANAGER (descargar de https://nssm.cc, NO commiteado)
│   └── README.md
└── linux/
    ├── clawmint.service  ← systemd unit
    ├── postinst.sh, prerm.sh, postrm.sh
    ├── AppRun            ← entrypoint del .AppImage (portable)
    └── README.md
```

El **Tauri shell** es una ventana nativa que:
1. Al arrancar, spawnea `node server/index.js` con env `CLAWMINT_DATA_DIR`.
2. Poll `http://localhost:3001/api/health` hasta que responda (timeout 30s).
3. Carga la URL en un webview del OS (WebView2 Windows / WebKitGTK Linux).
4. Tray icon con menú (Abrir panel, Ver logs, Salir).

Si el usuario instaló Clawmint vía `.exe` o `.deb`, el installer ya registró el **service del OS** (Windows Service con NSSM / systemd unit). En ese caso el Tauri shell NO spawnea su propio sidecar — detecta que el puerto 3001 ya responde y solo se conecta al service existente.

## Pre-requisitos (una vez)

### Común

- **Node 22** en el host (se copia el binary al bundle).
- **Rust** (`rustup`, https://rustup.rs) — toolchain estable.
- **Tauri CLI v2**: `cargo install tauri-cli --version "^2.0"`.

### Windows-only

- Visual Studio Build Tools 2022 o superior (para compilar deps nativas como `node-pty`, `sharp`, `node-datachannel`).
- **NSSM 2.24** descargado manualmente a `packaging/windows/nssm.exe` (https://nssm.cc/download, usar `win64/nssm.exe` del zip).
  - NO se distribuye en el repo por tamaño; agregar a `.gitignore`.

### Linux-only

- `build-essential`, `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.
- Para rebuild de native deps: `libvips-dev` (sharp), `pkg-config`.
- Para `.AppImage`: `appimagetool` (Tauri lo descarga automático).

## Build v1 (manual, CI parked)

### Windows

Desde un host Windows 10/11:

```powershell
# 1. Bundle server + client + node
node packaging/build/bundle-server.js --target=win32-x64

# 2. Build Tauri
cd packaging/tauri
cargo tauri build --target x86_64-pc-windows-msvc
```

Output:
```
packaging/tauri/target/release/bundle/nsis/Clawmint_<v>_x64-setup.exe
```

El `.exe` incluye el instalador NSIS custom (`packaging/windows/installer.nsi`).

### Linux

Desde Ubuntu 22.04 (para glibc compat amplio):

```bash
node packaging/build/bundle-server.js --target=linux-x64
cd packaging/tauri
cargo tauri build --target x86_64-unknown-linux-gnu
```

Output:
```
packaging/tauri/target/release/bundle/deb/clawmint_<v>_amd64.deb
packaging/tauri/target/release/bundle/appimage/clawmint_<v>_amd64.AppImage
```

## Auto-update (Tauri updater)

### Setup inicial (una sola vez)

```bash
# Generar key pair ed25519
cargo tauri signer generate -w ~/.tauri/clawmint.key
# → imprime PUBLIC KEY (pegá en tauri.conf.json → plugins.updater.pubkey)
# → guardá la private key en GitHub Secrets como TAURI_PRIVATE_KEY
```

### En cada release

Después de buildear los instaladores:

```bash
# Firmar cada artifact
cargo tauri signer sign \
  --private-key "$TAURI_PRIVATE_KEY" \
  packaging/tauri/target/release/bundle/nsis/Clawmint_1.0.1_x64-setup.exe \
  > signatures/windows.sig

cargo tauri signer sign \
  --private-key "$TAURI_PRIVATE_KEY" \
  packaging/tauri/target/release/bundle/appimage/clawmint_1.0.1_amd64.AppImage \
  > signatures/linux.sig
```

Y publicar un `latest.json` en GitHub Releases con este shape:

```json
{
  "version": "1.0.1",
  "notes": "Fix scheduler regression + add schedule_wakeup persistence",
  "pub_date": "2026-04-20T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contenido de signatures/windows.sig>",
      "url": "https://github.com/bpadilla/clawmint/releases/download/v1.0.1/Clawmint_1.0.1_x64-setup.exe"
    },
    "linux-x86_64": {
      "signature": "<contenido de signatures/linux.sig>",
      "url": "https://github.com/bpadilla/clawmint/releases/download/v1.0.1/clawmint_1.0.1_amd64.AppImage"
    }
  }
}
```

El app instalado revisa `https://github.com/bpadilla/clawmint/releases/latest/download/latest.json` cada 24h; si hay una versión mayor firmada con el key correspondiente, descarga + instala + reinicia.

## Smoke test del instalador

### Windows

1. VM Windows 10 limpia, sin Node instalado.
2. Ejecutar `Clawmint_<v>_x64-setup.exe`. Verificar:
   - Pantalla welcome con EULA aparece.
   - Se instala en `C:\Program Files\Clawmint\`.
   - Se crea `C:\ProgramData\Clawmint\{config,data,logs,models,mcps}` con permisos LocalService.
   - `services.msc` muestra **Clawmint Agent Service** en estado "Running".
3. Abrir la ventana Tauri (se lanza automáticamente post-install).
4. Completar WelcomeWizard: crear admin, agregar API key Anthropic, (opcional) agregar bot Telegram.
5. Cerrar ventana → verificar que el service sigue corriendo (`curl http://localhost:3001/api/health` responde).
6. Reiniciar Windows → el service arranca solo al boot (antes de login).
7. Uninstall desde "Agregar o quitar programas" → prompt "¿borrar datos?", aceptar NO por default.

### Linux (.deb)

1. VM Ubuntu 22.04 limpia.
2. `sudo dpkg -i clawmint_<v>_amd64.deb`.
3. Verificar:
   ```bash
   getent passwd clawmint          # user creado
   systemctl status clawmint        # service activo
   curl http://localhost:3001/api/health
   ls /var/lib/clawmint/config/     # dir creado con owner clawmint:clawmint
   ```
4. Abrir `clawmint` desde el menú de apps → Tauri shell se conecta al service ya corriendo.
5. `sudo dpkg -r clawmint` → service se detiene; datos permanecen.
6. `sudo dpkg --purge clawmint` → datos y user borrados.

### Linux (.AppImage)

1. `chmod +x clawmint_<v>_amd64.AppImage && ./clawmint_...`.
2. Verificar que:
   - Datos van a `~/.config/clawmint/`.
   - NO hay service system-wide.
   - Al cerrar el AppImage, el server se corta (no hay daemon).

## Decisiones parked v1

- **macOS** (`.dmg`/`.app`): agregar target a `tauri.conf.json`. Requiere Apple Developer cert ($99/año) para notarization y evitar Gatekeeper. No cubierto en v1.
- **GitHub Actions CI**: workflow con matrix `{windows-latest, ubuntu-22.04}` que buildea en tag push y publica Release con artefactos firmados. En v1 los builds son manuales.
- **Code signing Windows** (cert EV ~$300/año): sin esto, SmartScreen warning. v1 parked.
- **ARM64** (Windows ARM + Raspberry Pi): requiere rebuild de nativos por arch. v1 parked.
- **Cross-compile** (ej. buildear Linux desde Windows): complejo con deps nativas. Mejor buildear en el OS target.

## Troubleshooting

### "Failed to spawn sidecar: node"
El instalador no copió bien `resources/node[.exe]`. Re-correr `bundle-server.js`.

### Windows service en "Paused" estado
Revisar `C:\ProgramData\Clawmint\logs\service.err.log`. Común: permisos mal (LocalService no puede escribir `%PROGRAMDATA%\Clawmint`). Fix con:
```powershell
icacls "C:\ProgramData\Clawmint" /grant "NT AUTHORITY\LocalService":(OI)(CI)M /T
```

### `sharp` o `node-pty` errors al arrancar el service
Rebuild de nativos no funcionó contra el target arch. Re-correr `npm rebuild sharp node-pty node-datachannel` dentro de `packaging/tauri/resources/server/` en el OS correcto.

### AppImage "cannot find libwebkit2gtk-4.1"
En distros muy viejas o muy nuevas la lib puede llamarse distinto (4.0 vs 4.1).
Actualizar el host de build a Ubuntu 22.04 o usar `linuxdeploy` para bundlear libs.

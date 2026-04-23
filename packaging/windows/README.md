# Windows packaging

## NSSM (service manager)

Necesitás descargar `nssm.exe` 2.24 y copiarlo acá como `nssm.exe` antes de buildear.

Download: https://nssm.cc/download (usar `win64/nssm.exe` de `nssm-2.24.zip`)

El script `packaging/build/bundle-server.js` lo copia automáticamente a
`resources/nssm.exe` si existe en esta carpeta.

## Build

```powershell
# En Windows host con Rust + Node instalados:
node packaging/build/bundle-server.js --target=win32-x64
cd packaging/tauri
cargo tauri build --target x86_64-pc-windows-msvc
# Output: packaging/tauri/target/release/bundle/nsis/Clawmint_<version>_x64-setup.exe
```

## Code signing (opcional, v1 skipped)

Sin firma, SmartScreen muestra "Windows protegió su PC" al primer user. Aceptar
con "Más información → Ejecutar de todos modos". Para firmar:

```powershell
# Con cert Authenticode en un .pfx:
signtool sign /f cert.pfx /p <password> /tr http://timestamp.digicert.com /td sha256 /fd sha256 \
  packaging/tauri/target/release/bundle/nsis/Clawmint_*_x64-setup.exe
```

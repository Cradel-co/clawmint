# Instalador multiplataforma con pkg

> **Estado (2026-03-19):** NO IMPLEMENTADO. No existe configuración pkg en `package.json`, ni binarios, ni `build.sh`. El servidor se despliega con PM2 + systemd en producción. Este plan sigue siendo válido como roadmap para distribución.

## Objetivo

Convertir Clawmint en un programa instalable como cualquier otro:
- **Linux** → AppImage o binario único
- **Windows** → `.exe` único o installer con NSIS

El usuario descarga un archivo, lo ejecuta, y abre el navegador en `localhost:3001`.

---

## Herramienta elegida: pkg

**pkg** (de Vercel) empaqueta el runtime de Node.js + el código del servidor en un solo binario ejecutable.

```bash
npm install -g @vercel/pkg
```

### ¿Por qué pkg y no Electron?

| | pkg | Electron |
|---|---|---|
| Tamaño final | ~50 MB | ~200 MB |
| Complejidad | Baja | Alta |
| Ventana propia | No (usa el browser) | Sí |
| Cambios en el código | Mínimos | Grandes |
| Encaja con Clawmint | Sí (ya sirve el cliente) | Requiere rediseño |

---

## Arquitectura del instalador

```
binario clawmint (pkg)
└── Inicia Express en :3001
    ├── Sirve client/dist/ (embebido)
    ├── WebSocket + node-pty
    └── Bot Telegram (opcional)

Usuario → abre navegador → localhost:3001
```

---

## Problema principal: node-pty es un módulo nativo

`node-pty` compila código C++ al instalarse. pkg no puede empaquetar binarios nativos directamente.

### Solución

Incluir los binarios precompilados de `node-pty` como archivos externos junto al ejecutable:

```
clawmint-linux          ← binario pkg
node_modules/node-pty/  ← binarios nativos (junto al ejecutable)
client/dist/            ← cliente React embebido dentro del binario
```

Alternativa más limpia: usar `pkg-fetch` con targets específicos y copiar los `.node` manualmente.

---

## Pasos de implementación

### 1. Preparar el servidor para pkg

Agregar en `server/package.json`:

```json
{
  "bin": "index.js",
  "pkg": {
    "targets": ["node22-linux-x64", "node22-win-x64"],
    "assets": [
      "client/dist/**/*",
      "node_modules/node-pty/build/**/*"
    ],
    "outputPath": "../dist"
  }
}
```

### 2. Ajustar rutas en index.js

El binario pkg cambia `__dirname`. Hay que usar rutas relativas al ejecutable:

```js
const path = require('path');
const BASE = process.pkg ? path.dirname(process.execPath) : __dirname;
const CLIENT_DIST = path.join(BASE, 'client', 'dist');
```

### 3. Manejar node-pty

Copiar los binarios nativos junto al ejecutable en el script de build:

```bash
# build.sh
pkg server/index.js --targets node22-linux-x64,node22-win-x64 --output dist/clawmint
cp -r server/node_modules/node-pty/build dist/
```

### 4. Script de build completo

```bash
#!/bin/bash
# build.sh

echo "Buildeando cliente React..."
cd client && npm run build && cd ..

echo "Copiando dist del cliente al servidor..."
cp -r client/dist server/client-dist

echo "Empaquetando con pkg..."
cd server
pkg . --targets node22-linux-x64,node22-win-x64 --output ../dist/clawmint

echo "Copiando binarios nativos (node-pty)..."
cp -r node_modules/node-pty/build ../dist/

echo "Hecho. Binarios en dist/"
```

### 5. Estructura final del release

```
dist/
├── clawmint-linux      ← ejecutable Linux
├── clawmint-win.exe    ← ejecutable Windows
└── node-pty-build/     ← binarios nativos (van junto al ejecutable)
```

---

## Installer opcional (experiencia más pulida)

### Linux → AppImage

Wrappear el binario en un AppImage para que el usuario haga doble clic:

```bash
# Usar appimagetool
./appimagetool clawmint-appdir/ Clawmint-x86_64.AppImage
```

### Windows → NSIS

Script NSIS que:
1. Copia `clawmint-win.exe` a `C:\Program Files\Clawmint\`
2. Crea acceso directo en el escritorio
3. Registra en Agregar/Quitar programas

---

## Experiencia del usuario final

1. Descarga `Clawmint-linux` o `Clawmint-win.exe`
2. Lo ejecuta (doble clic o terminal)
3. Abre el navegador en `http://localhost:3001`
4. Listo — terminal IA funcionando

---

## Tareas pendientes

- [ ] Ajustar rutas en `index.js` para modo pkg (`process.pkg`)
- [ ] Probar empaquetado básico sin node-pty
- [ ] Resolver binarios nativos de node-pty en Linux
- [ ] Resolver binarios nativos de node-pty en Windows (requiere cross-compile o build en Windows)
- [ ] Script `build.sh` funcional
- [ ] Probar binario resultante en Linux
- [ ] Probar binario resultante en Windows
- [ ] Opcional: AppImage para Linux
- [ ] Opcional: NSIS installer para Windows
- [ ] CI/CD con GitHub Actions para builds automáticos en cada release

---

## Referencias

- [pkg — Vercel](https://github.com/vercel/pkg)
- [node-pty con pkg](https://github.com/microsoft/node-pty/issues/472)
- [appimagetool](https://appimage.github.io/appimagetool/)
- [NSIS](https://nsis.sourceforge.io/)

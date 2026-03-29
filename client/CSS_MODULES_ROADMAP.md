# Roadmap: Migración CSS Modules

## Estado actual
- ✅ AudioPlayer.css → AudioPlayer.module.css
- ✅ CommandBar.css → CommandBar.module.css
- ⬜ 10 archivos restantes

## Sesión 1: Hojas restantes (~30min)
Archivos pequeños sin dependencias. Riesgo mínimo.

| Archivo | LOC | Patrón |
|---------|-----|--------|
| TabBar.css → TabBar.module.css | 91 | `tab-*` → `styles.*` |
| ProvidersPanel.css → ProvidersPanel.module.css | 112 | `pp-*` → `styles.*` |
| DirPicker.css → DirPicker.module.css | 186 | `dirpicker-*` → `styles.*` |

**Verificación:** `npm run build` + revisar visualmente terminal tabs, panel providers, dir picker.

---

## Sesión 2: Paneles medianos (~45min)
Paneles con formularios y listas. Tienen subcomponentes internos (AgentForm, ContactForm, etc.) pero todo en el mismo archivo.

| Archivo | LOC | Patrón | Notas |
|---------|-----|--------|-------|
| AgentsPanel.css → AgentsPanel.module.css | 350 | `ap-*` → `styles.*` | Incluye SkillsSection (`ap-skill*`) |
| ContactsPanel.css → ContactsPanel.module.css | 361 | `cp-*` → `styles.*` | Incluye ContactDetail, ContactRow |
| AuthPanel.css → AuthPanel.module.css | 403 | `auth-*` → `styles.*` | Fix: mover `wc-user-badge`, `wc-login-btn` a `styles.userBadge`, `styles.loginBtn` |

**Verificación:** `npm run build` + revisar CRUD agentes, contactos (lista/detalle/form), login/registro.

---

## Sesión 3: TelegramPanel (~45min)
El más complejo por cantidad de subcomponentes (BotCard, ChatRow, AccessConfig, AddBotForm).

| Archivo | LOC | Patrón | Notas |
|---------|-----|--------|-------|
| TelegramPanel.css → TelegramPanel.module.css | 541 | `tg-*` → `styles.*` | Fix: `.access-config` global → `styles.accessConfig` |

**Cuidado:** `styles` debe pasarse o importarse en los subcomponentes `BotCard`, `ChatRow`, `AccessConfig`, `AddBotForm` (todos están en TelegramPanel.jsx, así que comparten el import).

**Verificación:** `npm run build` + revisar bots (start/stop/delete), chats (vincular/desvincular), access config (whitelist, rate limit), agregar bot.

---

## Sesión 4: WebChatPanel (~1h)
El archivo CSS más grande. Tiene clases usadas por componentes hijos en `chat/`.

| Archivo | LOC | Patrón | Notas |
|---------|-----|--------|-------|
| WebChatPanel.css → WebChatPanel.module.css | 701 | `wc-*` → `styles.*` | ⚠️ Ver abajo |

**⚠️ Dependencias cruzadas:**
Verificar si `ChatHeader.jsx`, `ChatInput.jsx`, `MessageList.jsx`, `StatusBar.jsx`, `RecordingBar.jsx` usan clases `wc-*` directamente. Si sí:
- Opción A: Pasar `styles` como prop desde WebChatPanel
- Opción B: Crear un module.css por cada subcomponente y mover sus clases ahí
- Opción C: Importar el mismo module.css en cada subcomponente

Investigar antes de implementar con: `grep -r "wc-" client/src/components/chat/`

**Verificación:** `npm run build` + chat completo: enviar texto, recibir streaming, multimedia (foto/doc/audio/video), botones inline, TTS, recording, upload archivos, permisos ask mode, tema claro/oscuro.

---

## Sesión 5: App.css (~1h)
El layout principal. Requiere separar clases globales de clases específicas.

| Archivo | LOC | Patrón | Notas |
|---------|-----|--------|-------|
| App.css → App.module.css + global.css | 704 | Múltiples prefijos | ⚠️ Ver abajo |

**Estrategia de separación:**

**Mantener en global.css** (importado en main.jsx):
- `.section`, `.section-active`, `.section-full`, `.section-terminal` — usadas por App.jsx para controlar visibilidad
- `.split-layout`, `.split-panel`, `.split-divider`, `.split-chat-panel` — layout split
- `.terminal-body` — wrapper de terminal
- `.skip-link` — accesibilidad

**Mover a App.module.css:**
- `.app` — contenedor root
- `.app-header`, `.dot`, `.title`, `.ws-status-dot`, `.header-*` — ahora en AppHeader.tsx
- `.app-sidebar`, `.sidebar-*` — ahora en Sidebar.tsx
- `.app-layout`, `.app-content` — layout principal
- `.section-bar`, `.section-bar-*` — ahora en SectionBar.tsx
- `.context-*`, `.split-toggle-btn` — ahora en ContextBar.tsx
- `.section-config`, `.config-*` — ahora en ConfigSection.tsx
- `.mobile-bottom-nav`, `.mobile-nav-*` — ahora en MobileNav.tsx

**⚠️ Problema:** Los componentes extraídos (Sidebar.tsx, AppHeader.tsx, etc.) importarían App.module.css. Alternativa más limpia: crear un module.css por cada componente de layout.

**Decisión a tomar antes de implementar:**
1. Un solo App.module.css importado por todos los layout components
2. Un module.css por componente (Sidebar.module.css, AppHeader.module.css, etc.)

Opción 2 es más escalable pero requiere dividir App.css en ~6 archivos.

**Verificación:** `npm run build` + `npm test` + verificar TODO: navegación, sidebar, split, mobile nav, header, theme toggle, badges, secciones.

---

## Resumen

| Sesión | Archivos | LOC | Esfuerzo | Riesgo |
|--------|----------|-----|----------|--------|
| 1 | TabBar, ProvidersPanel, DirPicker | 389 | 30min | Bajo |
| 2 | AgentsPanel, ContactsPanel, AuthPanel | 1114 | 45min | Bajo |
| 3 | TelegramPanel | 541 | 45min | Medio |
| 4 | WebChatPanel | 701 | 1h | Medio-Alto |
| 5 | App.css (split) | 704 | 1h | Medio |
| **Total** | **10 archivos** | **3449** | **~4h** | — |

## Reglas por sesión
1. Crear `.module.css` (renombrar clases sin prefijo)
2. Actualizar JSX (`className="x-foo"` → `className={styles.foo}`)
3. Borrar `.css` viejo
4. `npm run build` — debe pasar
5. `npm test` — debe pasar
6. Verificar visualmente el componente

## Comando útil para verificar migración
```bash
# Ver si quedan imports de CSS no-module
grep -r "import '\./.*\.css'" client/src/components/ --include="*.jsx" --include="*.tsx"
```

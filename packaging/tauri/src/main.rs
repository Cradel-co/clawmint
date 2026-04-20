// main.rs — Clawmint desktop shell
//
// Responsabilidades:
// 1. Al launch: spawnear el Node sidecar con env CLAWMINT_DATA_DIR + CLAWMINT_RESOURCES_DIR.
// 2. Poll GET http://localhost:3001/api/health hasta que responda (timeout 30s).
// 3. Al OK: cargar URL en el webview y mostrar la ventana.
// 4. Tray icon con menú: Abrir, Pausar service, Ver logs, Salir.
// 5. Al cerrar la ventana (close_requested): esconder, NO matar el sidecar.
//    "Salir" del menú cierra la app; el service instalado sigue corriendo aparte
//    (Windows Service / systemd). Si arrancamos el sidecar nosotros (no hay
//    service), lo matamos al exit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use once_cell::sync::OnceCell;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

// Handle del sidecar (si lo lanzamos nosotros). None cuando hay service externo
// registrado (Windows Service / systemd) — en ese caso, no lo matamos al exit.
static SIDECAR: OnceCell<Mutex<Option<CommandChild>>> = OnceCell::new();

const HEALTH_URL: &str = "http://localhost:3001/api/health";
const HEALTH_TIMEOUT_SECS: u64 = 30;
const HEALTH_POLL_INTERVAL_MS: u64 = 500;

fn data_dir() -> PathBuf {
    // Prioridad:
    //  1. CLAWMINT_DATA_DIR env (setado por installer)
    //  2. OS default: Windows → %PROGRAMDATA%\Clawmint; Linux/Mac → dirs::data_local_dir() / clawmint
    if let Ok(p) = std::env::var("CLAWMINT_DATA_DIR") {
        return PathBuf::from(p);
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(pd) = std::env::var("PROGRAMDATA") {
            return PathBuf::from(pd).join("Clawmint");
        }
    }
    if let Some(d) = dirs::data_local_dir() {
        return d.join("clawmint");
    }
    PathBuf::from(".")
}

fn resources_dir(app: &AppHandle) -> PathBuf {
    // Tauri expone el dir de resources bundleados; adentro tenemos resources/server/.
    app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn has_external_service() -> bool {
    // Heurística: si el service está corriendo antes de que Tauri arranque, no
    // lanzamos sidecar. Chequeamos si el puerto ya responde.
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:3001".parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
}

fn spawn_sidecar(app: &AppHandle) {
    if has_external_service() {
        eprintln!("[clawmint] service externo ya responde en :3001, no se lanza sidecar");
        return;
    }
    let data_dir_path = data_dir();
    if let Err(e) = std::fs::create_dir_all(&data_dir_path) {
        eprintln!("[clawmint] mkdir data_dir: {}", e);
    }
    let res_dir = resources_dir(app);
    let server_entry = res_dir.join("resources").join("server").join("index.js");

    eprintln!(
        "[clawmint] spawn sidecar: node {} (DATA={})",
        server_entry.display(),
        data_dir_path.display()
    );

    let sidecar = app
        .shell()
        .sidecar("node")
        .expect("node sidecar no configurado en tauri.conf.json")
        .args([server_entry.to_string_lossy().to_string()])
        .env("CLAWMINT_DATA_DIR", data_dir_path.to_string_lossy().to_string())
        .env("CLAWMINT_RESOURCES_DIR", res_dir.to_string_lossy().to_string())
        .env("NODE_OPTIONS", "--stack-size=65536");

    match sidecar.spawn() {
        Ok((mut rx, child)) => {
            SIDECAR.get_or_init(|| Mutex::new(None));
            if let Some(slot) = SIDECAR.get() {
                *slot.lock().unwrap() = Some(child);
            }
            // Lee stdout/stderr en task separada (para que los logs se puedan
            // imprimir + eventualmente mostrar en la UI via event).
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                            let s = String::from_utf8_lossy(&line).to_string();
                            eprintln!("[clawmint sidecar] {}", s.trim_end());
                            let _ = app_clone.emit("sidecar:log", &s);
                        }
                        tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                            let s = String::from_utf8_lossy(&line).to_string();
                            eprintln!("[clawmint sidecar err] {}", s.trim_end());
                            let _ = app_clone.emit("sidecar:log", &s);
                        }
                        tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                            eprintln!("[clawmint sidecar] terminated: {:?}", payload.code);
                            let _ = app_clone.emit("sidecar:exit", payload.code);
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("[clawmint] spawn sidecar FAIL: {}", e);
        }
    }
}

async fn wait_health() -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok();
    if client.is_none() {
        return false;
    }
    let client = client.unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(HEALTH_TIMEOUT_SECS);
    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(HEALTH_URL).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
    }
    false
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Abrir panel", true, None::<&str>)?;
    let logs_item = MenuItem::with_id(app, "logs", "Ver logs", true, None::<&str>)?;
    let about_item = MenuItem::with_id(app, "about", "Acerca de Clawmint", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &logs_item, &about_item, &quit_item])?;

    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "logs" => {
                let log_path = data_dir().join("logs").join("server.log");
                let url = format!("file://{}", log_path.to_string_lossy());
                let _ = tauri_plugin_opener::OpenerExt::opener(app).open_url(url, None::<&str>);
            }
            "about" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state, .. } = event {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    if let Some(w) = tray.app_handle().get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // 1) Tray icon
            build_tray(&handle)?;

            // 2) Spawn sidecar + wait health, luego show window
            tauri::async_runtime::spawn(async move {
                spawn_sidecar(&handle);
                let ok = wait_health().await;
                if !ok {
                    eprintln!("[clawmint] health timeout — mostrando ventana de todos modos");
                }
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = handle.emit("sidecar:ready", ok);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Cerrar ventana = esconder. El service sigue corriendo.
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error al correr Tauri");

    // Cleanup: si teníamos sidecar propio, matarlo al salir.
    if let Some(slot) = SIDECAR.get() {
        if let Some(child) = slot.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

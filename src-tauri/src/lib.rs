// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod capture;
mod logging;
mod db;
mod shortcuts;
mod window;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
pub mod speaker;
mod stt;
pub mod stt_diagnostics;
use capture::CaptureState;
use speaker::{TaskSlot, VadConfig};

#[cfg(target_os = "macos")]
#[allow(deprecated)]
use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, panel_delegate, WebviewWindowExt};

pub struct AudioState {
    stream_task: TaskSlot<()>,
    vad_config: Arc<Mutex<VadConfig>>,
    is_capturing: Arc<Mutex<bool>>,
    stop_flag: Arc<AtomicBool>,
    /// Set alongside `stop_flag` when the user discards a manual take, so the
    /// capture task drops the audio instead of emitting it for transcription.
    discard_take: Arc<AtomicBool>,
    /// Wakes the running capture's stream on stop, so a capture with no
    /// audio arriving still notices it.
    stream_stopper: Mutex<Option<speaker::CaptureStopper>>,
}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            stream_task: TaskSlot::new(),
            vad_config: Arc::new(Mutex::new(VadConfig::default())),
            is_capturing: Arc::new(Mutex::new(false)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            discard_take: Arc::new(AtomicBool::new(false)),
            stream_stopper: Mutex::new(None),
        }
    }
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:assistant.db", db::migrations())
                .build(),
        )
        .manage(AudioState::default())
        .manage(stt::SttState::default())
        .manage(stt::UtteranceStore::default())
        .manage(CaptureState::default())
        .manage(shortcuts::WindowVisibility {
            is_hidden: Mutex::new(false),
        })
        .manage(shortcuts::RegisteredShortcuts::default())
        .manage(shortcuts::LicenseState::default())
        .manage(shortcuts::MoveWindowState::default())
        .manage(speaker::MicDictationState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_keychain::init())
        .plugin(tauri_plugin_shell::init()); // Add shell plugin
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }
    let mut builder = builder
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            window::set_window_height,
            window::open_dashboard,
            window::toggle_dashboard,
            capture::capture_to_base64,
            capture::start_screen_capture,
            capture::capture_selected_area,
            capture::close_overlay_window,
            shortcuts::check_shortcuts_registered,
            shortcuts::get_registered_shortcuts,
            shortcuts::update_shortcuts,
            shortcuts::validate_shortcut_key,
            shortcuts::set_license_status,
            shortcuts::set_app_icon_visibility,
            shortcuts::set_always_on_top,
            shortcuts::exit_app,
            shortcuts::toggle_overlay,
            shortcuts::is_overlay_visible,
            speaker::start_system_audio_capture,
            speaker::stop_system_audio_capture,
            speaker::manual_stop_continuous,
            speaker::check_system_audio_access,
            speaker::request_system_audio_access,
            speaker::get_vad_config,
            speaker::update_vad_config,
            speaker::get_capture_status,
            speaker::get_input_devices,
            speaker::get_output_devices,
            speaker::start_mic_dictation,
            speaker::stop_mic_dictation,
            stt::stt_init,
            stt::stt_init_vad,
            stt::stt_init_live_text,
            stt::stt_init_live_speakers,
            stt::stt_transcribe_speech,
            stt::stt_transcribe_utterance,
            stt::stt_get_status,
            stt::stt_utterance_wav,
            logging::log_ui_message,
            db::db_save_conversation,
        ])
        .setup(|app| {
            // First, so warnings raised during the rest of setup are kept.
            match app.path().app_log_dir() {
                Ok(dir) => logging::init(&dir),
                Err(error) => eprintln!("No log directory, so warnings are not logged: {error}"),
            }
            // Clear session WAVs left behind by versions that recorded them.
            speaker::sweep_stale_session_wavs(
                &std::env::temp_dir(),
                std::time::Duration::from_secs(24 * 3600),
            );
            // Setup main window positioning
            window::setup_main_window(app).expect("Failed to setup main window");
            #[cfg(target_os = "macos")]
            init(app.app_handle());
            let app_handle = app.handle();
            if app_handle.get_webview_window("dashboard").is_none() {
                if let Err(e) = window::create_dashboard_window(app_handle) {
                    tracing::warn!("Failed to pre-create dashboard window on startup: {}", e);
                }
            }
            // NOTE: the dashboard-primary launch flip (hide overlay + focus
            // dashboard) was reverted — it fought this app's overlay-first
            // foundation (non-activating NSPanel), leaving the app with no
            // foreground activation. The overlay is visible on launch again
            // (tauri.conf visible:true); the dashboard opens on ⌘⇧D. A proper
            // embedded-bar model replaces this later.

            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::MacosLauncher;

                #[allow(deprecated, unexpected_cfgs)]
                if let Err(e) = app.handle().plugin(tauri_plugin_autostart::init(
                    MacosLauncher::LaunchAgent,
                    Some(vec![]),
                )) {
                    tracing::warn!("Failed to initialize autostart plugin: {}", e);
                }
            }

            // Initialize global shortcut plugin with centralized handler
            app.handle()
                .plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

                            let action_id = {
                                let state = app.state::<shortcuts::RegisteredShortcuts>();
                                let registered = match state.shortcuts.lock() {
                                    Ok(guard) => guard,
                                    Err(poisoned) => {
                                        tracing::error!("Mutex poisoned in handler, recovering...");
                                        poisoned.into_inner()
                                    }
                                };

                                registered.iter().find_map(|(action_id, shortcut_str)| {
                                    if let Ok(s) = shortcut_str.parse::<Shortcut>() {
                                        if &s == shortcut {
                                            return Some(action_id.clone());
                                        }
                                    }
                                    None
                                })
                            };

                            if let Some(action_id) = action_id {
                                match event.state() {
                                    ShortcutState::Pressed => {
                                        if let Some(direction) =
                                            action_id.strip_prefix("move_window_")
                                        {
                                            shortcuts::start_move_window(app, direction);
                                        } else {
                                            tracing::debug!("Shortcut triggered: {}", action_id);
                                            shortcuts::handle_shortcut_action(app, &action_id);
                                        }
                                    }
                                    ShortcutState::Released => {
                                        if let Some(direction) =
                                            action_id.strip_prefix("move_window_")
                                        {
                                            shortcuts::stop_move_window(app, direction);
                                        }
                                    }
                                }
                            }
                        })
                        .build(),
                )
                .expect("Failed to initialize global shortcut plugin");
            if let Err(e) = shortcuts::setup_global_shortcuts(app.handle()) {
                tracing::warn!("Failed to setup global shortcuts: {}", e);
            }
            Ok(())
        });

    // Add macOS-specific permissions plugin
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_permissions::init());
    }

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // macOS dock click with the dashboard hidden: bring it back focused.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Err(e) = window::show_dashboard_window(app_handle) {
                tracing::warn!("Failed to reopen dashboard on dock activation: {}", e);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app_handle, &event);
        }
    });
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn init(app_handle: &AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        tracing::warn!("main window not found; skipping panel setup");
        return;
    };

    let Ok(panel) = window.to_panel() else {
        tracing::warn!("failed to convert main window to panel; skipping panel setup");
        return;
    };

    let delegate = panel_delegate!(MyPanelDelegate {
        window_did_become_key,
        window_did_resign_key
    });

    let handle = app_handle.to_owned();

    delegate.set_listener(Box::new(move |delegate_name: String| {
        match delegate_name.as_str() {
            "window_did_become_key" => {
                let app_name = handle.package_info().name.to_owned();

                println!("[info]: {:?} panel becomes key window!", app_name);
            }
            "window_did_resign_key" => {
                println!("[info]: panel resigned from key window!");
            }
            _ => (),
        }
    }));

    // Set the window to float level
    #[allow(non_upper_case_globals)]
    const NSFloatWindowLevel: i32 = 4;
    panel.set_level(NSFloatWindowLevel);

    #[allow(non_upper_case_globals)]
    const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
    panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);

    #[allow(deprecated)]
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces,
    );

    panel.set_delegate(delegate);
}

#[cfg(target_os = "macos")]
use tauri::LogicalPosition;
use tauri::{App, AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

// The offset from the top of the screen to the window
const TOP_OFFSET: i32 = 54;

/// Sets up the main window with custom positioning
pub fn setup_main_window(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Try different possible window labels
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("assistant"))
        .or_else(|| {
            // Get the first window if specific labels don't work
            app.webview_windows().values().next().cloned()
        })
        .ok_or("No window found")?;

    position_window_top_center(&window, TOP_OFFSET)?;

    // GTK sizes a non-resizable window from its contents and ignores resizes
    // from code, so allow resizes once here instead of on every height change.
    #[cfg(target_os = "linux")]
    prepare_linux_resize(&window);

    // Set window as non-focusable on Windows
    // #[cfg(target_os = "windows")]
    // {
    //     let _ = window.set_focusable(false);
    // }

    Ok(())
}

/// Positions a window at the top center of the screen with a specified Y offset
pub fn position_window_top_center(
    window: &WebviewWindow,
    y_offset: i32,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get the primary monitor
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        // Calculate center X position
        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;

        // Set the window position
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: y_offset,
        }))?;
    }

    Ok(())
}

/// Future function for centering window completely (both X and Y)
#[allow(dead_code)]
pub fn center_window_completely(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;
        let center_y = (monitor_size.height as i32 - window_size.height as i32) / 2;

        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: center_y,
        }))?;
    }

    Ok(())
}

/// Linux creates the overlay as a non-resizable GTK window, and GTK sizes
/// those from their contents, ignoring resizes from code. The web view asks
/// for no height, so GTK fell back to 200 px: on Nobara/KDE the bar sat at
/// 600x200 instead of 64 (idle) or 600 (panel open). Allowing resizes from
/// code fixes it (verified there: 600x64 idle, grows and shrinks back); the
/// window has no edges to drag, so the user still cannot resize it.
#[cfg(target_os = "linux")]
fn prepare_linux_resize(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use gtk::prelude::GtkWindowExt;
        if let Ok(gtk_window) = target.gtk_window() {
            if !gtk_window.is_resizable() {
                gtk_window.set_resizable(true);
                tracing::info!("Linux overlay window made resizable from code");
            }
        }
    });
}

#[tauri::command]
pub fn set_window_height(window: tauri::WebviewWindow, height: u32) -> Result<(), String> {
    use tauri::{LogicalSize, Size};

    let max_logical_height = window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|m| {
            let scale = m.scale_factor();
            if scale > 0.0 {
                Some(m.size().height as f64 / scale)
            } else {
                None
            }
        })
        .unwrap_or(f64::MAX);
    let clamped = (height as f64).clamp(1.0, max_logical_height);

    let new_size = LogicalSize::new(600.0, clamped);
    window
        .set_size(Size::Logical(new_size))
        .map_err(|e| format!("Failed to resize window: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    show_dashboard_window(&app)
}

#[tauri::command]
pub fn toggle_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        match dashboard_window.is_visible() {
            Ok(true) => {
                // Window is visible, hide it
                dashboard_window
                    .hide()
                    .map_err(|e| format!("Failed to hide dashboard window: {}", e))?;
            }
            Ok(false) => {
                // Window is hidden, show and focus it
                dashboard_window
                    .show()
                    .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
                dashboard_window
                    .set_focus()
                    .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
            }
            Err(e) => {
                return Err(format!("Failed to check dashboard visibility: {}", e));
            }
        }
    } else {
        // Window doesn't exist, create and show it
        show_dashboard_window(&app)?;
    }

    Ok(())
}

pub fn create_dashboard_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, tauri::Error> {
    let base_builder = WebviewWindowBuilder::new(
        app,
        "dashboard",
        tauri::WebviewUrl::App("/dashboard".into()),
    );

    #[cfg(target_os = "macos")]
    let base_builder = base_builder
        .title("Aileron - Dashboard")
        .center()
        .decorations(true)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .content_protected(true)
        .visible(true)
        .traffic_light_position(LogicalPosition::new(14.0, 18.0));

    #[cfg(not(target_os = "macos"))]
    let base_builder = base_builder
        .title("Aileron - Dashboard")
        .center()
        .decorations(true)
        .inner_size(800.0, 600.0)
        .min_inner_size(800.0, 600.0)
        .content_protected(true)
        .visible(true);

    // Linux windows are opaque, and WebKit paints its default white before the
    // page does: paint the theme background instead of flashing.
    #[cfg(target_os = "linux")]
    let base_builder = base_builder.background_color(tauri::window::Color(13, 19, 16, 255));

    #[cfg(debug_assertions)]
    let base_builder = base_builder.devtools(true);

    let window = base_builder.build()?;

    // Set up close event handler - hide window instead of destroying it
    setup_dashboard_close_handler(&window);

    Ok(window)
}

/// Sets up the close event handler for the dashboard window
fn setup_dashboard_close_handler<R: Runtime>(window: &WebviewWindow<R>) {
    let window_clone = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Prevent the window from being destroyed
            api.prevent_close();
            // Hide the window instead
            if let Err(e) = window_clone.hide() {
                tracing::warn!("Failed to hide dashboard window on close: {}", e);
            }
        }
    });
}

/// Shows the dashboard window and brings it to focus
/// Force the app to the foreground. The main window is a non-activating
/// NSPanel, so showing/focusing the dashboard alone does not make the app the
/// active application (no menu bar, window can stay behind). Activating the
/// NSApplication explicitly is what a normal windowed app needs.
#[cfg(target_os = "macos")]
pub fn activate_app<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.run_on_main_thread(|| {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;

        let main_thread =
            MainThreadMarker::new().expect("application activation must run on the main thread");
        let ns_app = NSApplication::sharedApplication(main_thread);
        unsafe { ns_app.activate() };
    })
    .map_err(|e| format!("Failed to activate application: {}", e))
}

pub fn show_dashboard_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        // Window exists, show and focus it
        dashboard_window
            .show()
            .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
        dashboard_window
            .set_focus()
            .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
    } else {
        // Window doesn't exist, create it and then show it
        let window = create_dashboard_window(app)
            .map_err(|e| format!("Failed to create dashboard window: {}", e))?;
        window
            .show()
            .map_err(|e| format!("Failed to show new dashboard window: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus new dashboard window: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    activate_app(app)?;
    Ok(())
}

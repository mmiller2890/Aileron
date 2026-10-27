//! Linux desktop compatibility settings applied before the window opens.
//!
//! WebKitGTK's DMA-BUF renderer breaks on NVIDIA's proprietary driver under
//! Wayland: the app exits within a second with "Error 71 (Protocol error)
//! dispatching to Wayland display" before drawing anything (seen on Nobara 44,
//! KDE Plasma, RTX 3080, driver 615.71). Turning that renderer off fixes it.
//! Other GPUs keep WebKit's default.

/// Whether to turn off WebKit's DMA-BUF renderer: only with the NVIDIA
/// driver loaded, and never over a value the user set themselves.
pub(crate) fn needs_dmabuf_workaround(nvidia_driver_loaded: bool, already_set: bool) -> bool {
    nvidia_driver_loaded && !already_set
}

/// Apply the workaround. Call first thing in `run()`, on the main thread,
/// before anything else starts threads or initialises GTK.
pub(crate) fn apply() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    // Deliberately broad: any loaded NVIDIA driver, not just the one drawing
    // the session. A missed trigger means the app does not open at all, while
    // an extra one only turns off DMA-BUF rendering for a small UI. A value the
    // user set is left alone.
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if needs_dmabuf_workaround(nvidia, std::env::var_os(VAR).is_some()) {
        std::env::set_var(VAR, "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvidia_gets_the_workaround() {
        assert!(needs_dmabuf_workaround(true, false));
    }

    #[test]
    fn other_gpus_keep_webkits_default() {
        assert!(!needs_dmabuf_workaround(false, false));
    }

    #[test]
    fn a_value_the_user_set_is_left_alone() {
        assert!(!needs_dmabuf_workaround(true, true));
    }
}

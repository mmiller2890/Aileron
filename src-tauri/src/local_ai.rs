//! What the first-launch setup needs to know about a local AI runtime that is
//! not answering: whether Ollama is installed at all (so the setup can say
//! "open it" instead of "install it"), and a way to open it.

use std::path::{Path, PathBuf};

/// Where an Ollama install puts its app or its `ollama` binary.
fn ollama_locations(home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = [
        "/Applications/Ollama.app",
        "/opt/homebrew/bin/ollama",
        "/usr/local/bin/ollama",
        "/usr/bin/ollama",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Some(home) = home {
        paths.push(home.join("Applications/Ollama.app"));
        paths.push(home.join(".local/bin/ollama"));
    }
    paths
}

fn any_exists(paths: &[PathBuf]) -> bool {
    paths.iter().any(|path| path.exists())
}

#[tauri::command]
pub fn ollama_installed() -> bool {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    any_exists(&ollama_locations(home.as_deref()))
}

/// Open the Ollama app, which starts its local server. macOS only: elsewhere
/// Ollama runs as a service the user manages.
#[tauri::command]
pub fn launch_ollama() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .args(["-g", "-a", "Ollama"])
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Couldn't open the Ollama app".to_string())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Start Ollama with: ollama serve".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_in_the_system_and_the_users_own_install_locations() {
        let paths = ollama_locations(Some(Path::new("/Users/someone")));
        assert!(paths.contains(&PathBuf::from("/Applications/Ollama.app")));
        assert!(paths.contains(&PathBuf::from("/opt/homebrew/bin/ollama")));
        assert!(paths.contains(&PathBuf::from("/Users/someone/Applications/Ollama.app")));
    }

    #[test]
    fn is_installed_when_any_location_exists() {
        let dir = std::env::temp_dir().join(format!("aileron-ollama-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let present = dir.join("ollama");
        std::fs::write(&present, b"").unwrap();
        assert!(any_exists(&[dir.join("missing"), present]));
        assert!(!any_exists(&[dir.join("missing")]));
        std::fs::remove_dir_all(dir).ok();
    }
}

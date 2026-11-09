// The desktop shell around the web app. The page is the same Vite build as
// the web version; the desktop adds what a browser cannot do: open a model
// where it is on disk, so the textures beside it (in its folder, or a
// sibling folder such as "../textures") are found without choosing them;
// save exports through the system's save dialog, and a cut model's pieces
// into a new folder; and open the model the app was started with (dropped on
// its icon, or "Open with").

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// The folders `make_folder` made: `write_file` writes only into these.
#[derive(Default)]
struct Made(Mutex<HashSet<PathBuf>>);

/// Files listed at most, so a game's whole extracted folder does not stall the app.
const MAX_FILES: usize = 60_000;

/// A file's bytes.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

/// Whether a path is a file, a folder or nothing.
#[tauri::command]
fn path_kind(path: String) -> &'static str {
    let p = Path::new(&path);
    if p.is_dir() {
        "dir"
    } else if p.is_file() {
        "file"
    } else {
        "none"
    }
}

fn walk(dir: &Path, prefix: &str, depth: usize, skip: Option<&Path>, out: &mut Vec<String>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if depth > 0 && skip.map_or(true, |s| s != path.as_path()) {
                walk(&path, &format!("{prefix}{name}/"), depth - 1, None, out);
            }
        } else {
            out.push(format!("{prefix}{name}"));
        }
    }
}

/// The files near a folder, relative to it: its own tree first, then the rest
/// of its parent's (as "../…"), where games and exporters put textures.
#[tauri::command]
fn list_files(folder: String) -> Vec<String> {
    let dir = PathBuf::from(&folder);
    let mut out = Vec::new();
    walk(&dir, "", 8, None, &mut out);
    if let Some(parent) = dir.parent() {
        if parent != dir.as_path() && !parent.as_os_str().is_empty() {
            walk(parent, "../", 4, Some(dir.as_path()), &mut out);
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

/// The system's open dialog: the file picked, or None when cancelled.
#[tauri::command]
async fn pick_file(app: AppHandle, title: String, filters: Vec<Filter>) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title(&title);
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(&f.name, &exts);
    }
    match dialog.blocking_pick_file() {
        None => Ok(None),
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?.display().to_string())),
    }
}

/// Saves an export (the body) where the person picks in a save dialog,
/// starting from the name in the `x-name` header. Ok(None) when they cancel.
/// The web version downloads instead; webviews do not all save blob downloads.
#[tauri::command]
async fn export_file(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(decode_name)
        .unwrap_or_else(|| "export".into());
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
    let mut dialog = app.dialog().file().set_file_name(&name);
    if !ext.is_empty() {
        dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
    }
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let tmp = path.with_extension("partial");
    fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// The system's folder dialog: the folder picked, or None when cancelled.
#[tauri::command]
async fn pick_folder(app: AppHandle, title: String) -> Result<Option<String>, String> {
    match app.dialog().file().set_title(&title).blocking_pick_folder() {
        None => Ok(None),
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?.display().to_string())),
    }
}

/// A name with no path in it, for a file or folder.
fn plain_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "pieces".into() } else { s }
}

/// Makes a new folder `name` in `parent` ("name 2", "name 3"... when it is
/// taken, so saving again never mixes two sets of pieces): its path.
#[tauri::command]
fn make_folder(made: State<'_, Made>, parent: String, name: String) -> Result<String, String> {
    let base = Path::new(&parent);
    let name = plain_name(&name);
    for n in 1..1000 {
        let p = if n == 1 { base.join(&name) } else { base.join(format!("{name} {n}")) };
        if p.exists() {
            continue;
        }
        fs::create_dir_all(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        made.0.lock().map_err(|e| e.to_string())?.insert(p.clone());
        return Ok(p.display().to_string());
    }
    Err(format!("{}: there are too many folders named {name}", base.display()))
}

/// Writes the body as the file named in the `x-name` header into the folder in
/// `x-folder`, which `make_folder` made.
#[tauri::command]
async fn write_file(made: State<'_, Made>, request: Request<'_>) -> Result<(), String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(decode_name);
    let (Some(folder), Some(name)) = (header("x-folder"), header("x-name")) else {
        return Err("expected a folder and a name".into());
    };
    let folder = PathBuf::from(folder);
    if !made.0.lock().map_err(|e| e.to_string())?.contains(&folder) {
        return Err(format!("{}: not a folder made for saving", folder.display()));
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let path = folder.join(plain_name(&name));
    let tmp = path.with_extension("partial");
    fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(())
}

/// The header carries the name percent-encoded (headers are ASCII).
fn decode_name(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The file the app was started with, if any.
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && Path::new(a).exists())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Made::default())
        .invoke_handler(tauri::generate_handler![read_file, path_kind, list_files, pick_file, export_file, pick_folder, make_folder, write_file, startup_file])
        .run(tauri::generate_context!())
        .expect("error while running Model Painter");
}

#[cfg(test)]
mod tests {
    use super::{decode_name, plain_name};

    #[test]
    fn names_have_no_path_in_them() {
        assert_eq!(plain_name("knight_pieces"), "knight_pieces");
        assert_eq!(plain_name("a/b\\c:d"), "a_b_c_d");
        assert_eq!(plain_name(".."), "pieces");
        assert_eq!(plain_name("  "), "pieces");
    }

    #[test]
    fn names_come_back_from_the_header() {
        assert_eq!(decode_name("caf%C3%A9%20model.3mf"), "café model.3mf");
        assert_eq!(decode_name("plain.stl"), "plain.stl");
        assert_eq!(decode_name("50%"), "50%");
    }
}

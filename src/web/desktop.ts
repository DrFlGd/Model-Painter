// The desktop app's own commands (src-tauri/src/lib.rs): the open and save
// dialogs, reading files beside a model, and the file it was opened with.
// In a browser none of this exists and the page uses its file inputs and
// downloads instead.

export const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args as never, headers ? { headers } : undefined);
}

const bytes = (v: unknown): Uint8Array => (v instanceof ArrayBuffer ? new Uint8Array(v) : v instanceof Uint8Array ? v : new Uint8Array(v as number[]));

/** A file's bytes (a full path, '/' or '\'). */
export async function readFile(path: string): Promise<Uint8Array> {
  return bytes(await invoke('read_file', { path }));
}

/** The files near a folder, relative to it: its own tree and its parent's (as '../…'). */
export function listFiles(folder: string): Promise<string[]> {
  return invoke('list_files', { folder });
}

/** Whether a path is a file, a folder, or nothing. */
export function pathKind(path: string): Promise<'file' | 'dir' | 'none'> {
  return invoke('path_kind', { path });
}

/** The system's open dialog; null when cancelled. */
export function pickFile(title: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  return invoke('pick_file', { title, filters });
}

/** Saves bytes where the person picks in a save dialog, starting from `name`. The path, or null when cancelled. */
export function saveFile(name: string, data: Uint8Array): Promise<string | null> {
  return invoke('export_file', data, { 'x-name': encodeURIComponent(name) });
}

/** The model the app was opened with (a file dropped on its icon, or Open with), if any. */
export function startupFile(): Promise<string | null> {
  return invoke('startup_file');
}

/** Calls back with the paths of files dropped on the window. */
export async function onDrop(handler: (paths: string[]) => void, hover: (on: boolean) => void): Promise<void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === 'enter' || p.type === 'over') hover(true);
    else if (p.type === 'leave') hover(false);
    else if (p.type === 'drop') { hover(false); handler(p.paths); }
  });
}

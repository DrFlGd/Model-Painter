// Where a model and the files beside it come from in the page: files dropped
// on the window or chosen (a folder keeps its layout, so a model finds its
// textures in "../textures"), or, in the desktop app, the disk itself.

import { baseName, joinPath, type FileSource } from '../core/model.ts';
import { canOpen } from '../core/import/index.ts';
import { desktop, listFiles, readFile } from './desktop.ts';

/** A file the person gave, with its path inside what they dropped or chose ('' folders when loose). */
export interface GivenFile { path: string; file: File }

const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

/** `to` relative to the folder `from` (both '/'-separated, from the same root). */
export function relativePath(from: string, to: string): string {
  const a = from ? from.split('/') : [], b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

/** A FileSource over files the person gave, the model being one of them. */
export async function givenSource(model: GivenFile, all: GivenFile[]): Promise<FileSource> {
  const byPath = new Map<string, File>();
  for (const f of all) byPath.set(f.path.toLowerCase(), f.file);
  const folder = dirOf(model.path);
  return {
    name: baseName(model.path),
    bytes: new Uint8Array(await model.file.arrayBuffer()),
    async read(rel) {
      const f = byPath.get(joinPath(folder, rel).toLowerCase());
      return f ? new Uint8Array(await f.arrayBuffer()) : null;
    },
    async list() { return all.map((f) => relativePath(folder, f.path)); },
  };
}

/** Every file under what was dropped, folders walked, with paths from the drop. */
export async function droppedFiles(dt: DataTransfer): Promise<GivenFile[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...dt.files].map((file) => ({ path: file.name, file }));
  const out: GivenFile[] = [];
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > 50000) return;
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ path: prefix + e.name, file });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${prefix}${e.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/** Files from a file input (a folder input keeps their paths). */
export function inputFiles(input: HTMLInputElement): GivenFile[] {
  return [...(input.files ?? [])].map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));
}

/** The models among some files, the shallowest first. */
export function modelsAmong(files: GivenFile[]): GivenFile[] {
  return files.filter((f) => canOpen(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
}

/** A FileSource over a model on disk (the desktop app): the folder it is in and its parent's other folders. */
export async function diskSource(path: string): Promise<FileSource> {
  if (!desktop) throw new Error('not the desktop app');
  const norm = path.replace(/\\/g, '/');
  const folder = dirOf(norm);
  const lead = /^\/+/.exec(folder)?.[0] ?? ''; // '/' of a Unix path, '//' of a network share
  let listing: string[] | null = null;
  return {
    name: baseName(norm),
    bytes: await readFile(path),
    async read(rel) {
      try { return await readFile(lead + joinPath(folder.slice(lead.length), rel)); } catch { return null; }
    },
    async list() { return (listing ??= await listFiles(folder)); },
  };
}

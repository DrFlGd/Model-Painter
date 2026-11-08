// A FileSource over a folder on disk, as the desktop app reads one.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { FileSource } from '../../src/core/model.ts';

export function diskSource(file: string): FileSource {
  const folder = dirname(file);
  return {
    name: file.split('/').pop()!,
    bytes: new Uint8Array(readFileSync(file)),
    async read(path) {
      const p = join(folder, path);
      return existsSync(p) && statSync(p).isFile() ? new Uint8Array(readFileSync(p)) : null;
    },
    async list() {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d)) {
          const p = join(d, e);
          if (statSync(p).isDirectory()) walk(p); else out.push(relative(folder, p).split('\\').join('/'));
        }
      };
      walk(folder);
      return out;
    },
  };
}

/** A FileSource over files held in memory. */
export function memorySource(name: string, files: Record<string, Uint8Array | string>): FileSource {
  const enc = new TextEncoder();
  const get = (k: string) => { const v = files[k]; return v === undefined ? null : typeof v === 'string' ? enc.encode(v) : v; };
  return { name, bytes: get(name)!, async read(p) { return get(p); }, async list() { return Object.keys(files); } };
}

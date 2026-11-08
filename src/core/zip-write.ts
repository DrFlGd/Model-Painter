// Writing a zip archive (a 3MF is one), deflated with CompressionStream, a
// file at a time and each in pieces, so a model of millions of triangles is
// never one string or one buffer of text. Pure.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

function crcUpdate(crc: number, b: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry { name: Uint8Array; crc: number; size: number; packed: number; offset: number; method: number }

/** Builds a zip: `add` each file (its pieces as they are made), then `finish`. */
export class ZipWriter {
  private parts: Uint8Array[] = [];
  private entries: Entry[] = [];
  private offset = 0;

  private push(b: Uint8Array) { this.parts.push(b); this.offset += b.length; }

  /** Adds a file from its pieces (strings are written as UTF-8), deflated unless `store`. */
  async add(name: string, pieces: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>, store = false): Promise<void> {
    const enc = new TextEncoder();
    const nameBytes = enc.encode(name);
    let crc = 0, size = 0;
    const chunks: Uint8Array[] = [];
    if (store) {
      for await (const p of pieces) { const b = typeof p === 'string' ? enc.encode(p) : p; crc = crcUpdate(crc, b); size += b.length; chunks.push(b); }
    } else {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      const reading = (async () => {
        const reader = cs.readable.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
      })();
      for await (const p of pieces) {
        const b = typeof p === 'string' ? enc.encode(p) : p;
        crc = crcUpdate(crc, b); size += b.length;
        await writer.write(b as BufferSource);
      }
      await writer.close();
      await reading;
    }
    let packed = 0;
    for (const c of chunks) packed += c.length;
    if (size > 0xfffffffe || this.offset > 0xfffffffe) throw new Error('The file is too big for a zip without its 64-bit extension');
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 names
    dv.setUint16(8, store ? 0 : 8, true);
    dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true); // 1980-01-01
    dv.setUint32(14, crc, true);
    dv.setUint32(18, packed, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    this.entries.push({ name: nameBytes, crc, size, packed, offset: this.offset, method: store ? 0 : 8 });
    this.push(local);
    for (const c of chunks) this.push(c);
  }

  /** The archive, as pieces to save or join. */
  finish(): Uint8Array[] {
    const start = this.offset;
    for (const e of this.entries) {
      const c = new Uint8Array(46 + e.name.length);
      const dv = new DataView(c.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, e.method, true);
      dv.setUint16(12, 0, true); dv.setUint16(14, 0x21, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.packed, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.name.length, true);
      dv.setUint32(42, e.offset, true);
      c.set(e.name, 46);
      this.push(c);
    }
    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, this.entries.length, true);
    dv.setUint16(10, this.entries.length, true);
    dv.setUint32(12, this.offset - start, true);
    dv.setUint32(16, start, true);
    this.push(end);
    return this.parts;
  }
}

/** Joins pieces into one buffer. */
export function join(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

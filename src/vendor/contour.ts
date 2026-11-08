// Vendored from DrFlGd/Print-Factory (MIT, see LICENSE-print-factory in this folder), adapted to this repo's imports.
/**
 * Contours: closed outlines stored flat as [x0, y0, x1, y1, …], implicitly closed.
 *
 * Flat arrays rather than point objects because contours cross into workers and into
 * WebAssembly by the thousand, and a Float64-friendly flat list clones and converts fastest.
 * Counter-clockwise is "outside", clockwise is a hole, matching Manifold's Positive rule.
 */
/** A closed outline stored flat as [x0, y0, x1, y1, …]. */
export type Contour = number[];
export type RGB = [number, number, number];

export interface Rect2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function pointCount(c: Contour): number {
  return c.length >> 1;
}

/** Signed area: positive for counter-clockwise. */
export function signedArea(c: Contour): number {
  let a = 0;
  const n = c.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += c[i]! * c[j + 1]! - c[j]! * c[i + 1]!;
  }
  return a / 2;
}

export function area(contours: Contour[]): number {
  return contours.reduce((s, c) => s + signedArea(c), 0);
}

export function reverse(c: Contour): Contour {
  const out: number[] = new Array(c.length);
  const n = c.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = c[(n - 1 - i) * 2]!;
    out[i * 2 + 1] = c[(n - 1 - i) * 2 + 1]!;
  }
  return out;
}

/** The contour wound counter-clockwise (ccw = true) or clockwise. */
export function orient(c: Contour, ccw = true): Contour {
  return signedArea(c) >= 0 === ccw ? c : reverse(c);
}

export function emptyRect(): Rect2 {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function bounds(contours: Contour[] | Contour, into: Rect2 = emptyRect()): Rect2 {
  const list = isSingle(contours) ? [contours] : contours;
  for (const c of list) {
    for (let i = 0; i < c.length; i += 2) {
      const x = c[i]!;
      const y = c[i + 1]!;
      if (x < into.minX) into.minX = x;
      if (x > into.maxX) into.maxX = x;
      if (y < into.minY) into.minY = y;
      if (y > into.maxY) into.maxY = y;
    }
  }
  return into;
}

export function rectSize(r: Rect2): { width: number; height: number; cx: number; cy: number } {
  if (!isFinite(r.minX)) return { width: 0, height: 0, cx: 0, cy: 0 };
  return { width: r.maxX - r.minX, height: r.maxY - r.minY, cx: (r.minX + r.maxX) / 2, cy: (r.minY + r.maxY) / 2 };
}

function isSingle(x: Contour[] | Contour): x is Contour {
  return x.length === 0 || typeof x[0] === 'number';
}

/** Applies an affine map [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (SVG order). */
export function transform(contours: Contour[], m: readonly number[]): Contour[] {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const flips = a * d - b * c < 0;
  return contours.map((src) => {
    const out: number[] = new Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      const x = src[i]!;
      const y = src[i + 1]!;
      out[i] = a * x + c * y + e;
      out[i + 1] = b * x + d * y + f;
    }
    // A mirror turns every contour inside out; put the winding back.
    return flips ? reverse(out) : out;
  });
}

export const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

export function multiply(m: readonly number[], n: readonly number[]): number[] {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const [A, B, C, D, E, F] = n as [number, number, number, number, number, number];
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
}

export function translate(contours: Contour[], dx: number, dy: number): Contour[] {
  return transform(contours, [1, 0, 0, 1, dx, dy]);
}

export function scale(contours: Contour[], sx: number, sy = sx): Contour[] {
  return transform(contours, [sx, 0, 0, sy, 0, 0]);
}

/** Rotates by `deg` degrees counter-clockwise about (cx, cy). */
export function rotate(contours: Contour[], deg: number, cx = 0, cy = 0): Contour[] {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return transform(contours, [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]);
}

export function mirrorX(contours: Contour[], axis = 0): Contour[] {
  return transform(contours, [-1, 0, 0, 1, 2 * axis, 0]);
}

/** Moves the shapes so their bounding box is centred on (cx, cy). */
export function centerOn(contours: Contour[], cx = 0, cy = 0): Contour[] {
  const s = rectSize(bounds(contours));
  return translate(contours, cx - s.cx, cy - s.cy);
}

/**
 * Scales uniformly so the bounding box fits inside width × height, then centres it on the
 * origin. Returns the shapes and the scale used.
 */
export function fitInto(contours: Contour[], width: number, height: number): { contours: Contour[]; scale: number } {
  const s = rectSize(bounds(contours));
  if (s.width === 0 || s.height === 0) return { contours, scale: 1 };
  const k = Math.min(width / s.width, height / s.height);
  return { contours: transform(contours, [k, 0, 0, k, -s.cx * k, -s.cy * k]), scale: k };
}

/** Even-odd point test against a set of contours. */
export function pointInside(contours: Contour[], x: number, y: number): boolean {
  let inside = false;
  for (const c of contours) {
    const n = c.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const xi = c[i]!;
      const yi = c[i + 1]!;
      const xj = c[j]!;
      const yj = c[j + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Area-weighted centroid of one contour. */
export function centroid(c: Contour): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = c.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const cross = c[i]! * c[j + 1]! - c[j]! * c[i + 1]!;
    a += cross;
    cx += (c[i]! + c[j]!) * cross;
    cy += (c[i + 1]! + c[j + 1]!) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    const b = rectSize(bounds(c));
    return [b.cx, b.cy];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * Drops points closer than `eps` to the previous one, including the wrap-around.
 *
 * A closed outline that repeats its first point, or carries zero-length edges, becomes
 * zero-area slivers once extruded; enough of them tear a mesh.
 */
export function weld(c: Contour, eps = 1e-4): Contour {
  const out: number[] = [];
  for (let i = 0; i < c.length; i += 2) {
    const x = c[i]!;
    const y = c[i + 1]!;
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2]! - x) < eps && Math.abs(out[n - 1]! - y) < eps) continue;
    out.push(x, y);
  }
  while (out.length >= 4 && Math.abs(out[0]! - out[out.length - 2]!) < eps && Math.abs(out[1]! - out[out.length - 1]!) < eps) {
    out.length -= 2;
  }
  return out;
}

/** Removes degenerate contours (fewer than 3 points or nearly no area). */
export function clean(contours: Contour[], minArea = 1e-6): Contour[] {
  return contours.map((c) => weld(c)).filter((c) => c.length >= 6 && Math.abs(signedArea(c)) > minArea);
}

function perpDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  if (len === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ramer–Douglas–Peucker on a closed contour. */
export function simplify(c: Contour, tolerance: number): Contour {
  const n = c.length / 2;
  if (n <= 4 || tolerance <= 0) return c.slice();
  // Split the ring at its two most distant points so both halves are open polylines.
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(c[i * 2]! - c[0]!, c[i * 2 + 1]! - c[1]!);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const ei = e % n;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistance(c[i * 2]!, c[i * 2 + 1]!, c[s * 2]!, c[s * 2 + 1]!, c[ei * 2]!, c[ei * 2 + 1]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(c[i * 2]!, c[i * 2 + 1]!);
  return out.length >= 6 ? out : c.slice();
}

export function perimeter(c: Contour): number {
  let p = 0;
  for (let i = 0; i < c.length; i += 2) {
    const j = (i + 2) % c.length;
    p += Math.hypot(c[j]! - c[i]!, c[j + 1]! - c[i + 1]!);
  }
  return p;
}

/**
 * A point at distance `t` (0..1 of the perimeter) along the contour, with the outward
 * normal there. Used to slide a keychain loop round an outline.
 */
export function pointAlong(c: Contour, t: number): { x: number; y: number; nx: number; ny: number } {
  const total = perimeter(c);
  let target = (((t % 1) + 1) % 1) * total;
  const ccw = signedArea(c) >= 0;
  for (let i = 0; i < c.length; i += 2) {
    const j = (i + 2) % c.length;
    const dx = c[j]! - c[i]!;
    const dy = c[j + 1]! - c[i + 1]!;
    const len = Math.hypot(dx, dy);
    if (target <= len || j === 0) {
      const k = len > 0 ? Math.min(1, target / len) : 0;
      const nx = len > 0 ? (ccw ? dy : -dy) / len : 0;
      const ny = len > 0 ? (ccw ? -dx : dx) / len : 0;
      return { x: c[i]! + dx * k, y: c[i + 1]! + dy * k, nx, ny };
    }
    target -= len;
  }
  return { x: c[0] ?? 0, y: c[1] ?? 0, nx: 0, ny: 1 };
}

/** Nests contours into islands: each outer contour with the holes directly inside it. */
export function islands(contours: Contour[]): { outer: Contour; holes: Contour[] }[] {
  const items = contours
    .map((c) => ({ c, a: Math.abs(signedArea(c)) }))
    .filter((x) => x.a > 0)
    .sort((p, q) => q.a - p.a);
  // depth = how many larger contours contain this one
  const depth = items.map((it, i) => {
    let d = 0;
    for (let j = 0; j < i; j++) if (pointInside([items[j]!.c], it.c[0]!, it.c[1]!)) d++;
    return d;
  });
  const result: { outer: Contour; holes: Contour[] }[] = [];
  items.forEach((it, i) => {
    if (depth[i]! % 2 === 0) result.push({ outer: orient(it.c, true), holes: [] });
  });
  items.forEach((it, i) => {
    if (depth[i]! % 2 === 1) {
      // the smallest even-depth contour containing it
      for (let k = result.length - 1; k >= 0; k--) {
        if (pointInside([result[k]!.outer], it.c[0]!, it.c[1]!)) {
          result[k]!.holes.push(orient(it.c, false));
          break;
        }
      }
    }
  });
  return result;
}

/** Converts [[x, y], …] point lists to flat contours and back. */
export function fromPoints(points: readonly (readonly [number, number])[]): Contour {
  const out: number[] = [];
  for (const [x, y] of points) out.push(x, y);
  return out;
}

export function toPoints(c: Contour): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < c.length; i += 2) out.push([c[i]!, c[i + 1]!]);
  return out;
}

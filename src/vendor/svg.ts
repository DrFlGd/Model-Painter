// Vendored from DrFlGd/Print-Factory (MIT, see LICENSE-print-factory in this folder), adapted to this repo's imports.
/**
 * SVG to contours, without a DOM.
 *
 * Runs in workers and in Node as well as on the page, so it parses the markup itself: a
 * small tolerant tag scanner, the element shapes generators meet in practice (path, rect,
 * circle, ellipse, polygon, polyline, line), nested group transforms, the viewBox, and fill
 * colours and rules. Curves and arcs are flattened to a chord tolerance.
 *
 * The output is in the SVG's own user units with Y flipped to point up, so a drawing reads
 * the right way round in millimetres; callers scale it to the size they want.
 */
import { IDENTITY, multiply, transform, type Contour } from './contour.ts';

export interface SvgShape {
  contours: Contour[];
  /** The fill as written ("#ff0000", "red", "none", or undefined for the default black). */
  fill?: string;
  fillRule: 'nonzero' | 'evenodd';
  /** The element's id or its closest group's, for picking one layer of a drawing. */
  id?: string;
}

export interface SvgDocument {
  shapes: SvgShape[];
  /** viewBox, or the width and height attributes, or the shapes' bounds. */
  viewBox: [number, number, number, number];
}

// ───────────────────────────── path data ─────────────────────────────

const ARG_COUNT: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * Splits path data into commands and numbers. Arc flags (the 4th and 5th arguments of
 * each arc) are single digits that SVG allows to be written glued together ("a1 1 0 00 10
 * 10"), so inside an arc they are read one character at a time.
 */
function tokenizePath(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;
  let i = 0;
  let cmd = '';
  let argIndex = 0;
  while (i < d.length) {
    const c = d[i]!;
    if (/[\s,]/.test(c)) {
      i++;
      continue;
    }
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      out.push(c);
      cmd = c.toLowerCase();
      argIndex = 0;
      i++;
      continue;
    }
    if (cmd === 'a' && (argIndex % 7 === 3 || argIndex % 7 === 4) && (c === '0' || c === '1')) {
      out.push(Number(c));
      argIndex++;
      i++;
      continue;
    }
    const m = num.exec(d.slice(i));
    if (!m) {
      i++;
      continue;
    }
    out.push(Number(m[0]));
    argIndex++;
    i += m[0].length;
  }
  return out;
}

export function flattenCubic(out: number[], x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tol: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  const n = Math.max(2, Math.min(200, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-6)) * 1.2)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const e = t * t * t;
    out.push(a * x0 + b * x1 + c * x2 + e * x3, a * y0 + b * y1 + c * y2 + e * y3);
  }
}

export function flattenQuad(out: number[], x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, tol: number): void {
  flattenCubic(out, x0, y0, x0 + (2 / 3) * (x1 - x0), y0 + (2 / 3) * (y1 - y0), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2, tol);
}

export function flattenArc(out: number[], x0: number, y0: number, rxIn: number, ryIn: number, phiDeg: number, large: number, sweep: number, x: number, y: number, tol: number): void {
  if (x0 === x && y0 === y) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    out.push(x, y);
    return;
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const r = Math.max(rx, ry);
  const step = 2 * Math.acos(Math.max(-1, 1 - Math.max(tol, 1e-6) / r));
  const n = Math.max(2, Math.min(360, Math.ceil(Math.abs(dt) / Math.max(step, 1e-3))));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const px = rx * Math.cos(t);
    const py = ry * Math.sin(t);
    out.push(cos * px - sin * py + cx, sin * px + cos * py + cy);
  }
}

/**
 * Path data to contours, in the path's own coordinates (Y down, as SVG has it). Open
 * subpaths are closed: generators fill what they read.
 */
export function pathToContours(d: string, tolerance = 0.05): Contour[] {
  const contours: Contour[] = [];
  let cur: number[] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let lastCmd = '';
  const finish = () => {
    if (cur.length >= 6) contours.push(cur);
    cur = [];
  };
  const list = tokenizePath(d);
  let i = 0;
  let cmd = '';
  while (i < list.length) {
    const t = list[i]!;
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'z' || cmd === 'Z') {
        finish();
        x = sx;
        y = sy;
        lastCmd = 'z';
        continue;
      }
    } else if (!cmd) {
      i++;
      continue;
    }
    const lower = cmd.toLowerCase();
    const n = ARG_COUNT[lower] ?? 0;
    if (n === 0) continue;
    const args = list.slice(i, i + n);
    if (args.length < n || args.some((a) => typeof a !== 'number')) break;
    i += n;
    const a = args as number[];
    const rel = cmd === lower;
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (lower) {
      case 'm':
        finish();
        x = a[0]! + ox;
        y = a[1]! + oy;
        sx = x;
        sy = y;
        cur.push(x, y);
        // further pairs after a moveto are linetos
        cmd = rel ? 'l' : 'L';
        break;
      case 'l':
        x = a[0]! + ox;
        y = a[1]! + oy;
        cur.push(x, y);
        break;
      case 'h':
        x = a[0]! + ox;
        cur.push(x, y);
        break;
      case 'v':
        y = a[0]! + oy;
        cur.push(x, y);
        break;
      case 'c': {
        const [x1, y1, x2, y2, ex, ey] = [a[0]! + ox, a[1]! + oy, a[2]! + ox, a[3]! + oy, a[4]! + ox, a[5]! + oy];
        if (!cur.length) cur.push(x, y);
        flattenCubic(cur, x, y, x1, y1, x2, y2, ex, ey, tolerance);
        lastCtrlX = x2;
        lastCtrlY = y2;
        x = ex;
        y = ey;
        break;
      }
      case 's': {
        const reflect = 'cs'.includes(lastCmd);
        const x1 = reflect ? 2 * x - lastCtrlX : x;
        const y1 = reflect ? 2 * y - lastCtrlY : y;
        const [x2, y2, ex, ey] = [a[0]! + ox, a[1]! + oy, a[2]! + ox, a[3]! + oy];
        if (!cur.length) cur.push(x, y);
        flattenCubic(cur, x, y, x1, y1, x2, y2, ex, ey, tolerance);
        lastCtrlX = x2;
        lastCtrlY = y2;
        x = ex;
        y = ey;
        break;
      }
      case 'q': {
        const [x1, y1, ex, ey] = [a[0]! + ox, a[1]! + oy, a[2]! + ox, a[3]! + oy];
        if (!cur.length) cur.push(x, y);
        flattenQuad(cur, x, y, x1, y1, ex, ey, tolerance);
        lastCtrlX = x1;
        lastCtrlY = y1;
        x = ex;
        y = ey;
        break;
      }
      case 't': {
        const reflect = 'qt'.includes(lastCmd);
        const x1 = reflect ? 2 * x - lastCtrlX : x;
        const y1 = reflect ? 2 * y - lastCtrlY : y;
        const [ex, ey] = [a[0]! + ox, a[1]! + oy];
        if (!cur.length) cur.push(x, y);
        flattenQuad(cur, x, y, x1, y1, ex, ey, tolerance);
        lastCtrlX = x1;
        lastCtrlY = y1;
        x = ex;
        y = ey;
        break;
      }
      case 'a': {
        const [ex, ey] = [a[5]! + ox, a[6]! + oy];
        if (!cur.length) cur.push(x, y);
        flattenArc(cur, x, y, a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, ex, ey, tolerance);
        x = ex;
        y = ey;
        break;
      }
    }
    lastCmd = lower;
  }
  finish();
  // A closing point equal to the start is implicit in a contour.
  return contours.map((c) => {
    const n = c.length;
    if (n >= 4 && Math.abs(c[0]! - c[n - 2]!) < 1e-9 && Math.abs(c[1]! - c[n - 1]!) < 1e-9) return c.slice(0, n - 2);
    return c;
  });
}

// ───────────────────────────── documents ─────────────────────────────

interface Tag {
  name: string;
  attrs: Record<string, string>;
  close: boolean;
  selfClose: boolean;
}

function* scanTags(src: string): Generator<Tag> {
  // drop comments, CDATA and processing instructions first
  const text = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attrs: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[3] ?? ''))) attrs[a[1]!] = a[2] ?? a[3] ?? '';
    yield { name: m[2]!.replace(/^svg:/, ''), attrs, close: m[1] === '/', selfClose: m[4] === '/' };
  }
}

function numbers(s: string | undefined): number[] {
  if (!s) return [];
  return (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

function len(s: string | undefined, fallback = 0): number {
  if (s === undefined) return fallback;
  const n = parseFloat(s);
  if (!isFinite(n)) return fallback;
  if (/mm$/.test(s)) return n;
  if (/cm$/.test(s)) return n * 10;
  if (/in$/.test(s)) return n * 25.4;
  if (/pt$/.test(s)) return (n * 25.4) / 72;
  return n;
}

/** Parses a transform attribute into one matrix. */
export function parseTransform(s: string | undefined): number[] {
  let m: number[] = [...IDENTITY];
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(s))) {
    const a = numbers(t[2]);
    let n: number[];
    switch (t[1]) {
      case 'matrix':
        n = a.length === 6 ? a : [...IDENTITY];
        break;
      case 'translate':
        n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case 'scale':
        n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(r);
        const sn = Math.sin(r);
        const cx = a[1] ?? 0;
        const cy = a[2] ?? 0;
        n = [c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy];
        break;
      }
      case 'skewX':
        n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = multiply(m, n);
  }
  return m;
}

function styleProp(attrs: Record<string, string>, prop: string): string | undefined {
  const style = attrs.style;
  if (style) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(style);
    if (m) return m[1]!.trim();
  }
  return attrs[prop];
}

function elementContours(name: string, a: Record<string, string>, tol: number): Contour[] {
  switch (name) {
    case 'path':
      return pathToContours(a.d ?? '', tol);
    case 'rect': {
      const x = len(a.x);
      const y = len(a.y);
      const w = len(a.width);
      const h = len(a.height);
      if (w <= 0 || h <= 0) return [];
      let rx = a.rx !== undefined ? len(a.rx) : a.ry !== undefined ? len(a.ry) : 0;
      let ry = a.ry !== undefined ? len(a.ry) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx <= 0 || ry <= 0) return [[x, y, x + w, y, x + w, y + h, x, y + h]];
      const d = `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
      return pathToContours(d, tol);
    }
    case 'circle':
    case 'ellipse': {
      const cx = len(a.cx);
      const cy = len(a.cy);
      const rx = name === 'circle' ? len(a.r) : len(a.rx);
      const ry = name === 'circle' ? len(a.r) : len(a.ry);
      if (rx <= 0 || ry <= 0) return [];
      const n = Math.max(24, Math.min(256, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / Math.max(0.2, Math.sqrt(8 * Math.max(rx, ry) * tol)))));
      const c: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        c.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry);
      }
      return [c];
    }
    case 'polygon':
    case 'polyline': {
      const p = numbers(a.points);
      return p.length >= 6 ? [p.slice(0, p.length - (p.length % 2))] : [];
    }
    default:
      return [];
  }
}

/**
 * Reads every filled shape in an SVG document. `tolerance` is the chord error in the
 * document's user units.
 */
export function parseSvg(src: string, tolerance = 0.05): SvgDocument {
  const stack: { m: number[]; fill?: string; rule?: string; id?: string; hidden: boolean }[] = [{ m: [...IDENTITY], hidden: false }];
  const shapes: SvgShape[] = [];
  let viewBox: [number, number, number, number] | undefined;
  let skipDepth = 0;
  const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'title', 'desc', 'metadata', 'style', 'linearGradient', 'radialGradient', 'filter']);
  for (const tag of scanTags(src)) {
    if (tag.close) {
      if (skipDepth > 0) {
        if (SKIP.has(tag.name)) skipDepth--;
        continue;
      }
      if (tag.name === 'g' || tag.name === 'svg' || tag.name === 'a') stack.pop();
      continue;
    }
    if (skipDepth > 0) {
      if (SKIP.has(tag.name) && !tag.selfClose) skipDepth++;
      continue;
    }
    if (SKIP.has(tag.name)) {
      if (!tag.selfClose) skipDepth = 1;
      continue;
    }
    const parent = stack[stack.length - 1]!;
    const a = tag.attrs;
    const display = styleProp(a, 'display');
    const visibility = styleProp(a, 'visibility');
    const hidden = parent.hidden || display === 'none' || visibility === 'hidden';
    const m = multiply(parent.m, parseTransform(a.transform));
    const fill = styleProp(a, 'fill') ?? parent.fill;
    const rule = styleProp(a, 'fill-rule') ?? parent.rule;
    const id = a.id ?? parent.id;
    if (tag.name === 'svg') {
      if (!viewBox) {
        const vb = numbers(a.viewBox);
        if (vb.length === 4) viewBox = [vb[0]!, vb[1]!, vb[2]!, vb[3]!];
        else if (a.width && a.height) viewBox = [0, 0, len(a.width), len(a.height)];
      }
      if (!tag.selfClose) stack.push({ m, fill, rule, id, hidden });
      continue;
    }
    if (tag.name === 'g' || tag.name === 'a') {
      if (!tag.selfClose) stack.push({ m, fill, rule, id, hidden });
      continue;
    }
    if (hidden || fill === 'none') continue;
    const contours = elementContours(tag.name, a, tolerance);
    if (!contours.length) continue;
    shapes.push({ contours: transform(contours, m), fill, fillRule: rule === 'evenodd' ? 'evenodd' : 'nonzero', id });
  }
  if (!viewBox) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of shapes)
      for (const c of s.contours)
        for (let i = 0; i < c.length; i += 2) {
          minX = Math.min(minX, c[i]!);
          maxX = Math.max(maxX, c[i]!);
          minY = Math.min(minY, c[i + 1]!);
          maxY = Math.max(maxY, c[i + 1]!);
        }
    viewBox = isFinite(minX) ? [minX, minY, maxX - minX, maxY - minY] : [0, 0, 0, 0];
  }
  // Flip Y about the viewBox so the drawing is upright in a Y-up world.
  const [, vy, , vh] = viewBox;
  const flip = [1, 0, 0, -1, 0, 2 * vy + vh];
  for (const s of shapes) s.contours = transform(s.contours, flip);
  return { shapes, viewBox };
}

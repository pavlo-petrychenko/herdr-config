// Images in the viewer, as plain data. Pure: the mod uses it, plain node tests it.
//
// gpui-kit draws `image(path)` only from under the Herdr home, so the mod copies a shown image to
// <appHome>/data/file-viewer/images/<terminal>/<name> and draws the copy. The name holds a hash of
// the path, the modification time and the size: a changed file gets a new name, so a stale
// picture is never drawn. Each viewer owns the folder of its terminal and keeps in it only the
// copies of its open tabs.

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export const isImage = (path) => EXT.test(path);
export const isSvg = (path) => /\.svg$/i.test(path);

/** The image cache folder of one terminal, relative to the app home (what `image()` takes). */
export const imageDir = (stateFileBase) => `data/file-viewer/images/${stateFileBase}`;

/** 16 hex digits: two 32-bit FNV-1a hashes with different seeds (no BigInt, no crypto needed). */
export function hash(text) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The copy's file name: same file at the same time and size → same name. */
export function cacheName(path, mtime, size) {
  const ext = (path.match(EXT)?.[1] ?? "img").toLowerCase().replace("jpeg", "jpg");
  return `${hash(`2\0${path}\0${mtime}\0${size}`)}.${ext}`;
}

/** `stat -f "%z %m"` → { size, mtime } (bytes, seconds), or null. */
export function parseStat(out) {
  const m = String(out ?? "").trim().match(/^(\d+)\s+(\d+)$/);
  return m ? { size: Number(m[1]), mtime: Number(m[2]) } : null;
}

/** `sips -g pixelWidth -g pixelHeight` → { w, h }, or null. */
export function parseSips(out) {
  const w = String(out ?? "").match(/pixelWidth:\s*(\d+)/);
  const h = String(out ?? "").match(/pixelHeight:\s*(\d+)/);
  return w && h && Number(w[1]) > 0 && Number(h[1]) > 0 ? { w: Number(w[1]), h: Number(h[1]) } : null;
}

/** An SVG's size from its root tag: width and height, else the viewBox. null when it has neither. */
export function svgSize(text) {
  const tag = String(text ?? "").match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const attr = (name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const num = (v) => {
    const m = String(v ?? "").trim().match(/^([\d.]+)\s*(px|pt)?$/i);
    return m && Number(m[1]) > 0 ? Number(m[1]) : null;
  };
  const w = num(attr("width"));
  const h = num(attr("height"));
  if (w && h) return { w, h };
  const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (vb?.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (w) return { w, h: (w * vb[3]) / vb[2] };
    if (h) return { w: (h * vb[2]) / vb[3], h };
    return { w: vb[2], h: vb[3] };
  }
  return null;
}

export const SVG_RASTER = 2048;

/**
 * The same SVG drawn `width` pixels wide: gpui-kit makes a bitmap of an SVG at its own size, so a
 * 24 px icon would be a blurry blob when it fills the pane. Width and height are replaced and the
 * viewBox is kept (or made from the old size). null when the root tag or its size is unknown.
 */
export function scaleSvg(text, width) {
  const natural = svgSize(text);
  const m = String(text ?? "").match(/<svg\b[^>]*>/i);
  if (!natural || !m) return null;
  let tag = m[0].replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
  const hasBox = /\sviewBox\s*=/i.test(tag);
  const add = ` width="${Math.round(width)}" height="${Math.round((width * natural.h) / natural.w)}"${hasBox ? "" : ` viewBox="0 0 ${natural.w} ${natural.h}"`}`;
  tag = tag.replace(/\s*\/?>$/, (end) => `${add}${end.trim() === "/>" ? "/>" : ">"}`);
  return text.slice(0, m.index) + tag + text.slice(m.index + m[0].length);
}

/**
 * The size to draw at: the natural size, or narrower to fit `avail` pixels of width (aspect kept).
 * `grow`: fit the width even above the natural size (an SVG, which has no pixels to blur).
 * `actual`: the natural size, whatever the width.
 */
export function fitSize(natural, avail, { grow = false, actual = false } = {}) {
  const { w, h } = natural;
  const room = Math.max(1, Math.floor(avail));
  const width = actual ? w : grow ? room : Math.min(w, room);
  return { w: width, h: (width * h) / w };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** "name · 3024 × 1698 · 1.2 MB" */
export function caption(name, size, natural) {
  return [name, natural ? `${Math.round(natural.w)} × ${Math.round(natural.h)}` : null, formatBytes(size)].filter(Boolean).join(" · ");
}

/** Files in a terminal's cache folder to delete: everything its open tabs no longer use. */
export function pruneList(files, keep) {
  const kept = new Set(keep);
  return files.filter((f) => f && !kept.has(f) && /^[\w.-]+$/.test(f) && f !== "." && f !== "..");
}

/**
 * Cache folders to delete: those of a terminal whose viewer has no tabs left (or no state file).
 * `states`: folder name → parsed state or null. `own`: the folder this viewer uses.
 */
export function orphanDirs(dirs, states, own) {
  return dirs.filter((d) => d !== own && /^[\w.-]+$/.test(d) && d !== "." && d !== ".." && !(states[d]?.tabs?.length));
}

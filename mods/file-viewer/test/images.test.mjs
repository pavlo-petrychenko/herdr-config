import { test } from "node:test";
import assert from "node:assert/strict";
import { isImage, isSvg, cacheName, hash, parseStat, parseSips, svgSize, scaleSvg, fitSize, formatBytes, caption, pruneList, orphanDirs, imageDir } from "../images.js";

test("extension: png, jpg, jpeg, gif, webp, svg in any case; nothing else", () => {
  for (const f of ["/a/b.png", "/a/B.PNG", "/a/x.jpg", "/a/x.JPEG", "/a/x.gif", "/a/x.webp", "/a/x.svg"]) assert.ok(isImage(f), f);
  for (const f of ["/a/b.png.txt", "/a/b.pngx", "/a/png", "/a/b.md", "/a/b.ico", "/a/b.png/c"]) assert.ok(!isImage(f), f);
  assert.ok(isSvg("/a/x.SVG"));
  assert.ok(!isSvg("/a/x.png"));
});

test("cache name: stable, changes with path, time and size, keeps the extension", () => {
  const a = cacheName("/tmp/a.png", 100, 5);
  assert.match(a, /^[0-9a-f]{16}\.png$/);
  assert.equal(a, cacheName("/tmp/a.png", 100, 5));
  assert.notEqual(a, cacheName("/tmp/b.png", 100, 5));
  assert.notEqual(a, cacheName("/tmp/a.png", 101, 5));
  assert.notEqual(a, cacheName("/tmp/a.png", 100, 6));
  assert.match(cacheName("/x/Y.JPEG", 1, 1), /\.jpg$/);
  assert.match(cacheName("/x/y.svg", 1, 1), /\.svg$/);
  // no path-like characters: safe as a file name
  assert.match(cacheName("/x/../y z.webp", 1, 1), /^[\w.]+$/);
  assert.equal(hash("").length, 16);
});

test("stat and sips output", () => {
  assert.deepEqual(parseStat("1234 1700000000\n"), { size: 1234, mtime: 1700000000 });
  assert.equal(parseStat("stat: nope"), null);
  assert.deepEqual(parseSips("/a.png\n  pixelWidth: 3024\n  pixelHeight: 1698\n"), { w: 3024, h: 1698 });
  assert.equal(parseSips("/a.png\n  pixelWidth: 0\n  pixelHeight: 5\n"), null);
  assert.equal(parseSips("Error 4: not a valid file"), null);
});

test("svg size: width and height, units, viewBox, none", () => {
  assert.deepEqual(svgSize('<svg xmlns="x" width="24" height="24" viewBox="0 0 48 48">'), { w: 24, h: 24 });
  assert.deepEqual(svgSize('<?xml version="1.0"?>\n<svg width="10px" height="20pt">'), { w: 10, h: 20 });
  assert.deepEqual(svgSize("<svg viewBox='0 0 100 50'>"), { w: 100, h: 50 });
  assert.deepEqual(svgSize('<svg width="200" viewBox="0 0 100 50">'), { w: 200, h: 100 });
  assert.equal(svgSize('<svg width="100%" height="100%">'), null);
  assert.equal(svgSize("not svg"), null);
  assert.equal(svgSize(null), null);
});

test("fit: never above natural size, aspect kept; svg grows; 100% ignores the width", () => {
  const n = { w: 3000, h: 1500 };
  assert.deepEqual(fitSize(n, 600), { w: 600, h: 300 });
  assert.deepEqual(fitSize({ w: 200, h: 100 }, 600), { w: 200, h: 100 });
  assert.deepEqual(fitSize({ w: 24, h: 12 }, 600, { grow: true }), { w: 600, h: 300 });
  assert.deepEqual(fitSize(n, 600, { actual: true }), { w: 3000, h: 1500 });
  assert.deepEqual(fitSize(n, 0), { w: 1, h: 0.5 });
});

test("sizes and caption", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(300 * 1024), "300 KB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
  assert.equal(formatBytes(40 * 1024 * 1024), "40 MB");
  assert.equal(caption("a.png", 2048, { w: 10.2, h: 20 }), "a.png · 10 × 20 · 2.0 KB");
  assert.equal(caption("a.svg", 2048, null), "a.svg · 2.0 KB");
});

test("prune: keeps the open tabs' copies, drops the rest, never odd names", () => {
  assert.deepEqual(pruneList(["a.png", "b.png", "c.jpg"], ["b.png"]), ["a.png", "c.jpg"]);
  assert.deepEqual(pruneList(["a.png"], ["a.png"]), []);
  assert.deepEqual(pruneList(["a.png"], []), ["a.png"]);
  assert.deepEqual(pruneList([".", "..", "a b.png", "x/y.png"], []), []);
});

test("sweep: folders of viewers without tabs go, this viewer's own and busy ones stay", () => {
  const states = { m1_t1: { tabs: [{ path: "/a" }] }, m1_t2: { tabs: [] }, m1_t4: null };
  assert.deepEqual(orphanDirs(["m1_t1", "m1_t2", "m1_t3", "m1_t4", "own"], states, "own"), ["m1_t2", "m1_t3", "m1_t4"]);
  assert.deepEqual(orphanDirs(["..", "a b"], {}, "x"), []);
  assert.equal(imageDir("m1_t1"), "data/file-viewer/images/m1_t1");
});

test("scale svg: width and height replaced, viewBox kept or made, other attributes kept", () => {
  const a = scaleSvg('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12" viewBox="0 0 48 24" stroke-width="2"><path stroke-width="1"/></svg>', 2048);
  assert.equal(a, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24" stroke-width="2" width="2048" height="1024"><path stroke-width="1"/></svg>');
  assert.deepEqual(svgSize(a), { w: 2048, h: 1024 });
  const b = scaleSvg('<?xml version="1.0"?><svg width="10" height="20"/>', 100);
  assert.equal(b, '<?xml version="1.0"?><svg width="100" height="200" viewBox="0 0 10 20"/>');
  assert.equal(scaleSvg('<svg width="100%">', 100), null);
  assert.equal(scaleSvg("nope", 100), null);
});

// `gh pr diff` output -> files -> lines the view draws. Pure (no Herdr imports).

/**
 * A unified diff -> [{ path, oldPath, kind: "added" | "deleted" | "renamed" | "modified", binary,
 *   lines: [{ kind: "hunk" | "add" | "del" | "ctx", text, old, new }] }].
 * `old` / `new`: the line numbers on each side (null where the line has none).
 */
export function parseDiff(text) {
  const files = [];
  let f = null, o = 0, n = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      f = { path: m?.[2] ?? line.slice(11), oldPath: m?.[1] ?? "", kind: "modified", binary: false, lines: [] };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (line.startsWith("new file mode")) { f.kind = "added"; continue; }
    if (line.startsWith("deleted file mode")) { f.kind = "deleted"; continue; }
    if (line.startsWith("rename from ")) { f.kind = "renamed"; f.oldPath = line.slice(12); continue; }
    if (line.startsWith("rename to ")) { f.path = line.slice(10); continue; }
    if (line.startsWith("Binary files ")) { f.binary = true; continue; }
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("similarity index")) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = Number(h[1]); n = Number(h[2]);
      f.lines.push({ kind: "hunk", text: line, old: null, new: null, context: h[3].trim() });
      continue;
    }
    if (line.startsWith("+")) f.lines.push({ kind: "add", text: line.slice(1), old: null, new: n++ });
    else if (line.startsWith("-")) f.lines.push({ kind: "del", text: line.slice(1), old: o++, new: null });
    else if (line.startsWith(" ")) f.lines.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++ });
    else if (line.startsWith("\\")) continue; // "\ No newline at end of file"
  }
  return files;
}

/** Tabs -> spaces, so columns line up in the code font. */
export const untab = (s) => String(s).replace(/\t/g, "    ");

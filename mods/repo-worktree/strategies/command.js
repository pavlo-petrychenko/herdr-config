// A repo's own worktree command (`make worktree ...`), run in a new space's terminal.
//
// With `background` (the default) the space is made without switching to it. Its terminal
// reports to Herdr like an agent (OSC 7501): "working" while the command runs, "done" when
// the checkout is ready (Herdr's own "<name> finished" toast, the Agents list), "blocked" when
// it failed. Then the terminal moves into the checkout and starts the agent.
//
// Options (in repo-worktree.json):
//   fields      the dialog's inputs (see strategies/index.js). Default: one required "name".
//   path        where the checkout lands: "{repo.parent}/website-{name:slug}". Required.
//   run         the shell command that creates it. Values are shell-quoted. Required.
//   cwd         where `run` runs. Default "{repo.main}".
//   space       the space's name. Default: the last folder of `path`.
//   background  true (default): stay where you are; Herdr notifies you when it is ready.
//   after       a shell command run inside the new checkout before the agent. Optional.
//   agent       argv started in the checkout at the end: ["claude"]. Optional.
//   nonZeroExit "fail" (default) or "warn-if-created": a failed `run` that still left a
//               checkout at `path` is a warning, not a failure.
//   shell       the shell that runs it all. Default "/bin/sh".

import { placeholders, render, shellQuote } from "../template.js";

const CONTEXT = ["repo.main", "repo.parent", "repo.name", "repo.top", "home"];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_FIELDS = [{ name: "name", label: "Name", required: true, type: "branch" }];

const fieldsOf = (o) => o.fields ?? DEFAULT_FIELDS;
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// What Herdr shows as the job's name ("<app> finished"): a safe word, like Claude Code's own ids.
const appName = (s) => s.replace(/[^A-Za-z0-9_.+-]/g, "-").slice(0, 64) || "worktree";

function validate(o) {
  const errors = [];
  const fields = fieldsOf(o);
  if (!Array.isArray(fields) || fields.length === 0) return ['"fields" must be a non-empty array.'];
  const names = new Set();
  for (const f of fields) {
    if (!f || typeof f !== "object" || typeof f.name !== "string" || !NAME.test(f.name)) { errors.push(`field ${JSON.stringify(f?.name ?? f)}: "name" must be a word (letters, digits, _).`); continue; }
    if (names.has(f.name)) errors.push(`field "${f.name}" is listed twice.`);
    if (CONTEXT.includes(f.name)) errors.push(`field "${f.name}" uses a reserved name.`);
    if (f.default != null && typeof f.default !== "string") errors.push(`field "${f.name}": "default" must be a string.`);
    if (f.type != null && f.type !== "branch") errors.push(`field "${f.name}": unknown type "${f.type}".`);
    names.add(f.name);
  }
  for (const key of ["path", "run"]) if (typeof o[key] !== "string" || !o[key].trim()) errors.push(`"${key}" is required (a string).`);
  for (const key of ["cwd", "after", "shell", "space"]) if (o[key] != null && typeof o[key] !== "string") errors.push(`"${key}" must be a string.`);
  if (o.background != null && typeof o.background !== "boolean") errors.push('"background" must be true or false.');
  if (o.agent != null && (!Array.isArray(o.agent) || o.agent.some((a) => typeof a !== "string"))) errors.push('"agent" must be an array of strings: ["claude"].');
  if (o.nonZeroExit != null && !["fail", "warn-if-created"].includes(o.nonZeroExit)) errors.push('"nonZeroExit" must be "fail" or "warn-if-created".');
  if (errors.length) return errors;
  // Every placeholder must name a field or the context, and a default may only use fields above it.
  const known = new Set([...CONTEXT, ...names]);
  const templates = [["path", o.path], ["run", o.run], ["cwd", o.cwd], ["space", o.space], ["after", o.after], ...(o.agent ?? []).map((a, i) => [`agent[${i}]`, a])];
  for (const [key, t] of templates) for (const p of t == null ? [] : placeholders(t)) {
    if (!known.has(p.name)) errors.push(`"${key}" uses {${p.name}}, which is no field and no context (${CONTEXT.join(", ")}).`);
    else if (p.filter && p.filter !== "slug") errors.push(`"${key}" uses an unknown filter :${p.filter}.`);
  }
  const above = new Set(CONTEXT);
  for (const f of fields) {
    for (const p of f.default == null ? [] : placeholders(f.default)) if (!above.has(p.name)) errors.push(`field "${f.name}": its default uses {${p.name}}, which is not a field above it.`);
    above.add(f.name);
  }
  return errors;
}

/** Defaults for fields not edited yet, from the values above them. */
function defaults(o, values, edited, ctx) {
  const out = { ...values };
  for (const f of fieldsOf(o)) {
    if (edited[f.name] || f.default == null) continue;
    try { out[f.name] = render(f.default, { ...ctx, ...out }); } catch { out[f.name] = ""; }
  }
  return out;
}

function plan(o, values, ctx) {
  for (const f of fieldsOf(o)) if (f.required && !String(values[f.name] ?? "").trim()) return { error: `Type a ${(f.label ?? f.name).toLowerCase()}.` };
  const vars = { ...ctx, ...Object.fromEntries(fieldsOf(o).map((f) => [f.name, String(values[f.name] ?? "").trim()])) };
  let path, cwd, run, after, agent, space;
  try {
    path = render(o.path, vars);
    cwd = render(o.cwd ?? "{repo.main}", vars);
    run = render(o.run, vars, { quote: true });
    after = o.after ? render(o.after, vars, { quote: true }) : "";
    agent = (o.agent ?? []).map((a) => shellQuote(render(a, vars))).join(" ");
    space = o.space ? render(o.space, vars) : base(path);
  } catch (error) { return { error: String(error.message ?? error) }; }
  const shell = o.shell ?? "/bin/sh";
  const warn = (o.nonZeroExit ?? "fail") === "warn-if-created";
  const app = appName(space);
  // The terminal ends in an interactive shell either way, so the output stays readable.
  const script = [
    `path=${shellQuote(path)}`,
    `stay() { exec "\${SHELL:-/bin/sh}" -li; }`,
    // OSC 7501: Herdr shows this terminal as an agent. msg is base64, like Claude Code sends it.
    `report() { printf '\\033]7501;state=%s:app=%s:msg=%s\\007' "$1" ${shellQuote(app)} "$(printf %s "$2" | base64 | tr -d '\\n')"; }`,
    `fail() { printf '\\n✗ %s\\n' "$1" >&2; report blocked "$1"; stay; }`,
    `if [ -e "$path/.git" ]; then`,
    `  printf 'Worktree already exists: %s\\n' "$path"`,
    `else`,
    `  report working ${shellQuote(`Creating ${space}`)}`,
    `  cd ${shellQuote(cwd)} || fail ${shellQuote(`No folder ${cwd}.`)}`,
    `  printf '$ %s\\n\\n' ${shellQuote(run)}`,
    // A subshell: an `exit` in the command ends the command, not this script.
    `  (\n${run}\n  )`,
    `  code=$?`,
    `  [ -e "$path/.git" ] || fail "The command exited with $code and $path was not created."`,
    warn
      ? `  [ "$code" -eq 0 ] || printf '\\n⚠ The command exited with %s, but %s is checked out. Opening it anyway.\\n\\n' "$code" "$path" >&2`
      : `  [ "$code" -eq 0 ] || fail "The command exited with $code. $path is left as it is."`,
    `fi`,
    `cd "$path" || fail "Cannot enter $path."`,
    ...(after ? [after] : []),
    `report done ${shellQuote(`${space} is ready`)}`,
    ...(agent ? [agent] : []),
    `stay`,
  ].join("\n");
  return { kind: "space", folder: cwd, path, space, background: o.background ?? true, argv: [shell, "-c", script] };
}

export default { id: "command", validate, fields: fieldsOf, defaults, plan };

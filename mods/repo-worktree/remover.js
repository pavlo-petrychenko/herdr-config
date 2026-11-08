// Removing checkouts in the background. Pure: it builds the job's shell script, so plain node
// tests it. The dialog closes the checkouts' spaces first, then runs the job in a new space.
//
// The job works in three stages, so many checkouts go at once:
//   1. one at a time: unlock each checkout (git skips a locked one)
//   2. in parallel:   remove Docker containers bound into it (option), delete its agent-plan-review
//                     plans (option), delete the folder
//   3. one at a time: `git worktree prune`, delete the branches (option)
// Git runs one at a time because parallel git commands on one repo race for lock files.
// It reports to Herdr like an agent (OSC 7501): working, then done (Herdr's "finished" toast;
// the job's space then closes itself) or blocked (the space stays, with the output).
//
// A removal is full by default: containers, folder and branch all go.
// Options, in a repo's entry: "remove": { "deleteBranch": true, "docker": true, "plans": true }
//   deleteBranch  delete each checkout's local branch too (Herdr's own Remove keeps it)
//   docker        first stop and remove the checkout's Docker containers (and their anonymous
//                 volumes): those with a bind mount inside it, or a compose project folder
//                 inside it. Named volumes and other checkouts' containers stay.
//   plans         delete the checkout's agent-plan-review plans: `agent-plan-review forget
//                 --worktree <path>`. Best-effort: skipped quietly when agent-plan-review is not
//                 installed or is too old to have `forget`; a real error is shown in the output
//                 but does not make the removal count as failed. Needs `agent-plan-review` on
//                 PATH (e.g. `npm link` in the agent-plan-review checkout).

import { shellQuote } from "./template.js";

export const REMOVE_DEFAULTS = { deleteBranch: true, docker: true, plans: true };

export function validateRemove(remove) {
  if (remove == null) return [];
  if (typeof remove !== "object" || Array.isArray(remove)) return ['"remove" must be an object: { "deleteBranch": true, "docker": false }.'];
  const errors = [];
  for (const [k, v] of Object.entries(remove)) {
    if (!(k in REMOVE_DEFAULTS)) errors.push(`"remove" has an unknown option "${k}" (known: ${Object.keys(REMOVE_DEFAULTS).join(", ")}).`);
    else if (typeof v !== "boolean") errors.push(`"remove.${k}" must be true or false.`);
  }
  return errors;
}

const appName = (s) => s.replace(/[^A-Za-z0-9_.+-]/g, "-").slice(0, 64);

/**
 * items: [{ path, name, branch }] (linked checkouts only), main: the main checkout folder.
 * → { space, folder, argv }
 */
export function removePlan(items, main, options = {}) {
  const o = { ...REMOVE_DEFAULTS, ...options };
  if (!items.length) return { error: "Nothing to remove." };
  if (items.some((c) => !c.path || c.path === main || !c.path.startsWith("/"))) return { error: "Only linked checkouts can be removed." };
  const n = items.length;
  const what = n === 1 ? items[0].name : `${n} worktrees`;
  const space = `removing ${what}`;
  const q = shellQuote;
  const lines = [
    `main=${q(main)}`,
    `stay() { exec "\${SHELL:-/bin/sh}" -li; }`,
    `report() { printf '\\033]7501;state=%s:app=%s:msg=%s\\007' "$1" ${q(appName(`remove-${what}`))} "$(printf %s "$2" | base64 | tr -d '\\n')"; }`,
    // Read-only files (module caches) block rm: make them writable once.
    `delete_dir() { [ -e "$1" ] || return 0; rm -rf "$1" 2>/dev/null || { chmod -R u+w "$1" 2>/dev/null; rm -rf "$1"; }; }`,
    ...(o.docker
      ? [
          // The checkout's containers: a bind mount inside it (it would bring the folder back
          // after the delete), or a compose project started from inside it.
          `remove_containers() {`,
          `  command -v docker >/dev/null 2>&1 || return 0`,
          `  docker info >/dev/null 2>&1 || { echo "Docker is not running: no containers to remove."; return 0; }`,
          `  for cid in $(docker ps -a -q --no-trunc 2>/dev/null); do`,
          `    if docker inspect "$cid" --format '{{range .Mounts}}{{.Source}}{{"\\n"}}{{end}}{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null | awk -v p="$1/" 'index($0"/", p)==1 {f=1} END {exit !f}'; then`,
          `      echo "Removing container $(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | tr -d /) (uses $1)"; docker rm -f -v "$cid" >/dev/null || true`,
          `    fi`,
          `  done`,
          `}`,
        ]
      : [`remove_containers() { :; }`]),
    ...(o.plans
      ? [
          `forget_plans() {`,
          `  command -v agent-plan-review >/dev/null 2>&1 || return 0`,
          `  out=$(agent-plan-review forget --worktree "$1" 2>&1); rc=$?`,
          `  if [ "$rc" -ne 0 ] && { printf %s "$out" | grep -qiE 'unknown (sub)?command|unrecognized (sub)?command|invalid command|no such command|not a known command' || { printf %s "$out" | grep -q 'Usage:' && ! printf %s "$out" | grep -q '^  forget'; }; }; then`,
          `    echo "plans: agent-plan-review has no forget command; skipped"; return 0`,
          `  fi`,
          `  [ -z "$out" ] || printf '%s\\n' "$out"`,
          `  [ "$rc" -eq 0 ] || echo "plans: agent-plan-review forget failed (exit $rc); the removal goes on"`,
          `  return 0`,
          `}`,
        ]
      : [`forget_plans() { :; }`]),
    `report working ${q(`Removing ${what}`)}`,
    `logs=$(mktemp -d "\${TMPDIR:-/tmp}/repo-worktree.XXXXXX")`,
    `failed=0`,
    `printf 'Removing %s\\n\\n' ${q(what)}`,
    // Stage 1.
    ...items.map((c) => `git -C "$main" worktree unlock ${q(c.path)} >/dev/null 2>&1 || true`),
    // Stage 2.
    ...items.map((c, i) => `( remove_containers ${q(c.path)}; forget_plans ${q(c.path)}; delete_dir ${q(c.path)} ) >"$logs/${i}.log" 2>&1 & pid${i}=$!`),
    // Stage 3.
    ...items.flatMap((c, i) => [
      `if wait "$pid${i}"; then`,
      `  printf '✓ %s\\n' ${q(c.name)}; cat "$logs/${i}.log"`,
      `else`,
      `  failed=$((failed + 1)); printf '✗ %s\\n' ${q(c.name)} >&2; cat "$logs/${i}.log" >&2`,
      `fi`,
    ]),
    `git -C "$main" worktree prune`,
    ...(o.deleteBranch
      ? items.filter((c) => c.branch).map((c) => `[ -e ${q(c.path)} ] || ! git -C "$main" show-ref --verify --quiet ${q(`refs/heads/${c.branch}`)} || git -C "$main" branch -D ${q(c.branch)} || failed=$((failed + 1))`)
      : []),
    `rm -rf "$logs"`,
    `if [ "$failed" -gt 0 ]; then printf '\\n✗ %s of %s failed. The output is above.\\n' "$failed" ${n} >&2; report blocked "$failed of ${n} failed"; stay; fi`,
    `report done ${q(n === 1 ? `${what} is removed` : `${what} are removed`)}`,
    `printf '\\nDone. This space closes itself.\\n'`,
    // Close this job's own space, a moment after the "finished" toast.
    `sid=$(hc get "\${HC_TERMINAL_ID:-}" --json 2>/dev/null | grep -o '"herdr.space":"[^"]*"' | cut -d'"' -f4)`,
    `[ -n "$sid" ] && sleep 3 && herdr-app do space.close --id "$sid" --confirmed true >/dev/null 2>&1`,
    `stay`,
  ];
  return { space, folder: main, argv: ["/bin/sh", "-c", lines.join("\n")] };
}

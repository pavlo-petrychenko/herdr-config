// The per-repo worktree config: <appHome>/repo-worktree.json.
//
// {
//   "defaults": { "agent": ["claude"] },          options for every repo
//   "repos": {
//     "~/Desktop/project/website": { "strategy": "command", ...that strategy's options }
//   }
// }
//
// Keys are main checkout folders. A repo with no entry uses the "git" strategy
// (git worktree add into ~/.herdr/worktrees/<repo>/<name>) with the defaults.

import { getStrategy, strategyIds, DEFAULT_STRATEGY } from "./strategies/index.js";
import { validateRemove } from "./remover.js";

export const CONFIG_FILE = "repo-worktree.json";

export const expandHome = (path, home) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path);
const normalize = (path) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Parses the file's text (null: no file).
 * Returns { repos: Map<folder, entry>, errors: string[] }: an entry is
 * { key, strategy, options } when it is valid, { key, errors } when it is not.
 * `errors` are problems of the whole file (bad JSON): no entry can be trusted then.
 */
export function parseConfig(text, home) {
  const repos = new Map();
  if (text == null || !text.trim()) return { repos, errors: [] };
  let raw;
  try { raw = JSON.parse(text); } catch (error) { return { repos, errors: [`Not valid JSON: ${error.message}`] }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { repos, errors: ["The top level must be an object."] };
  if (raw.defaults != null && (typeof raw.defaults !== "object" || Array.isArray(raw.defaults))) return { repos, errors: ['"defaults" must be an object of options for every repo: { "agent": ["claude"] }.'] };
  const defaults = raw.defaults ?? {};
  if (raw.repos == null) return { repos, defaults, errors: [] };
  if (typeof raw.repos !== "object" || Array.isArray(raw.repos)) return { repos, errors: ['"repos" must be an object: { "<main checkout folder>": { "strategy": ... } }.'] };
  for (let [key, entry] of Object.entries(raw.repos)) {
    const folder = normalize(expandHome(key, home));
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { repos.set(folder, { key, errors: ["The entry must be an object."] }); continue; }
    entry = { ...defaults, ...entry };
    const id = entry.strategy ?? DEFAULT_STRATEGY;
    const strategy = getStrategy(id);
    if (!strategy) { repos.set(folder, { key, errors: [`Unknown strategy "${id}". Known: ${strategyIds().join(", ")}.`] }); continue; }
    const problems = [...strategy.validate(entry), ...validateRemove(entry.remove)];
    repos.set(folder, problems.length ? { key, errors: problems } : { key, strategy: id, options: entry });
  }
  return { repos, defaults, errors: [] };
}

/** The entry for a repo's main checkout: its own, or the default strategy's. */
export function entryFor(config, repoMain) {
  if (config.errors.length) return { key: null, errors: config.errors };
  return config.repos.get(normalize(repoMain)) ?? { key: null, strategy: DEFAULT_STRATEGY, options: { ...(config.defaults ?? {}) } };
}

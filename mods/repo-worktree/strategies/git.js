// The default for every repo with no entry: plain `git worktree add` into Herdr's own place,
// ~/.herdr/worktrees/<repo>/<name>. A branch that exists is checked out; a new one starts from
// the checkout you are in. It runs like the "command" strategy (in the background, Herdr
// notifies you), and takes the same options to override (agent, background, path, ...).
import command from "./command.js";

const PATH = "{home}/.herdr/worktrees/{repo.name}/{name:slug}";

const preset = (o = {}) => ({
  fields: [{ name: "name", label: "Name", required: true, type: "branch" }],
  path: PATH,
  cwd: "{repo.top}",
  space: "{repo.name}-{name:slug}",
  run: `if git show-ref --verify --quiet refs/heads/{name}; then git worktree add ${PATH} {name}; else git worktree add -b {name} ${PATH} HEAD; fi`,
  ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== "strategy" && k !== "remove")),
});

export default {
  id: "git",
  validate: (o) => command.validate(preset(o)),
  fields: (o) => command.fields(preset(o)),
  defaults: (o, values, edited, ctx) => command.defaults(preset(o), values, edited, ctx),
  plan: (o, values, ctx) => command.plan(preset(o), values, ctx),
};

// Worktree creation strategies. A strategy is a plain object:
//
//   id        its name in repo-worktree.json ("strategy": "<id>")
//   validate  (options) => string[]      problems with a repo's entry ([] = fine)
//   fields    (options) => Field[] | null the dialog's inputs; null: no form of its own
//   plan      (options, values, ctx) => Plan
//
// Field: { name, label?, placeholder?, default?, required?, type?: "branch" }.
//   `default` may use other fields: "{branch:slug}". It follows them until edited.
// ctx:  { "repo.main", "repo.parent", "repo.name", "repo.top", home }.
// Plan: { kind: "delegate" }                         Herdr's own dialog does it
//     | { kind: "space", folder, argv, path }         a new space whose terminal runs argv in folder
//     | { error }.
//
// Strategies are pure (no Herdr calls), so they are tested with plain node.
// To add one: write strategies/<id>.js and list it below.

import git from "./git.js";
import command from "./command.js";

export const DEFAULT_STRATEGY = "git";

const STRATEGIES = [git, command];

export const getStrategy = (id) => STRATEGIES.find((s) => s.id === id) ?? null;
export const strategyIds = () => STRATEGIES.map((s) => s.id);

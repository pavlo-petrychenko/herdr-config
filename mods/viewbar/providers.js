// The panels of the second view, one provider each (the interface is in logic.js).
//
// PRs ships (prs.js): its button shows when the agent has open pull requests. Workflow, Memory and
// TODOs have no data source yet, and a button shows only when its thing exists.
//
// To add one, write the provider (its own file, importing only from this folder), put its icon in
// icons/, and list it below. A provider that is drawn by a mod of its own (like PRs) names that
// mod's block in the side column's stack (`child`) and the command that gives it the keyboard
// (`focus`); one without them is drawn by this bar's side view from `body`. Sketch:
//
//   export const memory = {
//     kind: "memory", title: "Memory", icon: "mods/viewbar/icons/memory.svg",
//     init(cx) { /* read the data; cx.notify() when it changes */ },
//     available: ({ terminal }) => (DATA.get(terminal)?.length ? { badge: { text: "2", tone: "ansi2" }, tip: "Memory · 2 notes" } : null),
//     body: ({ terminal }, t, { div }) => DATA.get(terminal).map((note) => div().child(note.title)),
//   };
//
// `badge` is optional (no badge, nothing drawn).
// Each provider's `kind` also becomes a key command: "viewbar.prs" in keys.json toggles that panel.

import { prs } from "./prs.js";

export const PROVIDERS = [prs];

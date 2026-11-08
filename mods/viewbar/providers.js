// The panels of the second view, one provider each (the interface is in logic.js).
//
// None ship yet: PRs, Workflow, Memory and TODOs have no data source, and a button shows only
// when its thing exists, so the bar's right side stays empty until a provider is added here.
//
// To add one, write the provider (its own file, e.g. prs.js, importing only from this folder),
// put its icon in icons/, and list it below. Sketch:
//
//   export const prs = {
//     kind: "prs", title: "Pull requests", icon: "mods/viewbar/icons/prs.svg",
//     init(cx) { /* read the data; cx.notify() when it changes */ },
//     available: ({ terminal }) => (DATA.get(terminal)?.length ? { badge: { text: "2", tone: "ansi2" }, tip: "Pull requests · 2 open" } : null),
//     body: ({ terminal }, t, { div }) => DATA.get(terminal).map((pr) => div().child(pr.title)),
//   };
//
// Each provider's `kind` also becomes a key command: "viewbar.prs" in keys.json toggles that panel.

export const PROVIDERS = [];

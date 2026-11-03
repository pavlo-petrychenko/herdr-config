// Placeholders in strategy options: {name} or {name:filter}.
// Names are field names ("branch") or context ("repo.main", "repo.parent", "repo.name", "home").

const TOKEN = /\{([A-Za-z_][\w.]*)(?::([a-z]+))?\}/g;

/** A branch as a folder name: anything but letters, digits, ".", "_" and "-" becomes "-". */
export const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

/** One POSIX shell word. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const FILTERS = { slug };

/** The placeholders a template uses: [{ name, filter }]. */
export function placeholders(template) {
  return [...String(template).matchAll(TOKEN)].map(([, name, filter]) => ({ name, filter: filter ?? null }));
}

/** Fills a template. `quote`: shell-quote every value (for commands). Throws on an unknown name or filter. */
export function render(template, vars, { quote = false } = {}) {
  return String(template).replace(TOKEN, (_, name, filter) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`Unknown placeholder {${name}}.`);
    let value = String(vars[name] ?? "");
    if (filter) {
      if (!FILTERS[filter]) throw new Error(`Unknown filter :${filter} in {${name}:${filter}}.`);
      value = FILTERS[filter](value);
    }
    return quote ? shellQuote(value) : value;
  });
}

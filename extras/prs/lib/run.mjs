// Runs programs. Everything that starts a process goes through a `run(cmd, args, opts)` function, so
// tests can pass a fake. The real one never rejects: it resolves { code, stdout, stderr, error? }.
import { spawn } from "node:child_process";

/** The whole command has to end before Herdr's 30 s exec limit; stay well under it. */
export class Deadline {
  constructor(ms, now = Date.now) { this.now = now; this.end = now() + ms; }
  remaining() { return this.end - this.now(); }
}

export function makeRunner({ deadline = null, env = process.env } = {}) {
  const debug = Boolean(env.HERDR_PRS_DEBUG);
  return function run(cmd, args = [], opts = {}) {
    if (!debug) return exec(cmd, args, opts);
    const t = Date.now();
    return exec(cmd, args, opts).then((r) => {
      process.stderr.write(`[run] ${String(Date.now() - t).padStart(5)} ms  ${cmd} ${args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(" ")}\n`);
      return r;
    });
  };
  function exec(cmd, args = [], opts = {}) {
    return new Promise((resolve) => {
      let timeout = opts.timeout ?? 20000;
      if (deadline) {
        const left = deadline.remaining() - 300;
        if (left <= 0) return resolve({ code: null, stdout: "", stderr: "", error: "timeout: out of time" });
        timeout = Math.min(timeout, left);
      }
      const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
      const child = spawn(cmd, args, {
        cwd: opts.cwd, stdio: [opts.input == null ? "ignore" : "pipe", "pipe", "pipe"],
        env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", ...opts.env },
      });
      const out = [], err = [];
      let outLen = 0, done = false, over = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ code: null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error: `timeout after ${Math.round(timeout / 1000)}s` }); }, timeout);
      child.stdout.on("data", (b) => { outLen += b.length; if (outLen > maxBuffer) { over = true; child.kill("SIGKILL"); } else out.push(b); });
      child.stderr.on("data", (b) => { if (err.length < 64) err.push(b); });
      child.on("error", (e) => finish({ code: null, stdout: "", stderr: "", error: e.code === "ENOENT" ? `ENOENT: ${cmd} not found` : String(e.message) }));
      child.on("close", (code) => finish({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), ...(over ? { error: "output too large" } : {}) }));
      if (opts.input != null) { child.stdin.on("error", () => {}); child.stdin.end(opts.input); }
    });
  }
}

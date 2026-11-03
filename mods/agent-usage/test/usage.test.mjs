import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaude, parseOpencode, parseGoUsage, goProblem, level, resetsIn, ago, tokens, money } from "../usage.js";

const NOW = Date.UTC(2026, 9, 31, 12, 0) ;

test("claude: windows in order, clamped; a window past its reset is back at 0", () => {
  const text = JSON.stringify({ at: NOW - 60000, five_hour: { used_percentage: 42.5, resets_at: NOW / 1000 + 7800 }, seven_day: { used_percentage: 130, resets_at: NOW / 1000 - 5 } });
  const c = parseClaude(text, NOW);
  assert.equal(c.at, NOW - 60000);
  assert.deepEqual(c.windows.map((w) => [w.key, w.used, Boolean(w.resets)]), [["five_hour", 42.5, true], ["seven_day", 0, false]]);
  assert.equal(parseClaude("{bad", NOW), null);
  assert.deepEqual(parseClaude("{}", NOW).windows, []);
});

test("opencode: both periods or nothing", () => {
  assert.deepEqual(parseOpencode("day|2|0.12|340000\nweek|9|0.88|6100000\n"), { day: { sessions: 2, cost: 0.12, tokens: 340000 }, week: { sessions: 9, cost: 0.88, tokens: 6100000 } });
  assert.equal(parseOpencode("day|1|0|0"), null);
  assert.equal(parseOpencode(""), null);
});

test("formatting", () => {
  assert.deepEqual([level(10), level(60), level(84.9), level(85)], ["ok", "warn", "warn", "hot"]);
  assert.equal(resetsIn(NOW + 45 * 60000, NOW), "in 45 m");
  assert.equal(resetsIn(NOW + 130 * 60000, NOW), "in 2 h 10 m");
  assert.equal(resetsIn(NOW + 120 * 60000, NOW), "in 2 h");
  assert.match(resetsIn(NOW + 3 * 86400000, NOW), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
  assert.deepEqual([ago(NOW - 10000, NOW), ago(NOW - 4 * 60000, NOW), ago(null, NOW)], ["just now", "4 m ago", "never"]);
  assert.deepEqual([tokens(950), tokens(340000), tokens(6100000), tokens(12000000)], ["950", "340k", "6.1M", "12M"]);
  assert.deepEqual([money(0.123), money(12.34)], ["$0.12", "$12.3"]);
});

test("go usage: percent or used/limit, resets in any form, missing windows dropped", () => {
  const w = parseGoUsage({ usage: { rolling: { percent: 42, resetInSec: 600 }, weekly: { usedMicroCents: 25, limitMicroCents: 100, resetsAt: "2026-11-02T00:00:00Z" }, monthly: { usagePercent: 130, resetAt: NOW / 1000 + 60 } } }, NOW);
  assert.deepEqual(w.map((x) => [x.key, x.used]), [["rolling", 42], ["weekly", 25], ["monthly", 100]]);
  assert.deepEqual(w.map((x) => x.resets), [NOW + 600000, Date.parse("2026-11-02T00:00:00Z"), NOW + 60000]);
  assert.deepEqual(parseGoUsage({ rolling: { percent: 5 }, weekly: {} }, NOW).map((x) => x.key), ["rolling"]);
  assert.deepEqual(parseGoUsage(null, NOW), []);
});

test("go problems: expired key, refused key, other", () => {
  assert.match(goProblem(401, { error: { code: "api_key_expired" } }), /expired/);
  assert.match(goProblem(403, {}), /does not accept/);
  assert.equal(goProblem(500, { error: { message: "down" } }), "OpenCode answered 500: down.");
});

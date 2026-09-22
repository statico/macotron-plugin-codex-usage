// Self-check: stub the host, load the plugin, exercise the math, the rollout
// walk and every style. Run: node test.js
const src = require("fs").readFileSync(__dirname + "/codex-usage.js", "utf8");

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Two days of rollouts. The newest file has no rate limits (a session that
// never called the API), so the reader has to walk back to the one before it.
// That older line also hides rate_limits inside payload.info, as some Codex
// versions write it.
const TREE = {
  "~/.codex/sessions": ["2026", "junk"],
  "~/.codex/sessions/2026": ["09"],
  "~/.codex/sessions/2026/09": ["20", "21"],
  "~/.codex/sessions/2026/09/20": ["rollout-2026-09-20T08-00-00-aaa.jsonl"],
  "~/.codex/sessions/2026/09/21": ["rollout-2026-09-21T09-00-00-bbb.jsonl", "rollout-2026-09-21T10-00-00-ccc.jsonl", "notes.txt"],
};
const FILES = {
  "~/.codex/sessions/2026/09/21/rollout-2026-09-21T10-00-00-ccc.jsonl":
    JSON.stringify({ timestamp: iso(now), type: "event_msg", payload: { type: "user_message" } }) + "\n",
  "~/.codex/sessions/2026/09/21/rollout-2026-09-21T09-00-00-bbb.jsonl":
    JSON.stringify({ timestamp: iso(now - 30 * 60e3), payload: { type: "user_message" } }) +
    "\n" +
    JSON.stringify({
      timestamp: iso(now - 10 * 60e3),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 1_250_000 },
          rate_limits: {
            primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 2 * 3600 + 10 * 60 },
            secondary: { used_percent: 61, window_minutes: 10080, resets_in_seconds: 3 * 86400 + 10 * 60 },
          },
        },
      },
    }) +
    "\n",
  "~/.codex/sessions/2026/09/20/rollout-2026-09-20T08-00-00-aaa.jsonl": "{ not json\n",
};

const calls = { status: [], checks: [] };
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => (store[k] = v), removeItem: (k) => delete store[k] };
const reads = [];
globalThis.macotron = {
  plugin: () => ({ show: "both", style: "battery", color: "multi", labels: true, pace: true, refreshMs: 60000 }),
  system: { darkMode: () => true },
  menubar: { status: (id, o) => calls.status.push(o), isDark: () => false },
  on: () => {},
  checks: (c) => calls.checks.push(c),
  every: () => {},
  url: { open() {} },
  settings: { open() {} },
  fs: {
    exists: (p) => p in TREE || p in FILES,
    list: (p) => TREE[p] || null,
    read: (p) => {
      reads.push(p);
      if (!(p in FILES)) throw new Error("ENOENT " + p);
      return FILES[p];
    },
  },
};
function assert(ok, msg) {
  if (!ok) throw new Error("FAIL: " + msg);
}

(0, eval)(
  src +
    "\n;globalThis.__t = { elapsed, statusColor, paceTier, resetsIn, windowName, render, view, scan, read, rollouts, tokens, STYLES, opts, setData: (d) => { data = d; } };"
);
const t = globalThis.__t;

// Window math.
assert(t.elapsed(now - 1, 5 * 3600e3, now) === 1, "past reset is fully elapsed");
assert(Math.abs(t.elapsed(now + 2.5 * 3600e3, 5 * 3600e3, now) - 0.5) < 1e-9, "halfway through the window");
assert(t.statusColor(60, 0.5) === "red", "60% at half time projects to 1.2 → red");
assert(t.statusColor(30, 0.5) === "green", "30% at half time → green");
assert(t.statusColor(75, 0.05) === "orange", "before 15% elapsed falls back to used thresholds");
assert(t.paceTier(0, 0.5) === 0 && t.paceTier(30, 0.5) === 1 && t.paceTier(70, 0.5) === 5, "pace tiers");
assert(t.paceTier(50, 0.01) === null, "too early to judge pace");
assert(t.resetsIn(now + 3.75 * 3600e3 + 1, now) === "3h 45m", "3h 45m");
assert(t.resetsIn(now + 2 * 86400e3 + 1, now) === "2 days", "2 days");
assert(t.resetsIn(now - 5, now) === "Reset now", "reset now");

// Codex names neither window; the minutes do.
assert(t.windowName(300) === "5-hour" && t.windowName(10080) === "Weekly", "window names");
assert(t.windowName(1440) === "Daily" && t.windowName(30) === "30-minute" && t.windowName(0) === "", "other windows");
assert(t.tokens(1_250_000) === "1.3M tokens" && t.tokens(0) === null, "token formatting");

// Reading: walk back past the rollout with no limits, read the nested shape,
// and count resets_in_seconds from the event's own timestamp, not from now.
const d = t.read();
assert(d.session.pct === 42.5 && d.week.pct === 61, "percentages");
assert(d.session.minutes === 300 && d.week.duration === 10080 * 60e3, "windows");
assert(Math.abs(d.session.resets - (now - 10 * 60e3 + (2 * 3600 + 10 * 60) * 1000)) < 1000, "reset is relative to the event");
assert(d.tokens === 1_250_000 && Math.abs(d.at - (now - 10 * 60e3)) < 1000, "tokens and age");
assert(reads[0].endsWith("ccc.jsonl") && reads[1].endsWith("bbb.jsonl"), "newest first: " + reads.join(", "));
assert(t.rollouts(99).length === 3 && !t.rollouts(99).some((f) => f.endsWith(".txt")), "only jsonl, skipping the junk dir");
assert(t.scan('{"timestamp":"' + iso(now) + '","rate_limits":{}}') === null, "empty rate limits are no reading");
assert(t.scan("nothing here\n") === null, "no reading in a plain transcript");

// A window whose reset has passed rolled over since Codex wrote the file.
assert(t.view({ pct: 90, minutes: 300, duration: 5 * 3600e3, resets: now - 1 }, now).pct === 0, "expired window reads 0");
assert(t.view({ pct: 90, minutes: 300, duration: 5 * 3600e3, resets: now - 1 }, now).resets === null, "and shows no countdown");
assert(t.view({ pct: -3, minutes: 300, duration: 5 * 3600e3, resets: now + 1e6 }, now).shown === 0, "shown never goes negative");
assert(t.view(null, now).pct === 0, "no data reads 0");

// Every style renders both quotas into well-formed SVG with a pace tick.
t.setData(d);
for (const style of Object.keys(t.STYLES)) {
  for (const labels of [true, false]) {
    t.opts.style = style;
    t.opts.labels = labels;
    const out = t.render(true);
    assert(/^<svg [^>]*width="\d+(\.\d+)?" height="\d+"/.test(out.svg), style + " has a size");
    assert(out.svg.endsWith("</svg>") && (out.svg.match(/<g /g) || []).length === 2, style + " has two quotas");
    assert(out.template === false, style + " is not a template in multi color");
    assert(out.svg.includes(style === "percent" || style === "compact" ? 'r="2"' : "<line"), style + " shows the pace marker");
  }
}
t.opts.style = "battery";
t.opts.labels = true;
t.opts.color = "mono";
t.opts.pace = false;
assert(t.render(false).template === true, "mono without pace is a template");
assert(!t.render(false).svg.includes("<line"), "no tick without pace");
t.opts.pace = true;
assert(!/stroke="#(?!000000)/.test(t.render(false).svg), "mono pace tick takes the text color");

// End to end through the stubbed host.
t.opts.color = "multi";
setTimeout(() => {
  const last = calls.status[calls.status.length - 1];
  assert(last.svg.includes("<line"), "painted with a tick");
  assert(last.menu[0].html.includes("Resets in") && last.menu[0].html.includes("5-hour"), "dashboard names the window");
  assert(last.menu[0].html.includes("1.3M tokens") && last.menu[0].html.includes("ago"), "dashboard shows tokens and age");
  assert(last.menu[0].height > 100, "dashboard is tall enough to hold its rows");
  assert(calls.checks[calls.checks.length - 1][0].ok === true, "check is green");
  console.log("ok: " + calls.status.length + " paints, styles " + Object.keys(t.STYLES).join(", "));
}, 50);

// Self-check: stub the host, load the plugin, exercise the math, the rollout
// walk and every style. Run: node test.js
const src = require("fs").readFileSync(__dirname + "/codex-usage.js", "utf8");

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Two days of rollouts. The newest file has no rate limits (a session that
// never called the API), so the reader has to walk back to the one before it.
// That older line also hides rate_limits inside payload.info, as some Codex
// versions write it, and reports only a weekly window — the shape a plan with
// no five-hour limit produces.
const TREE = {
  "~/.codex/sessions": ["2026", "junk"],
  "~/.codex/sessions/2026": ["09"],
  "~/.codex/sessions/2026/09": ["20", "21"],
  "~/.codex/sessions/2026/09/20": ["rollout-2026-09-20T08-00-00-aaa.jsonl"],
  "~/.codex/sessions/2026/09/21": ["rollout-2026-09-21T09-00-00-bbb.jsonl", "rollout-2026-09-21T10-00-00-ccc.jsonl", "notes.txt"],
};
const weeklyOnly = JSON.stringify({
  timestamp: iso(now - 10 * 60e3),
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: 3_600_000 },
      // What Ian's account actually reports: one window, and `secondary`
      // present but empty. Neither may be drawn as a second 0% bar.
      rate_limits: {
        primary: { used_percent: 65, window_minutes: 10080, resets_in_seconds: 6 * 86400 + 21 * 3600 },
        secondary: null,
      },
    },
  },
});
const FILES = {
  "~/.codex/sessions/2026/09/21/rollout-2026-09-21T10-00-00-ccc.jsonl":
    JSON.stringify({ timestamp: iso(now), type: "event_msg", payload: { type: "user_message" } }) + "\n",
  "~/.codex/sessions/2026/09/21/rollout-2026-09-21T09-00-00-bbb.jsonl":
    JSON.stringify({ timestamp: iso(now - 30 * 60e3), payload: { type: "user_message" } }) + "\n" + weeklyOnly + "\n",
  "~/.codex/sessions/2026/09/20/rollout-2026-09-20T08-00-00-aaa.jsonl": "{ not json\n",
};

const calls = { status: [], checks: [] };
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => (store[k] = v), removeItem: (k) => delete store[k] };
const reads = [];
globalThis.macotron = {
  plugin: () => ({ show: "all", style: "battery", color: "multi", labels: true, pace: true, refreshMs: 60000 }),
  system: { darkMode: () => true, locale: () => ({ hour12: true }) },
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
    "\n;globalThis.__t = { elapsed, statusColor, paceTier, resetsIn, windowName, windowShort, clockAt, pick, render, view, scan, read, rollouts, tokens, windowsOf, STYLES, opts, setData: (d) => { data = d; } };"
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

// Codex names no window; the minutes do.
assert(t.windowName(300) === "5-hour" && t.windowName(10080) === "Weekly", "window names");
assert(t.windowName(1440) === "Daily" && t.windowName(30) === "30-minute", "other windows");
assert(t.windowName(0, "primary") === "Primary", "a window with no minutes falls back to its key");
assert(t.windowShort(300) === "5h" && t.windowShort(10080) === "Wk" && t.windowShort(4320) === "3d", "short labels");
assert(t.tokens(3_600_000) === "3.6M tokens" && t.tokens(0) === null, "token formatting");

// Resets read as a countdown and a wall clock.
const noon = new Date(now);
noon.setHours(15, 41, 0, 0);
assert(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 3:41 PM$/.test(t.clockAt(noon.getTime(), now)), "clock: " + t.clockAt(noon.getTime(), now));
assert(/^[A-Z][a-z]{2} \d+, /.test(t.clockAt(now + 8 * 86400e3, now)), "beyond a week the date appears");

// Reading: walk back past the rollout with no limits, read the nested shape,
// and count resets_in_seconds from the event's own timestamp, not from now.
const d = t.read();
assert(d.windows.length === 1, "an empty secondary is not a window: got " + d.windows.length);
assert(d.windows[0].pct === 65 && d.windows[0].minutes === 10080, "the weekly window");
assert(Math.abs(d.windows[0].resets - (now - 10 * 60e3 + (6 * 86400 + 21 * 3600) * 1000)) < 1000, "reset is relative to the event");
assert(d.tokens === 3_600_000 && Math.abs(d.at - (now - 10 * 60e3)) < 1000, "tokens and age");
assert(reads[0].endsWith("ccc.jsonl") && reads[1].endsWith("bbb.jsonl"), "newest first: " + reads.join(", "));
assert(t.rollouts(99).length === 3 && !t.rollouts(99).some((f) => f.endsWith(".txt")), "only jsonl, skipping the junk dir");
assert(t.scan('{"timestamp":"' + iso(now) + '","rate_limits":{"primary":null}}') === null, "no usable window is no reading");
assert(t.scan("nothing here\n") === null, "no reading in a plain transcript");

// Several windows come back shortest first, whatever order the keys sit in.
const three = t.windowsOf(
  {
    secondary: { used_percent: 61, window_minutes: 10080 },
    primary: { used_percent: 42, window_minutes: 300 },
    tertiary: { used_percent: 10, window_minutes: 1440 },
  },
  now
);
assert(three.map((q) => q.minutes).join(",") === "300,1440,10080", "sorted by window length");
assert(t.pick(three).length === 2 && t.pick(three)[1].minutes === 10080, "the icon takes the shortest and the longest");
t.opts.show = "long";
assert(t.pick(three)[0].minutes === 10080, "longest only");
t.opts.show = "week";
assert(t.pick(three)[0].minutes === 10080, "the old 'week' setting still means longest");
t.opts.show = "session";
assert(t.pick(three)[0].minutes === 300, "the old 'session' setting still means shortest");
t.opts.show = "all";
assert(t.pick([]).length === 0, "nothing to pick from nothing");

// A window whose reset has passed rolled over since Codex wrote the file.
assert(t.view({ pct: 90, minutes: 300, duration: 5 * 3600e3, resets: now - 1 }, now).pct === 0, "expired window reads 0");
assert(t.view({ pct: 90, minutes: 300, duration: 5 * 3600e3, resets: now - 1 }, now).resets === null, "and shows no countdown");
assert(t.view({ pct: -3, minutes: 300, duration: 5 * 3600e3, resets: now + 1e6 }, now).shown === 0, "shown never goes negative");
assert(t.view(null, now).pct === 0, "no data reads 0");

// A pace dot needs a window that is actually underway. The real reading above
// is 1.8% into its week, which is too early to judge — so the styles that show
// only a dot correctly show nothing.
t.setData(d);
t.opts.style = "percent";
assert(!t.render(true).svg.includes('r="2"'), "no pace dot in the first minutes of a window");

// Every style renders the one window it was given, and two when there are two.
const midweek = { windows: [{ key: "primary", pct: 65, minutes: 10080, duration: 10080 * 60e3, resets: now + 3.5 * 86400e3 }], tokens: 3_600_000, at: now };
t.setData(midweek);
for (const style of Object.keys(t.STYLES)) {
  for (const labels of [true, false]) {
    t.opts.style = style;
    t.opts.labels = labels;
    const out = t.render(true);
    assert(/^<svg [^>]*width="\d+(\.\d+)?" height="\d+"/.test(out.svg), style + " has a size");
    assert(out.svg.endsWith("</svg>") && (out.svg.match(/<g /g) || []).length === 1, style + " draws one window, not two");
    assert(out.template === false, style + " is not a template in multi color");
    assert(out.svg.includes(style === "percent" || style === "compact" ? 'r="2"' : "<line"), style + " shows the pace marker");
    // percent draws "Wk 65%" as one text node, so look for the label anywhere.
    if (labels) assert(out.svg.includes("Wk"), style + " labels the window by its length");
    if (!labels) assert(!out.svg.includes("Wk"), style + " drops the label when names are off");
  }
}
t.setData({ windows: three, tokens: 0, at: now });
t.opts.style = "battery";
t.opts.labels = true;
assert((t.render(true).svg.match(/<g /g) || []).length === 2, "three windows still draw two icons");
t.setData({ windows: [], tokens: 0, at: now });
assert((t.render(true).svg.match(/<g /g) || []).length === 1, "no windows still draws a slot");

t.setData(d);
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
  const html = last.menu[0].html;
  assert(last.svg.includes("<line"), "painted with a tick");
  assert(html.includes("Weekly") && html.includes("65%"), "dashboard names the window it got");
  assert(!html.includes("Week<") && (html.match(/class="row"/g) || []).length === 1, "one card, and no phantom Week row");
  // Near a week out the clock switches from a weekday to a date; either is fine.
  assert(
    /Resets in 6d 2[01]h · ((Sun|Mon|Tue|Wed|Thu|Fri|Sat)|[A-Z][a-z]{2} \d+,) \d+:\d\d [AP]M/.test(html),
    "reset shows countdown and clock: " + html.slice(html.indexOf("Resets"), html.indexOf("Resets") + 60)
  );
  assert(html.includes("3.6M tokens") && html.includes("ago"), "dashboard shows tokens and age");
  assert(last.menu[0].height > 60, "dashboard is tall enough to hold its rows");
  const check = calls.checks[calls.checks.length - 1][0];
  assert(check.ok === true && check.message === "Weekly 65%", "check names the window: " + check.message);
  console.log("ok: " + calls.status.length + " paints, styles " + Object.keys(t.STYLES).join(", "));
}, 50);

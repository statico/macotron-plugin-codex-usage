// Codex Usage — the Codex CLI's rate limits in the menu bar.
//
// A sibling of the Claude Usage plugin: same icon styles, thresholds, colors
// and pace marker. Nothing is fetched, though. The Codex CLI already records
// its rate-limit windows in every session rollout under ~/.codex/sessions, so
// the numbers come off disk. No key, no network, no third-party binary.
//
// Codex reports two windows and names neither: `primary` is the short rolling
// one (five hours at the time of writing) and `secondary` the weekly one. The
// labels and the pace math read `window_minutes` rather than assume either.

const opts = macotron.plugin({
  title: "Codex Usage",
  description: "Codex CLI rate-limit graphs in the menu bar, with pace markers.",
  help:
    "Reads the session logs the Codex CLI writes under ~/.codex/sessions. No key and no network: " +
    "nothing leaves the Mac. The numbers only move when Codex runs, so the dashboard says how old " +
    "they are. Click the item for the dashboard.",
  options: {
    show: {
      type: "dropdown",
      label: "Show",
      default: "both",
      choices: [
        { value: "both", label: "Session and week" },
        { value: "session", label: "Session only" },
        { value: "week", label: "Week only" },
      ],
    },
    style: {
      type: "dropdown",
      label: "Style",
      default: "battery",
      choices: [
        { value: "battery", label: "Battery" },
        { value: "bar", label: "Progress bar" },
        { value: "ring", label: "Ring" },
        { value: "percent", label: "Percentage" },
        { value: "compact", label: "Compact dot" },
      ],
    },
    color: {
      type: "dropdown",
      label: "Color",
      default: "multi",
      choices: [
        { value: "multi", label: "Green, orange, red" },
        { value: "mono", label: "Monochrome" },
      ],
    },
    labels: { type: "boolean", label: "Show names", default: true, help: "Session and Week labels on the icons." },
    pace: {
      type: "boolean",
      label: "Pace marker",
      default: true,
      help: "A tick at the elapsed fraction of the window, colored by whether usage is ahead of it (plain in monochrome).",
    },
    refreshMs: { type: "number", label: "Refresh interval", default: 60000, help: "Milliseconds. The default is 60 seconds." },
  },
});

const ROOT = "~/.codex/sessions";
// A rollout with no rate limits in it is a session that never called the API.
// Seven days back is what it takes to still show a number after a week off.
const FILES = 40;
const MINUTE = 60e3;
// CoreSVG ignores text-anchor and PostScript face names, but honors a numeric
// font-weight. Centered text is placed by hand from Helvetica Bold advances.
const FONT = "Helvetica";
const ADVANCE = { S: 0.667, W: 0.944, e: 0.556, s: 0.556, i: 0.278, o: 0.611, n: 0.611, k: 0.556, "%": 0.889, " ": 0.278 };
function textWidth(s, size) {
  let w = 0;
  for (const c of s) w += ADVANCE[c] || 0.556;
  return w * size;
}

// macOS system colors, light and dark.
const SYS = {
  green: ["#28CD41", "#32D74B"],
  orange: ["#FF9500", "#FF9F0A"],
  red: ["#FF3B30", "#FF453A"],
  teal: ["#59ADC4", "#6AC4DC"],
  yellow: ["#FFCC00", "#FFD60A"],
  purple: ["#AF52DE", "#BF5AF2"],
};
const PACE_COLOR = ["green", "teal", "yellow", "orange", "red", "purple"];

let data = null; // { session, week, tokens, at }
let error = null;

// ---------------------------------------------------------------- math

// How far through the window we are, 0..1. A reset in the past is 1.
function elapsed(resets, duration, now) {
  if (!resets || !duration) return null;
  if (resets <= now) return 1;
  return Math.min(Math.max((duration - (resets - now)) / duration, 0), 1);
}

// Pace-aware once 15% of the window has gone, as the Claude tracker does it.
function statusColor(pct, frac) {
  if (frac !== null && frac >= 0.15 && frac < 1 && pct > 0) {
    const projected = pct / 100 / frac;
    return projected < 0.7 ? "green" : projected < 0.9 ? "orange" : "red";
  }
  return pct < 70 ? "green" : pct < 90 ? "orange" : "red";
}

// 0 comfortable … 5 runaway, or null when the window is too young to judge.
function paceTier(pct, frac) {
  if (frac === null || frac < 0.03 || frac >= 1) return null;
  if (pct <= 0) return 0;
  const p = pct / 100 / frac;
  return p < 0.5 ? 0 : p < 0.75 ? 1 : p < 0.9 ? 2 : p < 1 ? 3 : p < 1.2 ? 4 : 5;
}

function duration(ms) {
  const m = Math.floor(ms / MINUTE);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return h % 24 ? d + "d " + (h % 24) + "h" : d + (d === 1 ? " day" : " days");
  if (h > 0) return m % 60 ? h + "h " + (m % 60) + "m" : h + "h";
  return m > 0 ? m + "m" : "< 1m";
}

function resetsIn(resets, now) {
  return resets <= now ? "Reset now" : duration(resets - now);
}

// "5-hour", "Weekly". Codex names neither window, it only gives the minutes.
function windowName(minutes) {
  if (!minutes) return "";
  if (minutes % 10080 === 0) {
    const w = minutes / 10080;
    return w === 1 ? "Weekly" : w + "-week";
  }
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? "Daily" : d + "-day";
  }
  return minutes >= 60 ? Math.round(minutes / 60) + "-hour" : minutes + "-minute";
}

// One quota as the renderer wants it. A window whose reset has passed has
// rolled over since Codex last wrote, so it reads empty rather than stale.
function view(q, now) {
  const expired = !!(q && q.resets && q.resets <= now);
  const pct = !q || expired ? 0 : q.pct;
  const frac = q && !expired ? elapsed(q.resets, q.duration, now) : null;
  return {
    pct,
    shown: Math.max(0, pct),
    mark: opts.pace ? frac : null,
    color: statusColor(pct, frac),
    tier: opts.pace ? paceTier(pct, frac) : null,
    resets: q && q.resets && !expired ? q.resets : null,
    minutes: q ? q.minutes : 0,
  };
}

// ---------------------------------------------------------------- svg

function color(name, dark) {
  return SYS[name][dark ? 1 : 0];
}

function text(x, y, size, weight, fill, opacity, s, anchor) {
  if (anchor === "middle") x -= textWidth(s, size) / 2;
  return (
    `<text x="${x}" y="${y}" font-family="${FONT}" font-weight="${weight >= 600 ? 700 : 400}" font-size="${size}"` +
    ` fill="${fill}" fill-opacity="${opacity}">${s}</text>`
  );
}

function tick(x1, y1, x2, y2, stroke) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`;
}

// Each style returns { w, h, body } for one quota. `v` is a view(), `label`
// is "Session"/"Week", `fg` the bar's text color, `fill` the status color,
// `pace` the pace tick color (fg when pace tiers are off or unavailable).
const STYLES = {
  // The status bar resamples anything taller than 18pt, so the tracker's
  // 42x28 layout is squeezed vertically: an 8pt bar over a 7.5pt label.
  battery(v, label, fg, fill, pace) {
    let out =
      `<rect x="1.6" y="1" width="39.4" height="7" rx="2" fill="none" stroke="${fg}" stroke-opacity="0.5" stroke-width="1.2"/>`;
    const fw = 36 * Math.min(v.shown / 100, 1);
    if (fw > 1) out += `<rect x="3" y="2.5" width="${fw}" height="4" rx="1.2" fill="${fill}"/>`;
    if (v.mark !== null) {
      const x = Math.round(3 + 36 * v.mark);
      out += tick(x, 1, x, 8, pace);
    }
    out += text(21, 17, 7.5, 500, fg, 0.85, opts.labels ? label : Math.floor(v.shown) + "%", "middle");
    return { w: 42, h: 18, body: out };
  },

  bar(v, label, fg, fill, pace) {
    const x0 = opts.labels ? 13 : 1;
    let out = "";
    if (opts.labels) out += text(1, 13, 10, 600, fg, 0.9, label[0]);
    out += `<rect x="${x0}" y="4.5" width="40" height="9" rx="4" fill="${fg}" fill-opacity="0.2"/>`;
    const fw = 40 * Math.min(v.shown / 100, 1);
    if (fw > 1) {
      out += `<rect x="${x0}" y="4.5" width="${fw}" height="9" rx="4" fill="${fill}"/>`;
      if (v.mark !== null) {
        const x = Math.round(x0 + 40 * v.mark);
        out += tick(x, 4.5, x, 13.5, pace);
      }
    }
    return { w: x0 + 42, h: 18, body: out };
  },

  // 18pt is all the status bar gives, so the stroke runs to the slot's edge.
  ring(v, label, fg, fill, pace) {
    const size = 18;
    const r = (size - 3) / 2;
    const cx = 1 + size / 2;
    const cy = size / 2;
    const c = 2 * Math.PI * r;
    let out = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fg}" stroke-opacity="0.15" stroke-width="3"/>`;
    const len = c * Math.min(v.shown / 100, 1);
    if (len > 0) {
      out +=
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fill}" stroke-width="3" stroke-linecap="round"` +
        ` stroke-dasharray="${len} ${c}" transform="rotate(-90 ${cx} ${cy})"/>`;
    }
    if (v.mark !== null) {
      const a = (-90 + 360 * v.mark) * (Math.PI / 180);
      out += tick(cx + (r - 2) * Math.cos(a), cy + (r - 2) * Math.sin(a), cx + (r + 2) * Math.cos(a), cy + (r + 2) * Math.sin(a), pace);
    }
    if (opts.labels) out += text(cx, cy + 3.3, 9, 700, fg, 1, label[0], "middle");
    return { w: size + 1, h: size, body: out };
  },

  percent(v, label, fg, fill, pace) {
    const s = (opts.labels ? label[0] + ": " : "") + Math.floor(v.shown) + "%";
    const tw = Math.ceil(s.length * 7.2) + 4;
    let out = text(2, 13, 12, 600, fill, 1, s);
    let w = tw + 2;
    if (v.tier !== null) {
      out += `<circle cx="${w + 4}" cy="9" r="2" fill="${pace}"/>`;
      w += 8;
    }
    return { w, h: 18, body: out };
  },

  compact(v, label, fg, fill, pace) {
    let x = 1;
    let out = "";
    if (opts.labels) {
      out += text(1, 12.5, 9, 500, fg, 0.85, label[0] + ":");
      x = 18;
    }
    out += `<circle cx="${x + 4}" cy="9" r="4" fill="${fill}"/>`;
    x += 8;
    if (v.tier !== null) {
      out += `<circle cx="${x + 4}" cy="9" r="2" fill="${pace}"/>`;
      x += 6;
    }
    return { w: x, h: 18, body: out };
  },
};

function render(dark) {
  const fg = dark ? "#FFFFFF" : "#000000";
  const mono = opts.color === "mono";
  const now = Date.now();
  const parts = [];
  const want = (opts.show || "both").toLowerCase();
  if (want !== "week") parts.push(["Session", view(data && data.session, now)]);
  if (want !== "session") parts.push(["Week", view(data && data.week, now)]);
  const draw = STYLES[opts.style] || STYLES.battery;
  const pieces = parts.map(([label, v]) => {
    const fill = mono ? fg : color(v.color, dark);
    const pace = v.tier !== null && !mono ? color(PACE_COLOR[v.tier], dark) : fg;
    return draw(v, label, fg, fill, pace);
  });
  const gap = 6;
  const h = Math.max(...pieces.map((p) => p.h));
  const w = pieces.reduce((n, p) => n + p.w, 0) + gap * (pieces.length - 1);
  let x = 0;
  let body = "";
  for (const p of pieces) {
    body += `<g transform="translate(${x} ${(h - p.h) / 2})">${p.body}</g>`;
    x += p.w + gap;
  }
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`,
    // A monochrome icon is a plain mask the bar tints for its own background.
    template: mono,
  };
}

// ---------------------------------------------------------------- menu

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const DASH_GREEN = ["#1B6B34", "#3CC75F"];

function card(title, tag, subtitle, v, dark, now) {
  const fill = v.color === "green" ? DASH_GREEN[dark ? 1 : 0] : color(v.color, dark);
  const pace = v.tier !== null ? color(PACE_COLOR[v.tier], dark) : "canvastext";
  const width = Math.min(v.shown / 100, 1) * 100;
  return (
    `<div class="row"><div class="head"><div class="t">${esc(title)}` +
    (tag ? `<span class="tag">${esc(tag)}</span>` : "") +
    (subtitle ? `<div class="sub">${esc(subtitle)}</div>` : "") +
    `</div><div class="pct" style="color:${fill}">${Math.floor(v.shown)}%</div></div>` +
    `<div class="bar"><div class="fill" style="width:${width}%;background:${fill}"></div>` +
    (v.mark !== null ? `<div class="mark" style="left:calc(${v.mark * 100}% - 0.75px);background:${pace}"></div>` : "") +
    `</div>` +
    (v.resets ? `<div class="reset">Resets in ${resetsIn(v.resets, now)}</div>` : "") +
    `</div>`
  );
}

// Card height in points: frame and head, then a line each for subtitle and
// reset. The web row clips, so this has to be right.
function cardHeight(subtitle, v) {
  return 48 + (subtitle ? 13 : 0) + (v.resets ? 15 : 0);
}

const CSS =
  "<style>" +
  "body{margin:0;padding:8px 14px;font:13px -apple-system,sans-serif;color:canvastext}" +
  ".row{border:0.5px solid color-mix(in srgb,canvastext 10%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:6px}" +
  ".head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px}" +
  ".t{font-weight:500}.tag{font-size:9px;font-weight:500;color:graytext;" +
  "background:color-mix(in srgb,canvastext 8%,transparent);border-radius:99px;padding:1px 5px;margin-left:6px;vertical-align:1px}" +
  ".sub{font-size:10px;color:graytext;margin-top:1px}" +
  ".pct{font-weight:600;font-variant-numeric:tabular-nums}" +
  ".bar{position:relative;height:4px;border-radius:2.5px;background:color-mix(in srgb,canvastext 8%,transparent)}" +
  ".fill{height:4px;border-radius:2.5px;transition:width .6s ease-in-out}" +
  ".mark{position:absolute;top:-2px;width:2.5px;height:8px;border-radius:1px}" +
  ".reset{font-size:9px;color:graytext;margin-top:4px}" +
  ".foot{font-size:10px;color:graytext;margin:2px 2px 0}" +
  "</style>";

function tokens(n) {
  if (!n) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B tokens";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M tokens";
  if (n >= 1e3) return Math.round(n / 1e3) + "K tokens";
  return n + " tokens";
}

// The popover's own inset: 14pt sides, 8pt top and bottom.
function dashboard(dark) {
  const now = Date.now();
  let html = CSS;
  let height = 16;
  const add = (title, v) => {
    const sub = v.minutes ? "rolling " + windowName(v.minutes).toLowerCase() + " window" : "";
    html += card(title, "", sub, v, dark, now);
    height += cardHeight(sub, v);
  };
  const s = view(data.session, now);
  const w = view(data.week, now);
  add(windowName(s.minutes) || "Session", s);
  add(windowName(w.minutes) || "Week", w);
  // Codex only writes these numbers while it runs, so their age is part of
  // the reading: a plugin that hid it would show yesterday's usage as today's.
  const foot = [tokens(data.tokens), data.at ? "read " + duration(Math.max(0, now - data.at)) + " ago" : null]
    .filter(Boolean)
    .join(" · ");
  if (foot) {
    html += `<div class="foot">${esc(foot)}</div>`;
    height += 16;
  }
  return { html, height };
}

// The bar follows the wallpaper, not only the system theme, so the icon asks
// the bar (Macotron 0.5.6+) and the dropdown asks the system.
function barIsDark() {
  return macotron.menubar.isDark ? macotron.menubar.isDark() : macotron.system.darkMode();
}

function paint() {
  const dark = macotron.system.darkMode();
  const icon = render(barIsDark());
  macotron.menubar.status("codex-usage", {
    title: "",
    svg: icon.svg,
    template: icon.template,
    menu: [
      // A plain row until there is something to draw; stale data stays up
      // with the error under it.
      ...(data ? [Object.assign({ title: "", width: 280 }, dashboard(dark))] : [{ title: error || "Loading…" }]),
      ...(data && error ? [{ title: error }] : []),
      "-",
      { title: "Refresh", onClick: refresh },
      { title: "Open usage page", onClick: () => macotron.url.open("https://chatgpt.com/codex/settings/usage") },
      { title: "Settings…", onClick: () => macotron.settings.open() },
    ],
  });
  const now = Date.now();
  macotron.checks([
    {
      title: "Codex sessions",
      ok: !error,
      message:
        error ||
        (data ? "Session " + Math.floor(view(data.session, now).pct) + "% · Week " + Math.floor(view(data.week, now).pct) + "%" : "Waiting"),
    },
  ]);
}

// ---------------------------------------------------------------- read

// ~/.codex/sessions/YYYY/MM/DD/rollout-<date>T<time>-<uuid>.jsonl. Both the
// date directories and the file names sort newest-last, so walking the sorted
// lists backwards visits the rollouts in the order they were written.
function rollouts(limit) {
  const desc = (dir) => (macotron.fs.list(dir) || []).slice().sort().reverse();
  const out = [];
  for (const y of desc(ROOT)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of desc(ROOT + "/" + y)) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of desc(ROOT + "/" + y + "/" + m)) {
        if (!/^\d{2}$/.test(d)) continue;
        const dir = [ROOT, y, m, d].join("/");
        for (const f of desc(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          out.push(dir + "/" + f);
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

// The shape has moved between Codex versions — rate_limits has sat on the
// event, on its payload, and inside payload.info — so look for the key rather
// than a path. Depth stops it walking a whole transcript.
function find(o, key, depth) {
  if (!o || typeof o !== "object" || depth < 0) return null;
  if (o[key] && typeof o[key] === "object") return o[key];
  for (const k in o) {
    const hit = find(o[k], key, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function num(v) {
  const n = parseFloat(String(v === undefined || v === null ? "" : v).replace("%", ""));
  return isFinite(n) ? n : 0;
}

// resets_in_seconds counts from when the event was written, not from now.
function quota(w, at) {
  if (!w) return null;
  const minutes = num(w.window_minutes);
  const secs = w.resets_in_seconds !== undefined && w.resets_in_seconds !== null ? num(w.resets_in_seconds) : null;
  const resets = w.resets_at ? Date.parse(w.resets_at) || num(w.resets_at) * 1000 : secs !== null ? at + secs * 1000 : null;
  return { pct: num(w.used_percent), minutes, duration: minutes * MINUTE, resets: resets || null };
}

// The last line in the file that carries rate limits is the newest reading.
function scan(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.indexOf('"rate_limits"') < 0) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch (err) {
      continue;
    }
    const limits = find(e, "rate_limits", 4);
    if (!limits || (!limits.primary && !limits.secondary)) continue;
    const at = Date.parse(e.timestamp || (e.payload && e.payload.timestamp) || "") || Date.now();
    const used = find(e, "total_token_usage", 4);
    return {
      session: quota(limits.primary, at),
      week: quota(limits.secondary, at),
      tokens: used ? num(used.total_tokens) : 0,
      at,
    };
  }
  return null;
}

function read() {
  if (!macotron.fs.exists(ROOT)) throw new Error("No ~/.codex/sessions — is the Codex CLI installed?");
  const files = rollouts(FILES);
  if (!files.length) throw new Error("No Codex sessions yet");
  for (const f of files) {
    let hit = null;
    try {
      hit = scan(macotron.fs.read(f) || "");
    } catch (e) {
      console.log("codex: " + f + ": " + e.message);
    }
    if (hit) return hit;
  }
  throw new Error("No rate limits in the last " + files.length + " sessions — run Codex once");
}

let busy = false;

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    data = read();
    error = null;
  } catch (e) {
    error = String(e.message || e);
    console.warn("codex: " + error);
  }
  busy = false;
  paint();
}

paint();
refresh();
macotron.every(Math.max(10000, Number(opts.refreshMs) || 60000), refresh);
// The window keeps moving while the file stands still, so the tick and the
// countdown redraw each minute between reads.
macotron.every(60000, paint);
macotron.on("menubar:appearance", paint);

# Codex Usage for Macotron

The OpenAI [Codex CLI](https://github.com/openai/codex)'s rate limits in the
[Macotron](https://github.com/statico/macotron) menu bar. A sibling of
[Claude Usage](https://github.com/statico/macotron-plugin-claude-usage): same
icon styles, same thresholds, same colors, same pace marker.

- Five icon styles: battery, progress bar, ring, percentage, compact dot.
- Green under 70%, orange under 90%, red above. Once 15% of a window has
  passed, the color follows the projected usage instead of the raw number.
- A pace tick sits at the elapsed fraction of the window. Its color says how
  far ahead of it you are: green, teal, yellow, orange, red, purple.
- Click the item for a dashboard with both windows, their reset times, the
  session token total, and how old the reading is.

No key, no network, no third-party binary. The plugin reads files the Codex
CLI already writes.

## Install

1. Open Macotron. Go to Settings → Plugins → Catalog → Community.
2. Find **Codex Usage**. Press **Add**.
3. Read the source in the review sheet. Press **Add** again.

## How it works

The Codex CLI logs every session to
`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`. Each time it calls
the API it writes a `token_count` event, and that event carries the rate-limit
windows the server reported:

```json
{"timestamp":"2026-09-21T09:50:00Z","type":"event_msg","payload":{"type":"token_count",
  "info":{"total_token_usage":{"total_tokens":1250000},
  "rate_limits":{"primary":{"used_percent":42.5,"window_minutes":300,"resets_in_seconds":7800},
                 "secondary":{"used_percent":61,"window_minutes":10080,"resets_in_seconds":259800}}}}}
```

The plugin walks the rollouts newest first and takes the last reading it
finds. `primary` is the short rolling window and `secondary` the weekly one;
Codex names neither, so the labels come from `window_minutes` — the plugin
says "5-hour" because the file said 300, not because it assumes five hours.
`resets_in_seconds` counts from the event, not from now, so the countdown is
anchored to the timestamp on the line.

Sessions that never called the API have no limits in them, and the shape has
moved between Codex versions, so the reader skips empty files and looks for
the `rate_limits` key wherever it sits on the event.

## The numbers are as old as your last Codex run

Nothing polls OpenAI. A window only moves when Codex runs, so the dashboard
prints the age of the reading ("read 10m ago") next to the token total. A
window whose reset time has passed has rolled over since the file was written,
so it shows 0% rather than a stale number.

For the authoritative figure, open
[chatgpt.com/codex/settings/usage](https://chatgpt.com/codex/settings/usage) —
the **Open usage page** row in the menu goes there.

## Test

```sh
node test.js
```

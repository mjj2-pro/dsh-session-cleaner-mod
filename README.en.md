# dsh-session-cleaner (modified build)

> A **true delete** for DeepSeek Harness: clean removal, a 15-day recycle bin, and titles that match what you actually renamed the session to.

This is an **independent modified build**, not a mirror of upstream. It is based on
[jackxiao17/dsh-session-cleaner](https://github.com/jackxiao17/dsh-session-cleaner) v0.7.7 (MIT).
The delete pipeline, title resolution, list performance and UI copy were reworked.
It does not track or merge upstream.

- Version: `0.8.1-mod.1`
- Tested on: DSH 0.2.x (0.2.2-rc.1 / rc.5)
- License: MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE)

## What it does

- Adds a red **Delete** item to the sidebar session `···` menu (below *Archive*).
- Moves the session — **whole subagent tree included** — into the plugin's own recycle bin:
  session log directory, workspace accounting slot, pin, archive flag, projection-cache
  row (plus the host's `.bak` copies) and bound scheduled tasks.
- Before deleting, lists the files the session produced, split into **deliverables**
  (`present`) and **intermediate artifacts** (`write` / `edit` / …), pre-selected,
  uncheck to keep. Produced files are **moved into the bin**, and come back when the
  session is restored.
- Restoring puts everything back where it was, including the sidebar position.
- Crash-safe: the bin writes its snapshot **before** touching files, and reconciles
  on the next start (repair / roll back / adopt orphans).

## What changed in this build

| Area | Change |
|---|---|
| **Titles** | Fold the *last* `session/title` event by scanning back to frame 6 instead of a bounded 160-frame window (the old window could never reach the real title). Cached by `mtime:size` and persisted to disk. |
| **List performance** | 16-way concurrent header reads, no duplicate header reads, `>= 2 KB` sessions are never decompressed to decide "blank". Measured: 3202 ms → **284 ms cold / 80–93 ms warm** (166 sessions). |
| **Copy** | Recycle-bin retention is 15 days (the UI used to say 30); produced files are recoverable with the session (the UI used to say they were not). |
| **Startup** | Recycle-bin reconciliation is deferred by 15 s and both timers are `unref()`ed, so the plugin stays off the host's startup I/O path. |

## Not done (honest list)

- No unit tests — verification is done against real API numbers, not assumptions.
- Batch delete does not handle produced files (unpacking every log is too slow).
- `im:xxx` sessions are rejected (`assertSessionId` refuses colons).
- Logs over 24 MB only read their head, so their title may stay at the frame-6 version.
- Scheduled tasks are recorded but not removed (the host cannot recreate them).
- No custom collapsible group in the sidebar — `sidebar.workspaces` is a single slot
  owned by the official WorkspaceBrowser.

## Install

1. Copy this repository to `<DSH_HOME>/profiles/desktop/local/dsh-session-cleaner`.
2. In the profile `package.json` add `"dsh-session-cleaner": "file:./local/dsh-session-cleaner"`
   and `"dsh-session-cleaner"` to `dsh.profile.bundles`.
3. Run `pnpm install` in the profile directory.
4. **Restart DSH** (host-half changes are cached by package name).
5. Check `GET /session-cleaner/api/health` returns `{"ok":true,...}`.

Not published to any plugin-market index yet; install from this Git repository.

## About the author and AI

The author is a heavy DSH user and **does not write code**. The code was produced by AI
under explicit requirements, real measurements and hands-on acceptance testing.

- **Bug reports are welcome.** The author uses this plugin daily; anything that hurts
  daily use gets fixed.
- **Small/edge issues: pull requests are welcome** — including PRs written with AI help.
  [`DEVELOPMENT.md`](DEVELOPMENT.md) exists precisely for "the next AI that picks this up".
- **No response-time promise.** This is a personal project, not a product.

## Credits

- Base: jackxiao17/dsh-session-cleaner (MIT).
- Title resolution draws on xohmai/dsh-session-delete (Apache-2.0); see [NOTICE](NOTICE).

中文说明见 [README.md](README.md)。

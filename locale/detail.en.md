Deleting a session does not just move its log directory: every trace it left behind — the workspace accounting slot, its pin, its archive flag, and the projection-cache row (including the host's `.bak` copies) — is cleaned up too. A session with subagents moves as a whole tree; restoring puts everything back, including the original sidebar position; and a permanent delete clears the schedules bound to it.

**This modified build** additionally reworks title resolution (no more first-sentence truncation) and session-list performance (list opens in milliseconds instead of ~3 seconds), and fixes two stale UI strings ("30 days" and "deleted files cannot be recovered").

Full documentation, screenshots and install steps: [GitHub repository](https://github.com/mjj2-pro/dsh-session-cleaner-mod).

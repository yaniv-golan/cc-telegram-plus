"""Check if this hook is running inside a Claude Code instance that has an
active Telegram session.  Exits 0 (truthy) if yes, exits 1 if no.

Usage from bash:
  if python3 "$SCRIPT_DIR/lib/session-guard.py"; then
    # proceed — this CC instance owns the active Telegram session
  fi

How it works:
  The hook process and the MCP server (bun) are both descendants of the same
  `claude` process.  We walk up the process tree from our PID and from each
  session PID in sessions.json to find their `claude` ancestor.  If they match
  and the session is active, this hook should fire.

Verified process tree (2026-03-22):
  claude → bun (wrapper) → bun (server, PID in sessions.json)
  claude → zsh → python3 (hook)
"""

import json
import os
import subprocess
import sys

SESSIONS_FILE = os.path.expanduser("~/.claude/channels/telegram/sessions.json")


def get_parent(pid: int) -> tuple[int, str]:
    """Return (ppid, comm) for a given PID."""
    out = subprocess.check_output(
        ["ps", "-o", "ppid=,comm=", "-p", str(pid)], text=True
    ).strip()
    parts = out.split(None, 1)
    return int(parts[0]), (parts[1] if len(parts) > 1 else "")


def find_claude_ancestor(pid: int) -> int | None:
    """Walk up the process tree to find the `claude` process."""
    cur = pid
    for _ in range(10):
        try:
            ppid, comm = get_parent(cur)
        except Exception:
            return None
        # Match "claude" but not "Cursor Helper" which also contains substrings
        # comm is the command name of `cur`; ppid is its parent
        if comm.strip().endswith("claude") or comm.strip() == "claude":
            return cur
        if ppid <= 1:
            return None
        cur = ppid
    return None


def main() -> None:
    my_claude = find_claude_ancestor(os.getpid())
    if not my_claude:
        sys.exit(1)

    try:
        with open(SESSIONS_FILE) as f:
            sessions = json.load(f).get("sessions", {})
    except Exception:
        sys.exit(1)

    for sess in sessions.values():
        spid = sess.get("pid")
        if not spid:
            continue
        sess_claude = find_claude_ancestor(spid)
        if sess_claude == my_claude and sess.get("active"):
            sys.exit(0)  # match — this CC instance has the active session

    sys.exit(1)


if __name__ == "__main__":
    main()

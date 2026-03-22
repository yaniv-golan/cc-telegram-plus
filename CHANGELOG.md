# Changelog

## [0.1.1] — 2026-03-22

### Fixed
- Permission prompt notifications no longer fire for non-Telegram sessions.
  Previously, any Claude Code session with the plugin loaded would send
  "Approval needed" alerts to Telegram, even CLI/IDE sessions with no
  Telegram user. A session guard now checks that the hook is running inside
  the CC instance that owns the active Telegram session.
- Activity hook (`activity.sh`) applies the same guard, preventing activity
  entries from non-Telegram sessions from polluting `activity.jsonl`.

### Added
- `hooks/lib/session-guard.py` — shared process-tree check used by both hooks
  to identify whether the current CC instance owns the active Telegram session.

## [0.1.0] — 2026-03-21

Initial release.

### Channel features
- All media types: photos, documents, video, audio, voice, stickers
- Voice message auto-transcription via Whisper (requires `OPENAI_API_KEY`)
- Reply context: Claude sees quoted messages when you reply
- Inbound emoji reactions forwarded to Claude
- Inline keyboards and reply keyboards in Claude's responses
- MarkdownV2 and HTML formatting in replies
- Ack reaction on receipt, auto-cleared when Claude replies

### Session management
- Single-poller guarantee: only one session polls Telegram at a time
- `/sessions` — shows active session with switch buttons for others
- `/switch` — interactive session switching (by name or buttons)
- `/name` — rename the active session (with force-reply prompt)
- `/status` — show which session is active
- `/chatid` — show chat ID
- Pinned "Active session: **name**" message on switch and rename
- Fast failover: if active session dies, another takes over in ~3s
- Session labels derived from IDE name + project directory
- SIGUSR1 for instant wake-up on switch (no 3s polling delay)
- Pidfile-based instance verification to handle PID reuse

### Live activity indicators
- Tool progress shown in Telegram as an updating message
  (e.g., 📄 Read server.ts → 💻 $ bun test → ✏️ Edit handlers.ts)
- Accumulated tool history: each update shows all tools used so far
- Permission prompt alerts sent directly to Telegram via hook
- Progress message auto-deleted when Claude finishes (1.5s grace period)

### Architecture
- Two-phase server startup: MCP handshake first, Telegram API after
- Capability key `'claude/channel': {}` matching official plugin
- `bot.stop()` properly awaited before session switch (prevents 409)
- Zombie process cleanup: `stdin.on('end')` exits on CC disconnect
- Compatible with `--dangerously-load-development-channels` flag

### Documentation
- User-facing README with feature comparison, setup guide, and
  troubleshooting
- Advanced configuration reference for `access.json` fields
- Permissions and unattended use guidance
- Detailed setup, troubleshooting, and configuration guides in README

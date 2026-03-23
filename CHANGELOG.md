# Changelog

## [0.4.0] — 2026-03-23

### Added
- **Secret scrubbing.** Outbound messages are scanned for known secret
  patterns (API keys, AWS credentials, GitHub tokens, Slack tokens, PEM
  private keys, Bearer tokens, Telegram bot tokens) and redacted before
  reaching Telegram. Defense-in-depth — catches secrets Claude doesn't
  notice in log output or config snippets. New module: `src/scrub.ts`.
- **Media group buffering.** Photo albums sent from Telegram are now
  delivered as a single notification (`[Album: N items]` with all media
  tokens) instead of N separate messages. Uses a 1-second buffer keyed
  by `media_group_id`.
- **Activity levels.** New `activityLevel` field in `access.json`:
  - `0` — silent: no activity indicators in Telegram
  - `1` — standard (default): tool names shown, deleted on completion
  - `2` — verbose: fuller tool detail, persistent per-tool summary on
    completion (e.g. `✅ Read ×3, Bash ×2 (4.1s)`)
- **Reply-chain walking.** Reply context now walks up to 3 levels of
  the reply chain (using Telegram's `reply_to_message` + message cache),
  formatted as `[Thread: "msg1" → "msg2" → "msg3"]`. Previously only
  the immediate parent was shown.
- **Environment variable scrubbing.** `TELEGRAM_BOT_TOKEN` and
  `OPENAI_API_KEY` are deleted from `process.env` after loading to
  prevent leakage if Claude runs `printenv`.

### Fixed
- **Permission relay: session switch orphans.** Permission prompts
  created by one session are now cleaned up when the user switches to
  another session. Previously, tapping buttons after a switch showed
  "Already resolved" even though the request was never answered.
- **Permission relay: fast-tap race.** Pending entries are now inserted
  before messages are sent, so a fast button tap no longer returns
  "Already resolved" during the send window.
- **Permission relay: retry on failure.** If the MCP notification fails,
  the pending entry is re-inserted with a 30-second TTL so the user can
  tap again. Toast changed from "respond in terminal" to "tap again to
  retry".
- **Graceful shutdown.** `stop()` now removes the pidfile before the
  session entry so peers see us as dead via `isSessionAlive()` before
  they can self-promote. SIGINT/SIGTERM handlers now call `process.exit(0)`
  after cleanup — previously the process stayed alive in a half-dead state.
- **Switch recovery.** If `switchTo()` stops polling but the target
  session vanishes, the current session restarts its own poller instead
  of leaving a dead window until the watcher notices.
- **Session label derivation.** Project name now derived from
  `CLAUDE_PROJECT_DIR` / `cwd()` instead of `OLDPWD` (which is the
  shell's *previous* directory, not the current one).

## [0.3.0] — 2026-03-22

### Added
- **Permission relay — approve/deny from Telegram.** When Claude needs
  permission to use a tool (Bash, Edit, Write, etc.), an inline-keyboard
  message with Allow / Deny buttons is sent to Telegram. Tap a button and
  Claude continues immediately — no need to switch to the terminal.
  Uses the native `--channels` permission relay protocol introduced in
  Claude Code v2.1.81. Falls back to the terminal prompt for interactive
  tools that CC excludes from the relay.
- `src/permission-relay.ts` — new module handling the CC ↔ Telegram
  permission negotiation via MCP notifications.
- `docs/channel-permission-relay.md` — protocol documentation
  (reverse-engineered from CC v2.1.81 binary).

### Changed
- `notify-permission.sh` hook removed from `hooks.json`. The hook file is
  kept on disk for rollback but no longer fires. Permission prompts are now
  handled by the native relay instead of a one-way notification.
- MCP server declares `claude/channel/permission` capability alongside
  `claude/channel`.
- Activity progress line changed from "Waiting for approval in terminal"
  to "Awaiting approval" (neutral — covers both relay and terminal paths).
- Instructions narrowed: Claude now tells Telegram users about terminal
  approval only for the rare interactive tools excluded from the relay.

## [0.2.0] — 2026-03-22

### Added
- **AskUserQuestion → Telegram routing.** When Claude needs a decision
  (confirmation, choice between options), the prompt is forwarded to Telegram
  with inline buttons instead of blocking in the terminal. Tap a button or
  type a reply on your phone — Claude continues immediately. Falls through
  to the terminal prompt for multi-question, multi-select, or multi-user
  setups. Requires a single `allowFrom` user and an active Telegram session.
- `hooks/lib/session-guard.py` — shared process-tree check used by hooks
  to identify whether the current CC instance owns the active Telegram session.

### Fixed
- Permission prompt notifications no longer fire for non-Telegram sessions.
  Previously, any Claude Code session with the plugin loaded would send
  "Approval needed" alerts to Telegram, even CLI/IDE sessions with no
  Telegram user. The session guard now prevents this.
- Activity hook (`activity.sh`) applies the same guard, preventing activity
  entries from non-Telegram sessions from polluting `activity.jsonl`.
- Session activation deadlock: if all sessions ended up with `active: false`
  (e.g., after crashes), no session could ever become active. Now `activate()`
  self-promotes when no active session exists.

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

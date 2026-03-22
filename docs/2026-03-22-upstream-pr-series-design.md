# Upstream PR Series: Contributing cc-telegram-plus to claude-plugins-official

## Overview

Contribute cc-telegram-plus enhancements back to the upstream telegram plugin in `anthropics/claude-plugins-official` via a series of focused PRs. The strategy is hybrid: start with small, self-contained patches against the upstream monolithic `server.ts` to build trust with maintainers, then propose an architecture refactor, then layer major features on top.

## Target Repository

- **Repo:** `anthropics/claude-plugins-official`
- **Path:** `external_plugins/telegram/`
- **Structure:** Single monolithic `server.ts` (~600 lines)
- **License:** Apache-2.0 (our PRs are new code contributed under their license; cc-telegram-plus remains MIT independently)
- **PR history:** Active — 16 open, 30+ closed, multiple external telegram PRs already merged

## PR Series

### Phase 1: Trust-Building

Small, self-contained patches against the upstream `server.ts`. No architectural changes. Each PR is independent and can merge in any order.

---

#### PR 1: Rich Reply Formatting

**Title:** `feat(telegram): add parse_mode, inline/reply keyboards to reply tool`

**Scope:** Extend the `reply` MCP tool to support rich formatting and interactive elements.

**Changes to `server.ts`:**
- Add optional parameters to the reply tool schema:
  - `parse_mode` (`"MarkdownV2"` | `"HTML"`) — enables formatted text
  - `inline_keyboard` (`[[{text, callback_data}]]`) — action buttons on messages
  - `reply_keyboard` (`[["Option A"], ["Option B"]]`) — custom input prompts replacing the phone keyboard
  - `one_time_keyboard` (`boolean`) — auto-hide reply keyboard after selection
  - `remove_keyboard` (`boolean`) — remove a previously set reply keyboard
- Pass these through to the Grammy `bot.api.sendMessage()` call
- Handle callback query events from inline keyboard presses, delivering them as `[Button pressed: callback_data]`

**Why this first:** High value, small diff, no new dependencies. Unlocks structured interactions (confirmations, option selection) that Claude can use immediately.

**Acceptance criteria:**
- Claude can send MarkdownV2-formatted replies
- Inline keyboards render and callback data reaches Claude
- Reply keyboards work with one-time and removal modes
- Backward compatible — omitting all new params behaves identically to current

---

#### PR 2: Reply Context

**Title:** `feat(telegram): include quoted message when user replies`

**Scope:** When a Telegram user replies to a specific message, include the quoted text in the context delivered to Claude.

**Changes to `server.ts`:**
- In the message handler, check for `msg.reply_to_message`
- If present, extract the text content of the replied-to message
- Prepend it to the delivered text as `[Replying to: "quoted text"]`

**Why:** Tiny diff (~10 lines), but significantly improves conversation coherence. Without this, Claude sees replies without knowing what they're responding to.

**Acceptance criteria:**
- Reply-to messages include quoted context
- Non-reply messages are unaffected
- Long quoted text is truncated to a reasonable length (e.g., 200 chars)

---

#### PR 3: Smart Text Chunking

**Title:** `feat(telegram): newline-aware text chunking`

**Scope:** Improve message splitting to prefer paragraph boundaries over hard character-limit cuts.

**Changes to `server.ts`:**
- Add `chunkMode` option to `access.json` schema: `"length"` (current behavior) | `"newline"` (new)
- In the chunking logic, when `chunkMode` is `"newline"`, find the last newline before the 4096-char limit and split there
- Fall back to hard split if no newline is found within a reasonable range
- Add `textChunkLimit` config option (default 4096) for customization

**Changes to `ACCESS.md`:**
- Document `chunkMode` and `textChunkLimit` options

**Why:** Small diff, fixes a real annoyance where code blocks and formatted text get split mid-line. Low risk since it's opt-in via config.

**Acceptance criteria:**
- Default behavior (`"length"`) is unchanged
- `"newline"` mode splits at paragraph boundaries
- Falls back to hard split when no suitable newline exists
- `textChunkLimit` overrides the 4096 default

---

### Phase 2: Foundation

These PRs depend on Phase 1 being merged (or at least reviewed positively). They change the project structure.

---

#### PR 4: Architecture Refactor

**Title:** `refactor(telegram): modularize server.ts into focused modules`

**Scope:** Split the monolithic `server.ts` into separate, focused modules with no feature changes.

**New file structure:**
```
external_plugins/telegram/
  src/
    server.ts      — MCP server orchestration, startup
    handlers.ts    — Inbound message routing and processing
    tools.ts       — MCP tool implementations (reply, react, edit_message, fetch_media)
    media.ts       — Media download logic
    gate.ts        — Access control validation
    access-io.ts   — Access file I/O
    chunk.ts       — Text chunking
    cache.ts       — Message content cache
    types.ts       — Shared TypeScript type definitions
  tsconfig.json    — TypeScript strict mode config
  package.json     — Updated start script to src/server.ts
```

**Principles:**
- Pure restructuring — no behavioral changes
- Each module has one clear responsibility
- Well-defined interfaces between modules
- Strict TypeScript mode enabled

**Why now:** After Phase 1 demonstrates the value of our contributions, this sets up the codebase for maintainability. The monolith is already ~600 lines and growing with each PR.

**Risk mitigation:**
- PR description includes a mapping from old `server.ts` line ranges to new modules
- Every function and handler is accounted for
- Can be verified by running the plugin before and after

**Acceptance criteria:**
- Plugin behavior is identical before and after
- All existing functionality preserved
- No new features introduced
- TypeScript strict mode passes

---

#### PR 5: Test Suite + CI

**Title:** `test(telegram): add comprehensive test suite and CI pipeline`

**Scope:** Add tests for all modules and a GitHub Actions CI workflow.

**New files:**
```
tests/
  helpers.ts           — Test utilities, mocks
  chunk.test.ts        — Chunking logic tests
  gate.test.ts         — Access control tests
  media.test.ts        — Media handling tests
  handlers.test.ts     — Message handler tests
  tools.test.ts        — Tool implementation tests
  cache.test.ts        — Cache tests
  sessions.test.ts     — (placeholder for PR 6)
.github/workflows/ci.yml  — Bun test on PR and push
```

**Changes to `package.json`:**
- Add `"test": "bun test"` script
- Add `bun-types` dev dependency

**Why after refactor:** Tests import from separate modules. They validate that the refactor didn't break anything and provide a safety net for future PRs.

**Acceptance criteria:**
- All tests pass
- CI runs automatically on PRs
- Coverage for core logic paths (chunking, access control, media handling)

---

### Phase 3: Major Features

These build on the modular architecture from Phase 2. PRs 6 and 7 are independent. PR 8 depends on PR 6.

---

#### PR 6: Session Management

**Title:** `feat(telegram): multi-session management with failover`

**Scope:** Add session coordination so multiple Claude Code instances can share a bot without conflicts.

**New files:**
- `src/sessions.ts` — Session coordination, polling, activation, switchover
- `src/lock.ts` — Pidfile-based instance identification

**Key features:**
- **Single-poller guarantee:** Only one CC instance polls Telegram at a time
- **Bot commands:**
  - `/sessions` — List active sessions with switch buttons
  - `/switch` — Interactive session switching via inline keyboard
  - `/name <label>` — Rename the active session
  - `/status` — Show current active session
  - `/chatid` — Show current chat ID
- **Pinned status message:** Active session indicator pinned in chat
- **Fast failover:** ~3 second recovery when active session dies
- **PID reuse detection:** Pidfile-based verification prevents stale session references

**Changes to existing files:**
- `src/server.ts` — Integrate session lifecycle with MCP startup/shutdown
- `src/handlers.ts` — Route bot commands, session-aware message delivery

**Acceptance criteria:**
- Only one instance polls at a time
- `/sessions` shows all connected instances with switch buttons
- Switching is fast and reliable
- Dead sessions are detected and cleaned up within ~3 seconds
- Works correctly with a single instance (no-op graceful degradation)

---

#### PR 7: Extended Media Support

**Title:** `feat(telegram): support all media types and voice transcription`

**Scope:** Handle all Telegram media types and optionally transcribe voice messages.

**Changes to `src/media.ts`:**
- Add handlers for: documents, video, audio, voice, stickers
- Add retry logic for media downloads
- Add `transcribeAudio()` function using OpenAI Whisper API (optional)

**Changes to `src/handlers.ts`:**
- Route all media types through the media handler
- Deliver voice transcripts as `[Voice: "transcribed text"]`
- Forward emoji reactions from users as `[Reacted emoji to: "quoted text"]`

**New optional dependency:**
- OpenAI API access for transcription (graceful degradation if `OPENAI_API_KEY` not set)

**Changes to README:**
- Document `OPENAI_API_KEY` setup for transcription
- List supported media types

**Acceptance criteria:**
- All media types download and deliver to Claude
- Voice messages are transcribed when API key is available
- Voice messages fall back to file delivery when API key is absent
- Emoji reactions are forwarded as contextual feedback
- No new required dependencies

---

#### PR 8: Hooks Integration

**Title:** `feat(telegram): activity tracking, permission relay, and AskUserQuestion routing`

**Scope:** Add Claude Code hooks that bridge CC events to the Telegram chat.

**New files:**
```
hooks/
  hooks.json              — Hook configuration
  activity.sh             — Tool activity tracking
  notify-permission.sh    — Permission prompt relay
  ask-redirect.sh         — AskUserQuestion → Telegram routing
  lib/session-guard.py    — Shared process-tree validation
```

**New files in `src/`:**
- `src/activity.ts` — Progress indicator state management
- `src/ask-io.ts` — AskUserQuestion response polling

**Features:**

1. **Activity tracking:** Each tool use appears in Telegram as a live progress line (e.g., "Read server.ts -> $ bun test -> Edit handlers.ts"). Auto-deleted after completion.

2. **Permission relay:** When CC prompts for permission in the terminal, a notification is sent to Telegram with context. Users know to check their terminal (or, with CC v2.1.81+, can use the native notification relay).

3. **AskUserQuestion routing:** When Claude needs a single-select decision, the prompt is sent to Telegram with inline keyboard buttons. User taps a button or types a reply, and the response is relayed back to CC. Constraints:
   - Single question only
   - Single-select (no multiSelect)
   - Single `allowFrom` user
   - Active Telegram session required
   - Falls through to terminal for unsupported scenarios

**Dependencies:** Requires session management (PR 6) for session-guard.

**Discussion points for maintainers:**
- Hooks are CC-specific — may need discussion about whether they belong in the plugin or as a separate addon
- `session-guard.py` requires Python — acceptable dependency?
- Activity tracking hook fires frequently — performance implications

**Acceptance criteria:**
- Activity indicators show and auto-clear
- Permission prompts are relayed to Telegram
- AskUserQuestion works for simple single-select scenarios
- All hooks degrade gracefully when conditions aren't met
- No impact on plugin startup or core message handling if hooks are removed

---

## Sequencing Summary

```
Phase 1 (independent, any order):
  PR 1: Rich reply formatting
  PR 2: Reply context
  PR 3: Smart text chunking

Phase 2 (sequential):
  PR 4: Architecture refactor (after Phase 1)
  PR 5: Test suite + CI (after PR 4)

Phase 3 (after Phase 2):
  PR 6: Session management
  PR 7: Extended media support (independent of PR 6)
  PR 8: Hooks integration (depends on PR 6)
```

## Open Questions

1. **Upstream responsiveness:** If Phase 1 PRs sit unreviewed for weeks, do we continue preparing Phase 2-3 branches anyway?
2. **Rebasing strategy:** Upstream may merge other telegram PRs during our series. Each PR branch should be rebased on upstream main before submission.
3. **PR descriptions:** Should reference cc-telegram-plus as the proven implementation with link to the repo and changelog?
4. **Hooks controversy:** PR 8 may be rejected or asked to be a separate addon. Be prepared for this outcome.

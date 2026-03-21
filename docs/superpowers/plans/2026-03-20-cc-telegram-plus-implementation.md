# cc-telegram-plus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a drop-in replacement for Anthropic's official Telegram channel plugin for Claude Code, with lazy media download, voice transcription, reply context, reactions, inline buttons, session management, and comprehensive tests.

**Architecture:** Functional TypeScript with dependency injection. Multi-file structure organized by concern. All modules receive an explicit `Deps` bag — no globals. File-based state (JSON) with mkdir-based locking for concurrency. Bun runtime, grammy for Telegram, MCP SDK for Claude Code integration.

**Tech Stack:** TypeScript, Bun, grammy, @modelcontextprotocol/sdk

**Spec:** `docs/superpowers/specs/2026-03-20-cc-telegram-plus-design.md`

---

## File Map

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.mcp.json` | MCP server config |
| `package.json` | Dependencies and scripts |
| `tsconfig.json` | TypeScript config |
| `LICENSE` | MIT license |
| `src/types.ts` | All shared types (Access, GateResult, MediaToken, InlineButton, Deps, Session, etc.) |
| `src/lock.ts` | mkdir-based locking utility (`withLock`) — used by sessions and access |
| `src/access-io.ts` | `loadAccess()`, `saveAccess()` (atomic), `withAccessLock()` — all access.json I/O |
| `src/chunk.ts` | Text chunking for Telegram's 4096 char limit |
| `src/gate.ts` | Access control: gate(), isMentioned, assertSendable, assertAllowedChat, pruneExpired, isUserAuthorized |
| `src/media.ts` | Media token parsing, download from Telegram API, Whisper transcription |
| `src/cache.ts` | Per-session bounded FIFO message cache with JSON persistence |
| `src/sessions.ts` | Multi-session coordination, shared state (ackedMessages, lastInbound), polling control |
| `src/handlers.ts` | grammy event handlers: text, media, reactions, callbacks, bot commands |
| `src/tools.ts` | MCP tool handlers: reply, react, edit_message, fetch_media |
| `src/server.ts` | Entry point: create bot, MCP server, wire deps, start everything |
| `skills/access/SKILL.md` | /telegram:access skill |
| `skills/configure/SKILL.md` | /telegram:configure skill |
| `tests/helpers.ts` | Mock factories for Bot, MCP, Context, Deps |
| `tests/chunk.test.ts` | chunk() tests |
| `tests/gate.test.ts` | gate() and security function tests |
| `tests/media.test.ts` | parseMediaToken, downloadMedia, transcribeAudio tests |
| `tests/cache.test.ts` | MessageCache tests |
| `tests/lock.test.ts` | withLock tests |
| `tests/sessions.test.ts` | SessionManager tests |
| `tests/handlers.test.ts` | Inbound handler tests |
| `tests/tools.test.ts` | MCP tool handler tests |
| `README.md` | Project README |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.claude-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `LICENSE`

- [ ] **Step 1: Initialize git repo and create directories**

```bash
cd /Users/yaniv/Documents/code/cc-telegram-plus
git init
mkdir -p src tests .claude-plugin skills/access skills/configure
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "cc-telegram-plus",
  "version": "0.1.0",
  "description": "Enhanced Telegram channel for Claude Code — drop-in replacement with more features",
  "type": "module",
  "scripts": {
    "start": "bun run src/server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "grammy": "^1.21.0"
  },
  "devDependencies": {
    "bun-types": "latest"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 4: Create plugin.json**

```json
{
  "name": "telegram",
  "description": "Enhanced Telegram channel for Claude Code — drop-in replacement with all media types, voice transcription, session management, and more. Manage pairing, allowlists, and policy via /telegram:access.",
  "version": "0.1.0",
  "keywords": ["telegram", "messaging", "channel", "mcp"]
}
```

- [ ] **Step 5: Create .mcp.json**

```json
{
  "mcpServers": {
    "telegram": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

- [ ] **Step 6: Create LICENSE (MIT)**

Standard MIT license with `Yaniv Golan` as copyright holder, year 2026.

- [ ] **Step 7: Install dependencies**

```bash
bun install
```

- [ ] **Step 8: Create .gitignore**

```
node_modules/
dist/
*.tmp.json
```

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json .claude-plugin/plugin.json .mcp.json LICENSE .gitignore bun.lockb
git commit -m "feat: project scaffold with plugin manifest and dependencies"
```

---

## Task 2: Shared Types (`src/types.ts`)

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write types.ts**

All types from the spec: `Access`, `GroupPolicy`, `PendingEntry`, `GateResult`, `MediaToken`, `InlineButton` (discriminated union), `Session`, `MessageCache`, `SessionManager`, `Deps`. No logic — pure type definitions.

Note: `SessionManager` must include two methods not in the spec's type listing:
- `switchTo(sessionId: string): void` — required by handlers for `/switch`, deep links, and inline switch callbacks
- `activate(): void` — starts polling if this session should be active; called by `server.ts` after all handlers are registered

Add these to the type alongside `register`, `isActive`, `watch`, `stop`, `getAll`, `getDeepLink`, and the shared-state methods.

Ref spec sections: "Shared Types", "Types" under gate.ts, "Session Management", "Dependency Injection".

- [ ] **Step 2: Verify it compiles**

```bash
bun build src/types.ts --no-bundle
```

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared type definitions"
```

---

## Task 2b: Test Helpers (`tests/helpers.ts`)

**Files:**
- Create: `tests/helpers.ts`

Create this early so all subsequent test tasks can use shared mocks. Build incrementally — add more factories as modules are implemented.

- [ ] **Step 1: Create initial helpers**

```typescript
// Mock grammy Bot with API call recording
export function createMockBot(): { bot: MockBot; calls: ApiCall[] }

// Build grammy Context objects for testing
export function createTextCtx(text: string, opts?: CtxOpts): Context
export function createMediaCtx(type: string, opts?: CtxOpts): Context
export function createReactionCtx(emoji: string, opts?: CtxOpts): Context
export function createCallbackCtx(data: string, opts?: CtxOpts): Context

// Default access.json for testing
export function createAccess(overrides?: Partial<Access>): Access
```

Start with `createAccess()` and context factories (needed by gate tests). `createMockBot()` and `createMockMcp()` will be added when handler/tool tests need them.

- [ ] **Step 2: Verify it compiles**

```bash
bun build tests/helpers.ts --no-bundle
```

- [ ] **Step 3: Commit**

```bash
git add tests/helpers.ts
git commit -m "feat: initial test mock factories"
```

> **Note:** This file grows as later tasks need more mocks. Tasks 5-8 may add factories here as needed. Task 9 adds `createMockMcp()` and `createMockDeps()` before handler/tool tests begin.

---

## Task 3: Lock Utility (`src/lock.ts`)

**Files:**
- Create: `src/lock.ts`
- Create: `tests/lock.test.ts`

- [ ] **Step 1: Write failing tests for withLock**

Tests in `tests/lock.test.ts`:
1. `withLock` acquires lock, runs fn, releases lock
2. Second caller blocks until first releases
3. Stale lock with dead PID is broken
4. Orphaned lock dir (no owner file, > 2s old) is broken
5. Fresh lock dir (no owner file, < 2s old) is waited on
6. Lock timeout throws after maxWait
7. Lock is released even if fn throws

Use a temp directory for each test. Mock `isProcessAlive` for PID tests.

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lock.test.ts
```

- [ ] **Step 3: Implement `src/lock.ts`**

Export:
- `withLock<T>(lockDir: string, fn: () => T, opts?: { maxWait?: number }): T`
- `isProcessAlive(pid: number): boolean` (wraps `process.kill(pid, 0)`)

Implementation follows spec exactly: `mkdirSync` for atomic acquire, write `owner` file with `${pid}\n${instanceId}`, PID-based stale detection with 2-second grace for ownerless locks. Same `withLock` used for both `sessions.lock` and `access.lock`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/lock.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts tests/lock.test.ts
git commit -m "feat: mkdir-based lock utility with stale detection"
```

---

## Task 3b: Access File I/O (`src/access-io.ts`)

**Files:**
- Create: `src/access-io.ts`
- Create: `tests/access-io.test.ts`

Focused module for `loadAccess()`, `saveAccess()`, and `withAccessLock()`. These are the core `access.json` persistence functions used throughout the system.

- [ ] **Step 1: Write failing tests**

Tests:
1. `loadAccess` reads and parses `access.json` → returns `Access` object
2. `loadAccess` with missing file → returns default Access (`{ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }`)
3. `loadAccess` with corrupt JSON → returns default Access (no crash)
4. `saveAccess` writes atomically (tmp + rename)
5. `saveAccess` preserves additive fields (`ackReaction`, `replyToMode`, etc.)
6. `withAccessLock` wraps `withLock` on `access.lock/` directory
7. `withAccessLock` + `loadAccess` + `saveAccess` round-trip under lock

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/access-io.test.ts
```

- [ ] **Step 3: Implement access-io.ts**

```typescript
export function createAccessIO(stateDir: string): {
  loadAccess: () => Access
  saveAccess: (access: Access) => void
  withAccessLock: <T>(fn: () => T) => T
}
```

`loadAccess`: `readFileSync` + `JSON.parse` with fallback to defaults.
`saveAccess`: `writeFileSync` to `access.tmp.json` + `renameSync` to `access.json`.
`withAccessLock`: `withLock(join(stateDir, 'access.lock'), fn)`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/access-io.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/access-io.ts tests/access-io.test.ts
git commit -m "feat: access.json I/O with atomic writes and lock"
```

---

## Task 4: Text Chunking (`src/chunk.ts`)

**Files:**
- Create: `src/chunk.ts`
- Create: `tests/chunk.test.ts`

- [ ] **Step 1: Write failing tests**

Tests in `tests/chunk.test.ts`:
1. Short text (< limit) → single chunk
2. Long text → splits at limit boundary
3. Newline mode → prefers `\n\n` breaks
4. Newline mode → falls back to `\n` then hard cut
5. Limit > 4096 → clamped to 4096
6. Empty string → `['']`
7. Exactly at limit → single chunk

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/chunk.test.ts
```

- [ ] **Step 3: Implement `src/chunk.ts`**

```typescript
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[]
```

Clamp limit to `Math.min(limit, 4096)`. Length mode: hard split. Newline mode: search backward from limit for `\n\n`, then `\n`, then hard cut.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/chunk.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/chunk.ts tests/chunk.test.ts
git commit -m "feat: text chunking with newline-aware splitting"
```

---

## Task 5: Access Control (`src/gate.ts`)

**Files:**
- Create: `src/gate.ts`
- Create: `tests/gate.test.ts`

This is the security-critical module. Test-first, thorough coverage.

- [ ] **Step 1: Write failing tests — DM gate logic**

Tests:
1. `disabled` policy → always drops
2. `allowlist` policy + known sender → delivers
3. `allowlist` policy + unknown sender → drops
4. `pairing` policy + known sender → delivers
5. `pairing` policy + unknown sender → returns pair with code
6. `pairing` + sender already pending → reuses existing code, increments replies
7. `pairing` + sender at reply cap (2) → drops
8. `pairing` + max pending (3) → new sender dropped
9. `pruneExpired` removes expired entries, keeps non-expired
10. `pruneExpired` returns true when entries removed, false when not

Use injectable `generateCode` for deterministic tests.

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/gate.test.ts
```

- [ ] **Step 3: Implement gate() and pruneExpired()**

Follow spec: `gate(ctx, access, botUsername, opts?)`. Iterate `access.pending` for sender-to-code lookup. Mutate `access` in place. Return `GateResult`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/gate.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts tests/gate.test.ts
git commit -m "feat: gate() DM access control with pairing flow"
```

- [ ] **Step 6: Write failing tests — group gate logic**

Tests:
1. Group not in `access.groups` → drop
2. Group registered, `requireMention: true`, not mentioned → drop
3. Group registered, mentioned via @username → deliver
4. Group registered, reply to bot message → deliver (implicit mention)
5. Group registered, custom regex pattern match → deliver
6. Group with per-group `allowFrom` → sender not in list → drop
7. Group with per-group `allowFrom` → sender in list → deliver

- [ ] **Step 7: Implement group gate and isMentioned()**

- [ ] **Step 8: Run all gate tests**

```bash
bun test tests/gate.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add src/gate.ts tests/gate.test.ts
git commit -m "feat: group gate with mention detection"
```

- [ ] **Step 10: Write failing tests — security functions**

Tests for `assertSendable`:
1. File inside state dir (not inbox) → throws
2. File inside inbox → allowed
3. Symlink in inbox resolving to `.env` → blocked
4. File outside state dir → allowed
5. Non-existent file → throws (realpathSync fails)

Tests for `assertAllowedChat`:
1. Chat in allowFrom → allowed
2. Chat in groups → allowed
3. Unknown chat → throws

Tests for `isUserAuthorized`:
1. User in allowFrom → true
2. User not in allowFrom → false

Tests for pending entry management (used by `/telegram:access` skill):
1. `pair <code>`: removes pending entry, adds sender to `allowFrom`, frees slot (3 pending → pair one → new sender can pair)
2. `deny <code>`: removes pending entry, frees slot (3 pending → deny one → new sender can pair), sender NOT added to `allowFrom`
3. `pruneExpired` on deliver path → expired entries removed and access saved
4. Adding sender to `allowFrom` + removing pending entry (pair approval flow)

- [ ] **Step 11: Implement assertSendable, assertAllowedChat, isUserAuthorized**

`assertSendable` uses `realpathSync` on both the file path and the state dir / inbox dir before comparison.

- [ ] **Step 12: Run all gate tests**

```bash
bun test tests/gate.test.ts
```

- [ ] **Step 13: Commit**

```bash
git add src/gate.ts tests/gate.test.ts
git commit -m "feat: security assertions (assertSendable, assertAllowedChat, isUserAuthorized)"
```

---

## Task 6: Media & Transcription (`src/media.ts`)

**Files:**
- Create: `src/media.ts`
- Create: `tests/media.test.ts`

- [ ] **Step 1: Write failing tests**

Tests for `parseMediaToken`:
1. Valid token `"photo:fileId123:uniqueId456"` → correct MediaToken
2. All 6 types parse correctly
3. Malformed token (missing parts) → throws
4. Malformed token (unknown type) → throws

Tests for `downloadMedia` (mock `bot.api.getFile` and `fetch`):
1. Successful download → file saved to inbox, returns path
2. Filename uses `fileUniqueId` (collision-proof)
3. Retry on transient error (first attempt fails, second succeeds)
4. Extension inferred from Telegram `file_path`

Tests for `transcribeAudio` (mock `fetch`):
1. Successful transcription → returns text
2. API error → throws

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/media.test.ts
```

- [ ] **Step 3: Implement media.ts**

`parseMediaToken`: split on `:`, validate type, return `MediaToken`.
`downloadMedia`: `bot.api.getFile()` → fetch URL → save to `inbox/{timestamp}-{fileUniqueId}.{ext}`. Retry with 1s/2s backoff + jitter.
`transcribeAudio`: POST to OpenAI Whisper API with FormData.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/media.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/media.ts tests/media.test.ts
git commit -m "feat: media token parsing, download, and voice transcription"
```

---

## Task 7: Message Cache (`src/cache.ts`)

**Files:**
- Create: `src/cache.ts`
- Create: `tests/cache.test.ts`

- [ ] **Step 1: Write failing tests**

Tests:
1. `set` + `get` → returns stored content
2. Content truncated to 200 chars on set
3. FIFO eviction at max entries (default 500, use smaller for test)
4. `get` for unknown key → undefined
5. `flush` writes to disk, `createCache` loads from disk
6. Missing cache file on load → empty cache (no crash)
7. Corrupt JSON file on load → empty cache (no crash)
8. `destroy` deletes the cache file
9. Atomic write: tmp file + rename
10. Per-session isolation: two caches with different file paths don't interfere with each other

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/cache.test.ts
```

- [ ] **Step 3: Implement cache.ts**

`createCache(filePath, maxEntries?)` returns `MessageCache`. In-memory Map, FIFO via insertion-order iteration. File format: `{ version: 1, entries: [[key, value], ...] }`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/cache.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts tests/cache.test.ts
git commit -m "feat: per-session FIFO message cache with JSON persistence"
```

---

## Task 8: Session Management (`src/sessions.ts`)

**Files:**
- Create: `src/sessions.ts`
- Create: `tests/sessions.test.ts`

This is the most complex module. Build incrementally.

- [ ] **Step 1: Write failing tests — registration and active detection**

Tests:
1. First session registers and claims active
2. Second session registers as inactive
3. `isActive()` returns correct state
4. `getAll()` returns all sessions
5. Session has `instanceId` field

- [ ] **Step 2: Implement registration**

`createSessionManager` reads/writes `sessions.json` via `withLock`. Register writes session entry. First session claims active.

- [ ] **Step 3: Run tests**

```bash
bun test tests/sessions.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts
git commit -m "feat: session registration and active detection"
```

- [ ] **Step 5: Write failing tests — stale cleanup and failover**

Tests:
1. Dead PID session is removed on read
2. If active session dies, first remaining takes over
3. Dead session's cache file is cleaned up

- [ ] **Step 6: Implement stale cleanup**

- [ ] **Step 7: Run tests**

```bash
bun test tests/sessions.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts
git commit -m "feat: stale session cleanup and failover"
```

- [ ] **Step 9: Write failing tests — shared state methods**

Tests:
1. `addAckedMessage` + `clearAckedMessages` cycle
2. `clearAckedMessages` returns cleared IDs
3. `ackedMessages` bounded at 50
4. `setLastInbound` + `getLastInbound`
5. All methods go through lock (concurrent test)

- [ ] **Step 10: Implement shared state methods**

Each method: acquire lock → read `sessions.json` → mutate → atomic write → release.

- [ ] **Step 11: Run tests**

```bash
bun test tests/sessions.test.ts
```

- [ ] **Step 12: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts
git commit -m "feat: shared state methods (ackedMessages, lastInbound)"
```

- [ ] **Step 13: Write failing tests — watch loop and switch**

Tests:
1. Watch detects active flag change → calls `startPolling`/`stopPolling`
2. Switch via `sessions.json` mutation triggers callback
3. `getDeepLink` returns correct URL

- [ ] **Step 14: Implement watch loop, switch, getDeepLink**

Watch: `setInterval` every 3 seconds, read `sessions.json`, compare active flag. `getDeepLink`: format `https://t.me/${botUsername}?start=switch_${sessionId}`.

- [ ] **Step 15: Run tests**

```bash
bun test tests/sessions.test.ts
```

- [ ] **Step 16: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts
git commit -m "feat: session watching, switching, and deep links"
```

- [ ] **Step 17: Write failing tests — stop and shutdown**

Tests:
1. `stop()` removes session from file
2. `stop()` calls `stopPolling`
3. `stop()` cleans up watch interval

- [ ] **Step 18: Implement stop**

- [ ] **Step 19: Run all session tests**

```bash
bun test tests/sessions.test.ts
```

- [ ] **Step 20: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts
git commit -m "feat: session shutdown and cleanup"
```

- [ ] **Step 21: Write failing tests — approval poller**

Tests:
1. Poller detects unclaimed `approved/<senderId>` file → renames to `.claimed`, sends DM, deletes
2. DM send fails → `.claimed` renamed back to unclaimed for retry
3. Orphaned `.claimed` file older than 30s → renamed back to unclaimed
4. Poller only runs when session is active
5. Failover: active session dies, new active picks up poller
6. Duplicate send prevention: two sessions race on same file, only one `renameSync` succeeds

- [ ] **Step 22: Implement approval poller**

Export `startApprovalPoller(opts)` and `stopApprovalPoller()` from `sessions.ts`. Uses `setInterval` (5 seconds). Reads `approved/` dir, processes files with claim-before-send pattern. Called by `server.ts` alongside `startPolling`/`stopPolling`.

- [ ] **Step 23: Run tests**

```bash
bun test tests/sessions.test.ts
```

- [ ] **Step 24: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts
git commit -m "feat: approval poller with claim-before-send and orphan recovery"
```

- [ ] **Step 25: Write failing tests — concurrency and leader election**

Tests:
1. Two sessions register simultaneously → only one becomes active (leader election via lock)
2. Concurrent `access.json` mutations under `withAccessLock` → no lost updates

These test the most concurrency-sensitive paths in the design. Use the lock utility and temp directories to simulate races.

- [ ] **Step 26: Implement any missing concurrency logic**

- [ ] **Step 27: Run tests**

```bash
bun test tests/sessions.test.ts
```

- [ ] **Step 28: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts
git commit -m "feat: concurrency tests for leader election and access.json races"
```

- [ ] **Step 29: Write failing tests — notification targeting**

Tests:
1. Session notification sent to all DM chats in `allowFrom`
2. Group chats NOT notified
3. Empty `allowFrom` → no notifications sent

- [ ] **Step 30: Implement notification targeting**

`SessionManager` reads `loadAccess().allowFrom` and calls `sendNotification` for each user ID.

- [ ] **Step 31: Run tests**

```bash
bun test tests/sessions.test.ts
```

- [ ] **Step 32: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts
git commit -m "feat: session notifications target allowFrom DM chats only"
```

---

## Task 9: Extend Test Helpers for Handlers/Tools

**Files:**
- Modify: `tests/helpers.ts`

Task 2b created initial helpers. Now add the mocks needed by handler and tool tests.

- [ ] **Step 1: Add MCP and Deps mocks**

```typescript
// Add to existing helpers.ts:
export function createMockMcp(): { mcp: MockMcp; notifications: any[] }
export function createMockDeps(overrides?: Partial<Deps>): Deps
```

`MockMcp` captures `notification()` calls. `createMockDeps` wires MockBot + MockMcp + createCache + createAccess with sensible defaults, all overridable.

- [ ] **Step 2: Verify helpers compile**

```bash
bun build tests/helpers.ts --no-bundle
```

- [ ] **Step 3: Commit**

```bash
git add tests/helpers.ts
git commit -m "feat: test mock factories for Bot, MCP, Context, Deps"
```

---

## Task 10: Inbound Handlers (`src/handlers.ts`)

**Files:**
- Create: `src/handlers.ts`
- Create: `tests/handlers.test.ts`

Build incrementally by handler type.

- [ ] **Step 1: Write failing tests — text message handler**

Tests:
1. Text message from allowed user → notification emitted with correct content + meta
2. Text message from unknown user (allowlist mode) → dropped
3. Typing indicator sent on deliver
4. Reply context extracted when replying to a message
5. Reply context truncated to 200 chars

- [ ] **Step 2: Implement text handler + registerHandlers shell**

`registerHandlers(deps)` sets up `bot.on('message:text', ...)`. Common flow:
- **Phase 1 (under access lock):** `deps.withAccessLock(() => { loadAccess → pruneExpired (save if changed) → gate → if pair: saveAccess })` → release lock
- **Phase 2 (no lock):** if drop: return. if deliver: typing → reply context → MCP notification → ack reaction → cache store.
Handler tests must verify that `saveAccess` is called when `pruneExpired` removes entries and when `gate` returns `pair`.

- [ ] **Step 3: Run tests**

```bash
bun test tests/handlers.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/handlers.ts tests/handlers.test.ts
git commit -m "feat: text message handler with gate, reply context"
```

- [ ] **Step 5: Write failing tests — media handlers**

Tests for each media type (photo, document, video, audio, sticker):
1. Correct content format (caption or placeholder)
2. Correct `media_token` in meta
3. Photo selects highest-resolution variant

- [ ] **Step 6: Implement media handlers**

Register `bot.on('message:photo')`, `bot.on('message:document')`, etc. Build token as `${type}:${fileId}:${fileUniqueId}`.

- [ ] **Step 7: Run tests**

```bash
bun test tests/handlers.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/handlers.ts tests/handlers.test.ts
git commit -m "feat: media handlers with lazy token emission"
```

- [ ] **Step 9: Write failing tests — voice handler**

Tests:
1. Voice with transcription available → `[Voice: "text"]` + token
2. Voice transcription fails → `(voice message)` + token
3. Voice without `deps.transcribe` → `(voice message)` + token

- [ ] **Step 10: Implement voice handler**

Eager download (voice files are small), call `deps.transcribe()`, fallback on error.

- [ ] **Step 11: Run tests**

```bash
bun test tests/handlers.test.ts
```

- [ ] **Step 12: Commit**

```bash
git add src/handlers.ts tests/handlers.test.ts
git commit -m "feat: voice message handler with transcription"
```

- [ ] **Step 13: Write failing tests — reaction handler**

Tests:
1. New reaction added → notification with `[Reacted 👍 to: "cached"]`
2. Reaction removed (empty new_reaction) → ignored
3. Unregistered chat → ignored
4. Message not in cache → `[Reacted 👍 to message #id]`

- [ ] **Step 14: Implement reaction handler**

Subscribe to `message_reaction`. Diff old/new. Lookup cache. Emit notification.

- [ ] **Step 15: Run tests**

```bash
bun test tests/handlers.test.ts
```

- [ ] **Step 16: Commit**

```bash
git add src/handlers.ts tests/handlers.test.ts
git commit -m "feat: inbound reaction handler with cache lookup"
```

- [ ] **Step 17: Write failing tests — callback query + ack reaction**

Tests:
1. Callback query → `[Button pressed: data]` + `answerCallbackQuery` called
2. Session-switch callback from authorized user → switches + `answerCallbackQuery` with feedback
3. Session-switch callback from unauthorized user → `answerCallbackQuery({ text: 'Not authorized' })`, no switch
4. Ack reaction applied after notification success
5. Ack reaction NOT applied on notification failure
6. Two inbound messages → both acked → reply clears both

- [ ] **Step 18: Implement callback handler and ack logic**

- [ ] **Step 19: Run tests**

```bash
bun test tests/handlers.test.ts
```

- [ ] **Step 20: Commit**

```bash
git add src/handlers.ts tests/handlers.test.ts
git commit -m "feat: callback queries, ack reactions with cleanup"
```

- [ ] **Step 21: Write failing tests — bot commands**

Tests:
1. `/chatid` → responds with chat ID (no auth)
2. `/sessions` from allowFrom user in DM → shows session list
3. `/sessions` from allowFrom user in group → shows session list
4. `/sessions` from non-allowFrom group member → blocked
5. `/sessions` from non-allowFrom user in DM → blocked
6. `/status` from allowFrom user → shows current session
7. `/status` from non-allowFrom group member → blocked
8. `/switch` from allowFrom user in DM → triggers session switch
9. `/switch` from non-allowFrom user → blocked
10. `/switch` in group chat → blocked (DM-only per spec)
11. Deep link `/start switch_<id>` from authorized user → switches
12. Deep link from unauthorized user → dropped
13. Deep link with invalid/stale session ID → replies with error message

- [ ] **Step 22: Implement bot commands**

Handle `/chatid`, `/sessions`, `/switch`, `/status`, `/start` with `switch_` payload. Auth checks via `isUserAuthorized`.

- [ ] **Step 23: Run tests**

```bash
bun test tests/handlers.test.ts
```

- [ ] **Step 24: Commit**

```bash
git add src/handlers.ts tests/handlers.test.ts
git commit -m "feat: bot commands with auth (sessions, switch, chatid, deep links)"
```

---

## Task 11: MCP Tool Handlers (`src/tools.ts`)

**Files:**
- Create: `src/tools.ts`
- Create: `tests/tools.test.ts`

- [ ] **Step 1: Write failing tests — reply tool**

Tests:
1. Text reply → `sendMessage` called with correct chat_id + text
2. Long text → chunked, multiple `sendMessage` calls
3. File attachment (image) → `sendPhoto`
4. File attachment (non-image) → `sendDocument`
5. File > 50MB → error
6. State dir file → blocked by `assertSendable`
7. Unknown chat → blocked by `assertAllowedChat`
8. MarkdownV2 parse error → fallback to plain text
9. Ack reactions cleared on success
10. Sent message stored in cache
11. `replyToMode: 'first'` auto-threads first chunk
12. `replyToMode: 'all'` auto-threads all chunks
13. Explicit `reply_to` overrides `replyToMode`

- [ ] **Step 2: Implement reply tool handler**

- [ ] **Step 3: Run tests**

```bash
bun test tests/tools.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/tools.ts tests/tools.test.ts
git commit -m "feat: reply tool with chunking, files, parse_mode fallback"
```

- [ ] **Step 5: Write failing tests — keyboard rules**

Tests:
1. `inline_keyboard` attaches to last text chunk
2. `reply_keyboard` attaches to last text chunk
3. `remove_keyboard: true` → sends `ReplyKeyboardRemove` markup
4. `inline_keyboard` + `reply_keyboard` → error (mutual exclusivity)
5. `inline_keyboard` + `remove_keyboard` → error
6. `reply_keyboard` + `remove_keyboard` → error
7. `one_time_keyboard` without `reply_keyboard` → error
6. Files-only with keyboard → keyboard on last file
7. Empty reply (no text, no files) → error
8. `InlineButton` validation: missing both `callback_data` and `url` → error
9. `InlineButton` validation: both `callback_data` and `url` present → error

- [ ] **Step 6: Implement keyboard validation and attachment**

- [ ] **Step 7: Run tests**

```bash
bun test tests/tools.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/tools.ts tests/tools.test.ts
git commit -m "feat: keyboard rules with mutual exclusivity validation"
```

- [ ] **Step 9: Write failing tests — react, edit_message, fetch_media**

Tests:
1. `react` → `setMessageReaction` called
2. `react` unknown chat → blocked
3. `react` invalid emoji → error returned
4. `edit_message` → `editMessageText` called
5. `edit_message` unknown chat → blocked
6. `edit_message` with `parse_mode` fallback
7. `edit_message` with `inline_keyboard`
8. `fetch_media` valid token → downloads and returns path
9. `fetch_media` malformed token → error

- [ ] **Step 10: Implement react, edit_message, fetch_media**

- [ ] **Step 11: Run all tools tests**

```bash
bun test tests/tools.test.ts
```

- [ ] **Step 12: Commit**

```bash
git add src/tools.ts tests/tools.test.ts
git commit -m "feat: react, edit_message, fetch_media tool handlers"
```

---

## Task 12: MCP Server Entry Point (`src/server.ts`)

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: Implement server.ts**

This is the wiring module — no separate tests (integration tested via the full plugin).

1. **State dir init:** Ensure `~/.claude/channels/telegram/`, `inbox/`, `approved/` exist (`mkdirSync` with `{ recursive: true }`)
2. **Load `.env`:** Read `${stateDir}/.env` manually (not in project root — can't use Bun's built-in `.env`). Parse `TELEGRAM_BOT_TOKEN` from `KEY=VALUE` lines. `OPENAI_API_KEY` is read from `process.env` (set by the user's shell, not the state dir `.env`) — this matches the spec
3. Create grammy `Bot` with token
4. Call `bot.api.getMe()` to get `botUsername`
5. Create MCP `Server` with `experimental: { 'claude/channel': {} }` capability
6. Register 4 tools in MCP (reply, react, edit_message, fetch_media) with JSON input schemas from spec
7. Build session label: check `CLAUDE_IDE` env var → fall back to `"Claude Code"` → append ` — ${basename(cwd)}`
8. Create access I/O from the tested `access-io.ts` module — do NOT recreate inline:
    ```typescript
    const { loadAccess, saveAccess, withAccessLock } = createAccessIO(stateDir)
    ```
9. Create `transcribe` closure: `process.env.OPENAI_API_KEY ? (buf) => transcribeAudio(buf, process.env.OPENAI_API_KEY!) : undefined` — reads from process env, NOT from state dir `.env` (matches spec)
10. **Build all deps before any polling can start.** Create `SessionManager` first (without calling `register()` yet), then cache, then wire everything:
    ```typescript
    // Create SessionManager (does NOT register or poll yet)
    const sendNotification = (chatId: string, text: string, keyboard?: InlineButton[][]) =>
      bot.api.sendMessage(chatId, text, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
    const sessionManager = createSessionManager({
      stateDir, startPolling, stopPolling, sendNotification, loadAccess, botUsername, label,
    })
    ```
    `createSessionManager` does NOT register or poll on construction — it waits for an explicit `register()` call.
11. **Register session (deferred polling).** Call `sessionManager.register()` which returns the session ID, writes to `sessions.json`, but does NOT start polling yet — polling is deferred until `sessionManager.activate()` is called explicitly:
    ```typescript
    const sessionId = sessionManager.register()  // returns ID, writes to sessions.json, does NOT poll yet
    const cache = createCache(join(stateDir, `cache-${sessionId}.json`))
    const deps: Deps = {
      bot, mcp, stateDir, botUsername, transcribe, withAccessLock,
      loadAccess, saveAccess, cache, sessions: sessionManager,
    }
    ```
    Note: `register()` matches the spec signature (`register(): string`). Polling is separated from registration.
12. Call `registerHandlers(deps)` — registers all grammy handlers. All deps fields are real values.
13. Wire MCP tool call handler → `tools.ts` dispatch
14. **Now activate and start watching** — all handlers and deps are fully wired:
    ```typescript
    sessionManager.activate()  // if this session should be active, calls startPolling()
    sessionManager.watch()     // start 3-second poll loop for session changes, failover, stale cleanup
    ```
    The `startPolling` callback starts both bot polling and approval poller.
    **IMPORTANT:** `bot.start()` resolves only when polling stops (grammY behavior), so do NOT await it — fire and forget:
    ```typescript
    const startPolling = () => {
      void bot.start({ allowed_updates: ['message', 'message_reaction', 'callback_query'] })
      startApprovalPoller(...)
    }
    const stopPolling = () => {
      bot.stop()
      stopApprovalPoller()
    }
    ```
15. Set MCP instructions (exact text from spec section "MCP Server Instructions")
16. Set bot commands via `setMyCommands` (DM and group scopes per spec)
17. Set bot description via `setMyDescription` / `setMyShortDescription`
19. Start cache flush interval: `setInterval(() => cache.flush(), 30_000)`
20. Start MCP server on stdio
21. Handle SIGINT/SIGTERM: flush cache, stop session (which stops poller + polling), cleanup

- [ ] **Step 2: Verify it compiles**

```bash
bun build src/server.ts --no-bundle
```

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: server entry point wiring all components"
```

---

## Task 13: Skills

**Files:**
- Create: `skills/access/SKILL.md`
- Create: `skills/configure/SKILL.md`

- [ ] **Step 1: Write /telegram:access skill**

Follows spec's skill table. Commands: (no args), pair, deny, allow, remove, policy, group add, group rm, set. Security model: terminal-only, refuses channel-message mutations. All mutations go through `withAccessLock`.

- [ ] **Step 2: Write /telegram:configure skill**

Commands: (no args), `<token>`, `clear`. Token saved to `.env`. Status shows token, policy, sessions, next steps.

- [ ] **Step 3: Commit**

```bash
git add skills/
git commit -m "feat: /telegram:access and /telegram:configure skills"
```

---

## Task 14: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Sections per spec:
1. Headline + one-paragraph description
2. Feature comparison table vs official plugin
3. Installation (`claude plugins remove telegram && claude plugins add yaniv-golan/cc-telegram-plus`)
4. Migration note (config compatibility + caveat about additive fields)
5. Setup (BotFather → token → pairing)
6. New features guide (fetch_media, voice, sessions, keyboards)
7. `OPENAI_API_KEY` for voice transcription (optional)
8. Tool reference table
9. Contributing
10. Upstream goal

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with feature comparison and setup guide"
```

---

## Task 15: Integration Verification

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

All tests should pass. Fix any failures.

- [ ] **Step 2: Create server.ts smoke tests (`tests/server-smoke.test.ts`)**

These test the wiring that no other test file covers:
1. `.env` parsing: write a test `.env` file → `loadEnv` returns correct `TELEGRAM_BOT_TOKEN`
2. `.env` missing → throws with clear error message
3. Session label: `CLAUDE_IDE=Cursor` → label starts with "Cursor"; unset → "Claude Code"
4. `createAccessIO` returns working `loadAccess`/`saveAccess`/`withAccessLock` (confirm it uses the tested `access-io.ts`, not inline recreation)
5. MCP tool list: verify all 4 tools (reply, react, edit_message, fetch_media) are registered with correct names

```bash
bun test tests/server-smoke.test.ts
```

- [ ] **Step 3: Verify plugin structure**

Check that `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, and `src/server.ts` are all present and correctly structured.

- [ ] **Step 4: Verify compilation**

```bash
bun build src/server.ts --no-bundle
```

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: integration verification fixes"
```

---

## Deferred Features

The following spec features are intentionally deferred to a future release:

- **Pinned session status in groups** (spec: "Optional, controlled by config"): Pin a status message on session switch, auto-unpin on next switch. Low priority — session switching already has inline notifications.

---

## Dependency Graph

```
Task 1 (scaffold)
  └→ Task 2 (types)
       └→ Task 2b (basic test helpers)
            ├→ Task 3 (lock) ─────────────────┐
            │   └→ Task 3b (access-io) ←──────┤
            ├→ Task 4 (chunk)                  │
            ├→ Task 5 (gate)                   │
            ├→ Task 6 (media)                  │
            ├→ Task 7 (cache)                  │
            └→ Task 8 (sessions) ←── depends on Task 3
                 │                   (includes approval poller)
            Task 9 (extend test helpers) ←── depends on Tasks 2b-8
                 │
            ├→ Task 10 (handlers) ←── depends on Tasks 5,6,7,8,9
            ├→ Task 11 (tools) ←── depends on Tasks 5,6,7,8,9
            │
            Task 12 (server) ←── depends on Tasks 10,11
                               (wires withAccessLock, .env loading,
                                state dir init, cache flush interval,
                                allowed_updates, approval poller start)
            Task 13 (skills) ←── independent
            Task 14 (README) ←── independent
            Task 15 (integration) ←── depends on all
```

**Parallelizable:** Tasks 3-7 can all run in parallel after Task 2b. Tasks 13-14 can run at any time.

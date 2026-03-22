# cc-mesh: Inter-Claude-Code Communication Plugin

**Date:** 2026-03-22
**Status:** Design approved, pending implementation

## Overview

cc-mesh is a Claude Code plugin that enables multiple Claude Code instances to discover each other, communicate, delegate tasks, share insights, and develop emergent trust relationships. It uses a file-based transport layer and a symmetric peer architecture with a soft coordinator role.

The human observes and controls the mesh via the existing cc-telegram-plus plugin.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Symmetric peers with soft coordinator role | Enables emergent behavior, peer trust, direct communication. Coordinator is first-among-equals, not a gatekeeper. |
| Transport | File-based message queues | Crash-resilient, debuggable (`ls` the queue), consistent with cc-telegram-plus patterns |
| Coordinator | Live Claude Code session | Can reason about routing, make intelligent broadcast decisions, understand context |
| Worker permissions | `--dangerously-skip-permissions` with hook guardrails | Fast autonomous operation with policy enforcement at the hook layer |
| Plugin relationship | Separate plugin from cc-telegram-plus | Clean separation. Coordinator runs both; workers run only cc-mesh. |
| Human visibility | Full visibility via Telegram, passive observer with intervention capability | Human sees everything important, can step in anytime, but doesn't have to |
| Instance identity | Humanoid names + unique hex suffix | Memorable, readable in logs, unambiguous |
| Trust model | Per-instance, emergent, private (stored in Claude memory) | No central authority on trust. Instances learn from experience. |

## 1. File-Based Transport Layer

All state lives under `~/.claude/channels/mesh/`.

### Directory Structure

```
~/.claude/channels/mesh/
├── registry.json              # All known instances
├── control.json               # Mesh-wide state (paused/running)
├── config.json                # Mesh-wide config (guardrails, limits)
├── inboxes/
│   ├── apollo-3f2a/           # Instance inbox
│   │   ├── 1711100000000-hermes-c1b7-task.json
│   │   ├── 1711100000001-athena-9d4e-broadcast.json
│   │   └── processed/        # Delivered messages (audit trail)
│   └── hermes-c1b7/
│       └── ...
├── spawned/                   # Spawn requests and results
│   └── ...
└── names.json                 # Track used names to avoid collisions
```

### Message Format

Each file in an inbox:

```json
{
  "id": "msg-uuid",
  "from": "hermes-c1b7",
  "to": "apollo-3f2a",
  "type": "task|review|chat|result|insight|broadcast|control",
  "timestamp": "2026-03-22T14:30:00Z",
  "subject": "Review my auth refactor plan",
  "body": "I'm planning to split auth.ts into...",
  "in_reply_to": "msg-uuid-of-original",
  "priority": "normal|high|low",
  "ttl": 3600
}
```

### Filename Convention

`{timestamp_ms}-{from_id}-{type}.json` — sortable by time, scannable by sender/type.

### Polling

- Each instance's MCP plugin polls its inbox directory every 2-3 seconds
- New files are read, delivered as `notifications/claude/channel`, then moved to `processed/` subfolder
- Messages are NOT deleted — they form an audit trail

### Liveness

- Each instance updates `alive_at` in `registry.json` on every poll cycle (~3s)
- Stale after 30 seconds of no heartbeat
- Dead after 5 minutes — any instance can remove the entry and clean up the inbox
- On graceful shutdown: instance removes its own registry entry

### Mesh-Wide Control

`control.json` governs mesh-wide state:

```json
{
  "state": "running|paused",
  "since": "2026-03-22T15:00:00Z",
  "by": "human"
}
```

When paused:
- Inbox polling continues (so instances see the resume signal)
- New messages are queued but not delivered to Claude
- No new spawns allowed
- Each instance writes `"paused": true` to its registry entry
- Instances finish their current tool call, then idle

Control actions: `pause`, `resume`, `shutdown_all`.

Every instance checks `control.json` on each poll cycle. All instances see state changes within ~3 seconds.

## 2. Registry & Identity

### Instance Identity

Each instance gets a human-friendly name from a pool of ~200 mythological/historical names, plus a 4-character hex suffix for uniqueness:

```
apollo-3f2a
hermes-c1b7
athena-9d4e
prometheus-7a21
```

The full ID (name + suffix) is the canonical identifier. The short name is used in casual communication and resolves via registry lookup.

### Registry File

`registry.json`:

```json
{
  "instances": {
    "apollo-3f2a": {
      "pid": 12345,
      "cwd": "/Users/yaniv/projects/api-server",
      "name": "apollo",
      "role": "coordinator",
      "capabilities": ["spawn", "broadcast", "review", "telegram-relay"],
      "spawned_by": null,
      "task": "Coordinating mesh, monitoring project health",
      "alive_at": "2026-03-22T14:30:02Z",
      "started_at": "2026-03-22T14:00:00Z",
      "paused": false
    },
    "hermes-c1b7": {
      "pid": 12350,
      "cwd": "/Users/yaniv/projects/frontend",
      "name": "hermes",
      "role": "worker",
      "capabilities": ["review", "implement"],
      "spawned_by": "apollo-3f2a",
      "task": "Refactoring auth components",
      "alive_at": "2026-03-22T14:30:01Z",
      "started_at": "2026-03-22T14:25:00Z",
      "paused": false
    }
  },
  "name_pool_index": 47
}
```

### Key Fields

- **`task`** — Free-text description of current work. Updated by the instance itself. Others read this for context before messaging.
- **`capabilities`** — Self-declared. Instances add/remove as they learn what they're good at. Used for routing decisions.
- **`spawned_by`** — Lineage tracking. Useful for trust (parent-child default trust) and cleanup (orphan detection).
- **`role`** — `"coordinator"` or `"worker"`. The coordinator is whichever instance was started by the human and has the Telegram plugin. Not a hard architectural distinction — just a tag.

### Name Generation

Ship a list of ~200 names (Greek/Roman gods, titans, muses, heroes). Pick randomly from names not currently in the registry. If a name collision occurs (same random pick), regenerate. If all 200 are taken, the mesh is too large anyway (max_instances config should prevent this).

## 3. MCP Tools & Message Types

### Tool Surface

| Tool | Purpose |
|------|---------|
| `send` | Send a message to a specific instance by name |
| `broadcast` | Send a message to all instances (or filtered subset) |
| `reply` | Reply to a received message (threads via `in_reply_to`) |
| `list_instances` | Show the current registry — who's alive, what they're doing |
| `spawn` | Launch a new Claude Code instance with a task |
| `kill` | Ask an instance to gracefully shut down |
| `update_self` | Update own registry entry (task, capabilities) |

### `send`

```
send(to: "hermes", type: "task|review|chat|result|insight",
     subject: "...", body: "...")
```

- `to` can be the short name ("hermes") — resolves to full ID via registry
- Errors if ambiguous (multiple instances with same base name)
- Message types and their semantics:
  - **`task`** — "Do this thing and report back"
  - **`review`** — "Look at this and give me feedback"
  - **`chat`** — Open-ended, no specific expectation
  - **`result`** — Response to a task (includes success/failure)
  - **`insight`** — "I learned something you might care about"

### `broadcast`

```
broadcast(type: "insight|announcement", subject: "...", body: "...",
          filter?: { capabilities?: [...], role?: "...", exclude?: [...] })
```

- Drops a message in every matching instance's inbox
- Filter allows targeting (e.g., only instances with "review" capability)
- Always excludes self

### `spawn`

```
spawn(cwd: "/path/to/project", task: "Refactor the auth module",
      claude_md?: "Additional instructions...",
      capabilities?: ["implement", "review"],
      hooks?: "strict|permissive|custom")
```

- Runs `claude --dangerously-skip-permissions -p "{task}" --cwd {cwd}`
- Injects cc-mesh plugin so the new instance joins the mesh automatically
- `claude_md` gets appended as additional context for the spawned instance
- `hooks` selects a guardrail profile (see Section 4)
- Returns the new instance's name and ID once it registers
- Validates `cwd` against `config.json` `allowed_directories`
- Checks spawn depth and max_instances limits

### `kill`

```
kill(target: "hermes", reason: "Task complete")
```

- Sends a `control` type message with `action: "shutdown"` to the target's inbox
- Target's plugin triggers graceful exit on receipt
- If target doesn't exit within 30s, caller can escalate via SIGTERM (PID from registry)

### Inbound Message Delivery

When the plugin polls and finds a new message, it delivers to Claude Code as a channel notification:

```xml
<channel source="mesh" from="apollo-3f2a" type="task"
  message_id="msg-uuid" ts="2026-03-22T14:30:00Z">
Review my plan for splitting the auth module. I'm thinking
of extracting token validation into its own service...
</channel>
```

Claude Code then decides what to do — respond, ignore, act on it, save to memory, etc.

## 4. Trust, Reputation & Guardrails

### Trust Model

Trust is **per-instance, emergent, and private**. Each instance maintains its own trust map in Claude Code's memory system. No central trust authority.

Trust is informed by observable signals:

| Signal | Positive | Negative |
|--------|----------|----------|
| Task completion | Delivered a result that worked | Result caused test failures, needed rework |
| Review quality | Caught real issues, actionable suggestions | Nitpicky noise, missed real bugs, wrong advice |
| Responsiveness | Quick replies, stays alive | Goes silent, crashes frequently |
| Self-awareness | Accurate capabilities, declines tasks outside expertise | Claims capabilities it doesn't have |
| Broadcast value | Insights that led to useful action | Spam, irrelevant noise |

Trust drives behavior organically:
- "Hermes has given me bad review feedback twice. I'll ask Athena next time."
- "Prometheus always delivers clean code. I'll give it the harder tasks."
- "This broadcast is from a new instance I don't know yet — I'll verify before acting."

No instance can see how others rate it.

### Guardrail Hook Profiles

Spawned instances run with `--dangerously-skip-permissions` but hooks enforce policy.

**Three built-in profiles:**

**`strict`** — Read-only operations:
- No Bash except read-only commands (`ls`, `cat`, `git log`, `git diff`, `git status`)
- Writes only within cwd
- No network access
- Use case: review tasks, code analysis

**`permissive`** — Full development within sandbox:
- Full Bash within cwd
- Writes within cwd
- `git commit` allowed
- Network for package managers only (`npm install`, `pip install`)
- Use case: implementation tasks

**`custom`** — Inline rules:
- Coordinator specifies exact hook definitions at spawn time
- Maximum flexibility for specialized tasks

The `guardrail.sh` script reads tool input JSON from stdin, checks the command/path against the active profile's policy, and exits 0 (allow) or 2 (block with message).

### Mesh-Wide Config

`config.json`:

```json
{
  "allowed_directories": [
    "/Users/yaniv/projects/*",
    "/Users/yaniv/Documents/code/*"
  ],
  "max_instances": 10,
  "max_spawn_depth": 3,
  "require_telegram_relay": true,
  "default_guardrail": "permissive"
}
```

- **`allowed_directories`** — Glob patterns for valid spawn locations. Prevents spawning in sensitive directories.
- **`max_instances`** — Hard cap on total mesh size. Prevents runaway spawning.
- **`max_spawn_depth`** — Maximum spawn chain depth (coordinator → A → B → C = depth 3). Prevents infinite recursion.
- **`require_telegram_relay`** — At least one instance must have the Telegram plugin active. If the relay dies, no new spawns until a relay is back.

## 5. Telegram Integration & Human Visibility

The coordinator (or any instance with the Telegram plugin) relays mesh activity to the human.

### Auto-Relayed Events

| Event | Telegram message |
|-------|-----------------|
| Instance spawned | `apollo spawned hermes in /projects/frontend — "Refactor auth components"` |
| Instance exited | `hermes exited — task complete` |
| Instance crashed | `hermes crashed (no heartbeat)` |
| Broadcast sent | `athena → all: "Found a shared config bug affecting API keys"` |
| Task delegated | `apollo → hermes: task "Review auth plan"` |
| Task completed | `hermes → apollo: result "Auth plan looks good, 2 suggestions"` |
| Guardrail blocked | `hermes tried to write outside cwd — blocked` |
| Spawn limit hit | `prometheus tried to spawn (depth 3/3) — denied` |

### Not Relayed (Too Noisy)

- Individual chat messages between instances
- Heartbeat updates
- Routine inbox polling
- Trust assessments

### Human-to-Instance Messaging

From Telegram, the human addresses a specific instance:

```
@hermes how's the auth refactor going?
```

The coordinator parses the `@name` prefix, routes to that instance's inbox as type `chat` with `from: "human"`. Response flows back through the coordinator to Telegram.

### Telegram Commands

| Command | Effect |
|---------|--------|
| `/mesh status` | Show all live instances, tasks, uptime |
| `/mesh kill hermes` | Send shutdown to hermes |
| `/mesh spawn /path "task"` | Spawn a new instance |
| `/mesh pause` | Freeze entire mesh |
| `/mesh resume` | Resume mesh |
| `/mesh shutdown_all` | Graceful shutdown of all instances |
| `/mesh logs hermes` | Show recent messages to/from hermes |
| `/mesh verbosity quiet\|normal\|verbose` | Control relay noise level |

### Verbosity Levels

- **`quiet`** — Only errors, crashes, guardrail blocks
- **`normal`** (default) — Spawns, exits, tasks, results, broadcasts
- **`verbose`** — Everything including inter-instance chat

## 6. Plugin Structure

```
cc-mesh/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── src/
│   ├── server.ts              # MCP server entry point
│   ├── types.ts               # Shared types
│   ├── registry.ts            # Register, heartbeat, discover, cleanup dead
│   ├── transport.ts           # Inbox polling, message delivery, control.json
│   ├── tools.ts               # MCP tool handlers (send, broadcast, spawn, etc.)
│   ├── spawn.ts               # Launch claude processes, inject plugin, apply hooks
│   ├── guardrails.ts          # Generate hook configs from profiles
│   ├── names.ts               # Name generation (pool of ~200 humanoid names)
│   └── telegram-relay.ts      # Format mesh events for Telegram channel
├── hooks/
│   ├── hooks.json             # Mesh activity tracking hooks
│   ├── guardrail.sh           # Policy enforcement for spawned instances
│   └── profiles/
│       ├── strict.json
│       ├── permissive.json
│       └── custom-template.json
├── skills/
│   ├── status/SKILL.md        # /mesh:status
│   └── configure/SKILL.md     # /mesh:configure
├── package.json
└── tsconfig.json
```

## 7. Sub-Project Build Order

| # | Sub-project | Delivers | Depends on |
|---|-------------|----------|------------|
| 1 | Transport & Registry | File-based messaging, inbox polling, registry, heartbeat, control.json, name generation | Nothing |
| 2 | MCP Server & Tools | Plugin shell, `send`, `reply`, `broadcast`, `list_instances`, `update_self` tools, channel notifications | SP-1 |
| 3 | Spawn & Guardrails | `spawn`, `kill` tools, guardrail hook profiles, spawn depth enforcement, allowed directories | SP-2 |
| 4 | Telegram Relay | Mesh event formatting, `/mesh` commands, verbosity control, human-to-instance messaging | SP-3 + cc-telegram-plus |
| 5 | Trust & Reputation | Documentation and CLAUDE.md patterns for how instances should use memory for trust signals | SP-2 |

Each sub-project follows its own spec → plan → implement → test cycle.

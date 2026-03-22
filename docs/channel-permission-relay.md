# Channel Permission Relay Protocol

> **Status:** Undocumented / reverse-engineered from Claude Code v2.1.81 binary
> **Date:** 2026-03-22
> **Source:** `strings` extraction from compiled Bun binary at `~/.local/bin/claude`

Claude Code 2.1.81 added native support for forwarding permission prompts to
channel servers. This lets users approve or deny tool use from Telegram instead
of switching to the terminal.

From the [v2.1.81 changelog](https://github.com/anthropics/claude-code/releases/tag/v2.1.81):

> Added `--channels` permission relay — channel servers that declare the
> permission capability can forward tool approval prompts to your phone

No further documentation was published. The protocol details below were
reverse-engineered from the compiled binary.

## Capability Declaration

The channel MCP server must declare **both** capabilities in `experimental`:

```typescript
const mcp = new Server(
  { name: 'telegram', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},  // enables the relay
      },
    },
    // ...
  },
)
```

CC filters connected channel servers with this check (decompiled as `eR9`):

```javascript
servers.filter(s =>
  s.type === 'connected' &&
  isInChannelsList(s.name) &&
  s.capabilities?.experimental?.['claude/channel'] !== undefined &&
  s.capabilities?.experimental?.['claude/channel/permission'] !== undefined
)
```

Without `claude/channel/permission`, CC never sends permission requests to
that server.

## Protocol Flow

```
  Claude Code                      MCP Server (telegram)              Telegram
      |                                   |                               |
      |  [tool needs permission]          |                               |
      |                                   |                               |
      |-- notification ------------------>|                               |
      |   method: "notifications/         |                               |
      |     claude/channel/               |                               |
      |     permission_request"           |                               |
      |   params: {                       |                               |
      |     request_id,                   |                               |
      |     tool_name,                    |                               |
      |     description,                  |                               |
      |     input_preview                 |                               |
      |   }                               |                               |
      |                                   |-- sendMessage + buttons ----->|
      |                                   |   [Allow] [Deny]              |
      |                                   |                               |
      |                                   |<-- callback_data -------------|
      |                                   |   "perm:allow:<key>" etc.     |
      |                                   |                               |
      |<-- notification ------------------|                               |
      |   method: "notifications/         |                               |
      |     claude/channel/permission"    |                               |
      |   params: {                       |                               |
      |     request_id,                   |                               |
      |     behavior: "allow"|"deny"      |                               |
      |   }                               |                               |
      |                                   |                               |
      |  [tool runs or is cancelled]      |                               |
```

### Step 1: CC sends `permission_request` to the channel

MCP notification method: `notifications/claude/channel/permission_request`

```typescript
{
  method: "notifications/claude/channel/permission_request",
  params: {
    request_id: string,    // unique ID (generated per prompt)
    tool_name: string,     // e.g. "Bash", "Edit", "Write"
    description: string,   // human-readable summary of the action
    input_preview: string  // tool input, truncated to 200 chars + "…"
  }
}
```

CC broadcasts this to **all** connected channel servers that declare the
permission capability. It is a notification (no JSON-RPC response expected).

### Step 2: Channel sends `permission` response back to CC

MCP notification method: `notifications/claude/channel/permission`

```typescript
{
  method: "notifications/claude/channel/permission",
  params: {
    request_id: string,          // must match step 1
    behavior: "allow" | "deny"   // user's decision
  }
}
```

CC resolves the pending permission entry. Logged as:

```
notifications/claude/channel/permission: {id} -> {behavior}
  (matched pending | no pending entry - stale or unknown ID)
```

## Zod Schemas (extracted)

CC validates these with Zod internally:

```typescript
// Schema for the response CC listens for from the channel
const PermissionResponseSchema = z.object({
  method: z.literal("notifications/claude/channel/permission"),
  params: z.object({
    request_id: z.string(),
    behavior: z.enum(["allow", "deny"]),
  }),
})

// Schema for what CC sends (permission_request)
// Not explicitly validated outbound, but the shape is:
const PermissionRequestParams = {
  request_id: z.string(),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),  // max 200 chars
}
```

## Behavioral Notes

- **Interactive tools excluded:** CC skips the relay when
  `tool.requiresUserInteraction?.()` returns true.
- **input_preview truncation:** If the serialized input exceeds 200 characters,
  it is sliced to 200 and `"…"` is appended.
- **Stale responses are harmless:** If the user responds after the session
  aborts or the prompt is resolved by another means, CC logs it as "stale" and
  discards it.
- **Multiple channels:** CC broadcasts to all qualifying channel servers. The
  first response wins (resolves the pending entry); subsequent responses are
  logged as "no pending entry."
- **Coexistence with Notification hook:** The existing `notify-permission.sh`
  Notification hook (matcher: `permission_prompt`) fires independently of this
  relay. If both are active, the user gets **duplicate** permission messages in
  Telegram. Remove the hook once the relay is implemented.

## Implementation Checklist

1. Add `'claude/channel/permission': {}` to server capabilities
2. Register a notification handler for
   `notifications/claude/channel/permission_request`
3. On receipt: send Telegram message with inline keyboard
   (`[Allow]` / `[Deny]`). Use a short local key in `callback_data` mapped to
   the full `request_id` (Telegram limits `callback_data` to 64 bytes, and
   the `request_id` format is undocumented)
4. On button press: look up the local key to recover the full `request_id`,
   then send `notifications/claude/channel/permission` notification back to
   CC with `request_id` and `behavior`
5. Remove `notify-permission.sh` from `hooks.json` (or gate it behind a
   feature flag during transition)
6. Clean up: edit/delete the Telegram message after the user responds

## Risk

This protocol is **undocumented**. It was extracted from the v2.1.81 binary and
could change in future releases. The official Telegram plugin
(`anthropics/claude-plugins-official`) has not adopted it yet as of this date.
Monitor the official plugin and changelog for breaking changes.

# cc-telegram-plus
Enhanced Telegram channel for Claude Code — drop-in replacement with more features

A community-maintained Telegram channel plugin for Claude Code that extends the official plugin with all media types, voice transcription, reply context, emoji reactions, inline buttons, multi-session management, and a comprehensive test suite. Drop-in compatible — reads the same config files, exposes the same commands.

## Feature comparison

| What you can do | Official | cc-telegram-plus |
|---|:---:|:---:|
| Send text messages | ✔ | ✔ |
| Send photos | ✔ | ✔ |
| Send documents, video, audio | ✘ | ✔ |
| Send voice messages | ✘ | ✔ auto-transcribed |
| Send stickers | ✘ | ✔ |
| Reply to a specific message | ✘ | ✔ Claude sees context |
| React with emoji | ✘ | ✔ Claude sees reactions |
| Claude sends inline buttons | ✘ | ✔ |
| Claude sends reply keyboards | ✘ | ✔ |
| Claude uses rich formatting | ✘ | ✔ MarkdownV2 + HTML |
| Switch between CC sessions | ✘ random delivery | ✔ managed switching |
| See which session is active | ✘ | ✔ pinned status |

## Requirements

- [Bun](https://bun.sh/) runtime
- Claude Code v2.1.80 or later
- Claude.ai login (console/API key auth not supported for channels)

## Installation

```bash
# Remove the official plugin first (can't run both)
claude plugins uninstall telegram

# Install cc-telegram-plus from the local marketplace
claude plugins install telegram@local
```

## Starting Claude Code with Telegram

Channels are a research preview feature. The official plugin is on the
approved allowlist; community plugins like this one need the development
flag:

```bash
# For the official plugin (on the approved allowlist):
claude --channels plugin:telegram@claude-plugins-official

# For cc-telegram-plus (community/development plugin):
claude --dangerously-load-development-channels plugin:telegram@local
```

**Important:** Do NOT combine `--channels` and
`--dangerously-load-development-channels` for the same plugin — this
creates duplicate entries and the `--channels` one fails the allowlist
check. Use only `--dangerously-load-development-channels` for this plugin.

On first launch with the development flag, CC will show a warning and ask
you to confirm. Select "I am using this for local development" to proceed.

**Without the channels flag, the MCP tools will load but inbound Telegram
messages will not be delivered to Claude.**

### Auto-approve reply tools (optional)

By default, Claude asks for permission each time it sends a Telegram
message. To auto-approve, add the tools to your global settings:

Add to `~/.claude/settings.json` under `permissions.allow`:
```json
"mcp__plugin_telegram_telegram__reply",
"mcp__plugin_telegram_telegram__react",
"mcp__plugin_telegram_telegram__edit_message",
"mcp__plugin_telegram_telegram__fetch_media"
```

Or select "Yes, and don't ask again" when prompted during a session.

## Setup (new users)

1. Create a bot via @BotFather on Telegram
2. Start Claude Code with the channels flag (see above)
3. Run `/telegram:configure <token>` in Claude Code
4. Restart Claude Code (with `--channels`) to load the bot token
5. Message your bot on Telegram — it will prompt for pairing
6. Run `/telegram:access pair <code>` to approve
7. Optional: `/telegram:access policy allowlist` to lock down

## Migration from the official plugin

Your existing `.env` and `access.json` transfer automatically. cc-telegram-plus adds optional fields (`ackReaction`, `replyToMode`, etc.) that the official plugin ignores. Caveat: if you switch back, the official plugin may strip these additive fields when it rewrites `access.json`. Back up first.

## Usage tips

- **Photos, docs, video, audio:** Just send them. Claude sees a description and can download the file on demand if it needs the content.
- **Voice messages:** Automatically transcribed to text (requires `OPENAI_API_KEY` env var). Claude sees the transcript directly.
- **Reply to a message:** Claude sees the quoted message for context.
- **React with emoji:** Claude sees your reaction as lightweight feedback.
- **Rich replies:** Claude can send formatted text, inline buttons, and reply keyboards.

## Session management

Multiple Claude Code instances share one bot. Only one session receives
messages at a time — no random delivery.

**Bot commands:**

| Command | Description |
|---|---|
| `/sessions` | Show active session + switch buttons for others |
| `/switch` | Show switch buttons (or `/switch <name>` to switch directly) |
| `/name <label>` | Rename the active session (or tap for a prompt) |
| `/status` | Show which session is active |
| `/chatid` | Show this chat's ID |

**How it works:**
- The first session to start becomes active and polls Telegram
- When a new session starts, you get a notification with a switch button
- Switching pins an "Active session: **name**" message to the chat
- Renaming also updates the pinned message
- If the active session closes, another takes over automatically (~3s)
- Switch takes ~3s (waits for Telegram long-poll to close cleanly)

## Permissions and unattended use

When Claude needs to run a command or edit a file that isn't pre-approved,
it shows a permission prompt **in the terminal**. From Telegram, this looks
like the bot is stuck. Claude will try to warn you before this happens.

To reduce prompts, auto-approve common tools in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Read", "Glob", "Grep", "LS",
      "Bash(git:*)",
      "mcp__plugin_telegram_telegram__reply",
      "mcp__plugin_telegram_telegram__react",
      "mcp__plugin_telegram_telegram__edit_message",
      "mcp__plugin_telegram_telegram__fetch_media"
    ]
  }
}
```

For fully unattended use in trusted environments:
```bash
claude --dangerously-load-development-channels plugin:telegram@local \
  --dangerously-skip-permissions
```

## Tool reference

| Tool | Description |
|---|---|
| `reply` | Send text/files to Telegram with formatting and keyboards |
| `react` | Add emoji reaction to a message |
| `edit_message` | Edit a previously sent message |
| `fetch_media` | Download a media attachment by token |

## Advanced configuration

These optional fields in `~/.claude/channels/telegram/access.json`
customize the bot's behavior. These are compatible with the official
plugin — your config transfers if you switch between plugins.

| Field | Default | Description |
|---|---|---|
| `ackReaction` | *(none)* | Emoji to react with when a message is received (e.g. `"👀"`). Cleared when Claude replies. Shows the user their message was seen. |
| `replyToMode` | `"off"` | Threading for Claude's replies: `"off"` = no threading, `"first"` = first chunk threads under your message, `"all"` = all chunks thread |
| `textChunkLimit` | `4096` | Max characters per message before splitting (Telegram's hard limit is 4096) |
| `chunkMode` | `"length"` | How to split long replies: `"length"` = hard character cut, `"newline"` = prefer paragraph boundaries |
| `mentionPatterns` | *(none)* | Array of regex patterns that trigger the bot in groups, beyond @botname (e.g. `["hey claude", "cc:"]`) |

Example:
```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["23627540"],
  "groups": {},
  "pending": {},
  "ackReaction": "👀",
  "replyToMode": "first",
  "chunkMode": "newline"
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | From BotFather (stored in `~/.claude/channels/telegram/.env`) |
| `OPENAI_API_KEY` | No | Enables voice transcription via Whisper |

## Troubleshooting

**MCP tools load but no messages from Telegram:**
Start Claude Code with `--dangerously-load-development-channels`. See
"Starting Claude Code with Telegram" above.

**"not on the approved channels allowlist":**
Use `--dangerously-load-development-channels plugin:telegram@local` as
the only channels flag. Do not combine with `--channels`.

**Bot shows typing indicator but Claude doesn't respond:**
Ensure you used `--dangerously-load-development-channels` (not `--channels`).
Also check that no zombie MCP server processes are holding the bot token —
run `ps aux | grep server.ts` and kill stale ones.

**Session label shows "0.1.0":**
Known issue — CC doesn't expose the project directory to MCP server
processes. The label will show the plugin cache version directory name
instead of the project name.

## Contributing

Contributions welcome! Please open issues for bugs and feature requests.

## Upstream goal

We aim to contribute features back to the official Anthropic Telegram plugin. This project fills feature gaps while those contributions are in progress.

## License

MIT

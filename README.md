# cc-telegram-plus
Enhanced Telegram channel for Claude Code — drop-in replacement with more features

A community-maintained Telegram channel plugin for Claude Code that extends the official plugin with all media types, voice transcription, reply context, emoji reactions, inline buttons, multi-session management, and a comprehensive test suite. Drop-in compatible — reads the same config files, exposes the same commands.

## Feature comparison

| Feature | Official Plugin | cc-telegram-plus |
|---|---|---|
| Text messages | Yes | Yes |
| Photos | Yes (eager download) | Yes (lazy token) |
| Documents, Video, Audio | No | Yes |
| Voice messages | No | Yes (with transcription) |
| Stickers | No | Yes |
| Reply context | No | Yes |
| Emoji reactions (inbound) | No | Yes |
| Inline buttons | No | Yes |
| Reply keyboards | No | Yes |
| Session management | No | Yes |
| Rich formatting | No | MarkdownV2 + HTML |
| Ack reaction cleanup | No | Yes |
| Test suite | No | 70+ tests |

## Installation

```bash
# Remove the official plugin first (can't run both)
claude plugins remove telegram
# Install cc-telegram-plus
claude plugins add yaniv-golan/cc-telegram-plus
```

## Migration from the official plugin

Your existing `.env` and `access.json` transfer automatically. cc-telegram-plus adds optional fields (`ackReaction`, `replyToMode`, etc.) that the official plugin ignores. Caveat: if you switch back, the official plugin may strip these additive fields when it rewrites `access.json`. Back up first.

## Setup (new users)

1. Create a bot via @BotFather on Telegram
2. Run `/telegram:configure <token>` in Claude Code
3. Start chatting with your bot — it will prompt for pairing
4. Run `/telegram:access pair <code>` to approve
5. Optional: `/telegram:access policy allowlist` to lock down

## New features guide

- **Media:** All types arrive with a `media_token`. Agent calls `fetch_media` to download on demand.
- **Voice:** Automatically transcribed (requires `OPENAI_API_KEY` env var). Falls back to token-only if not set.
- **Sessions:** Multiple Claude Code instances share one bot. `/sessions` to see, `/switch` to change. Only one session receives messages at a time.
- **Keyboards:** Agent can send `reply_keyboard` for structured input, `inline_keyboard` for action buttons.

## Tool reference

| Tool | Description |
|---|---|
| `reply` | Send text/files to Telegram with formatting and keyboards |
| `react` | Add emoji reaction to a message |
| `edit_message` | Edit a previously sent message |
| `fetch_media` | Download a media attachment by token |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | From BotFather (stored in `~/.claude/channels/telegram/.env`) |
| `OPENAI_API_KEY` | No | Enables voice transcription via Whisper |

## Contributing

Contributions welcome! Please open issues for bugs and feature requests.

## Upstream goal

We aim to contribute features back to the official Anthropic Telegram plugin. This project fills feature gaps while those contributions are in progress.

## License

MIT

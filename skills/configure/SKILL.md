---
name: configure
description: Set up the Telegram channel — save the bot token and review access policy. Use when the user pastes a Telegram bot token, asks to configure Telegram, asks "how do I set this up" or "who can reach me," or wants to check channel status.
---

# Telegram Channel Configuration

## Commands

### No arguments — Show status
Display:
- Token status (set or not, bot username if available)
- Current DM policy
- Number of allowlisted users
- Active sessions
- Next steps (guide toward pairing → allowlist lockdown)

If pairing is active and allowlist has users, suggest: "Consider switching to `policy allowlist` to lock down access."

### `<token>`
Save a BotFather token:
1. Write `TELEGRAM_BOT_TOKEN=<token>` to `~/.claude/channels/telegram/.env`
2. Create the directory if it doesn't exist
3. Remind user that the channel server needs to restart to pick up the new token

### `clear`
Remove the token by deleting the `.env` file.

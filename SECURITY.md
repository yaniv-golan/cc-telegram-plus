# Security Policy

## Reporting a vulnerability

If you find a security issue, **do not open a public issue.** Email yaniv@golan.name with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact

I'll respond within 48 hours and work with you on a fix before public disclosure.

## Scope

This plugin handles:
- Telegram bot tokens (stored in `~/.claude/channels/telegram/.env`)
- User allowlists (stored in `access.json`)
- Message content forwarded between Telegram and Claude Code

Security issues in these areas are in scope.

## Known security boundaries

- The `gate()` function enforces sender allowlists — only approved user IDs can send messages to Claude
- `assertSendable()` prevents the reply tool from leaking files in the state directory (except inbox)
- The plugin never stores message content permanently (cache is session-scoped and auto-deleted)
- Access control mutations use file-based locking to prevent race conditions

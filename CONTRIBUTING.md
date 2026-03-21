# Contributing

Thanks for your interest in cc-telegram-plus!

## Reporting bugs

Open an issue with:
- What you expected
- What happened
- Steps to reproduce
- CC version (`claude --version`), OS, and IDE

## Suggesting features

Open an issue describing the use case, not just the solution.

## Pull requests

1. Fork and create a branch from `main`
2. Make your changes
3. Run `bun test` — all 167+ tests must pass
4. Keep commits focused — one logical change per PR
5. Update the README if you add user-facing features

## Code style

- TypeScript, Bun runtime
- No unnecessary dependencies
- Match the existing patterns (handlers, sessions, gate)
- Tests go in `tests/` with `.test.ts` suffix

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

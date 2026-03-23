/**
 * Scrub known secret patterns from text before sending to Telegram.
 * Defense-in-depth: if Claude quotes a .env file or log line containing
 * a key, the secret won't reach Telegram's servers.
 */

type Pattern = { regex: RegExp; label: string }

const PATTERNS: Pattern[] = [
  // OpenAI / Anthropic style keys
  { regex: /\b(sk-[a-zA-Z0-9]{20,})\b/g, label: 'API-KEY' },
  // AWS access key IDs
  { regex: /\b(AKIA[0-9A-Z]{16})\b/g, label: 'AWS-KEY' },
  // GitHub personal access tokens
  { regex: /\b(ghp_[a-zA-Z0-9]{36,})\b/g, label: 'GH-TOKEN' },
  // GitHub fine-grained tokens
  { regex: /\b(github_pat_[a-zA-Z0-9_]{20,})\b/g, label: 'GH-TOKEN' },
  // Slack tokens
  { regex: /\b(xox[bpas]-[a-zA-Z0-9\-]{10,})\b/g, label: 'SLACK-TOKEN' },
  // PEM private keys
  { regex: /-----BEGIN [A-Z ]+ PRIVATE KEY-----/g, label: 'PRIVATE-KEY' },
  // Generic "bearer" tokens in authorization headers
  { regex: /\b(Bearer\s+[a-zA-Z0-9\-._~+/]{20,})\b/g, label: 'BEARER-TOKEN' },
  // Telegram bot tokens (our own or others): numeric_id:alphanumeric_35+
  { regex: /\b(\d{8,}:[A-Za-z0-9_\-]{30,})\b/g, label: 'BOT-TOKEN' },
]

export function scrub(text: string): { text: string; redacted: number } {
  let redacted = 0

  let result = text
  for (const { regex, label } of PATTERNS) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0
    result = result.replace(regex, () => {
      redacted++
      return `[REDACTED-${label}]`
    })
  }

  return { text: result, redacted }
}

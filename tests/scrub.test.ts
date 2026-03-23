import { describe, test, expect } from 'bun:test'
import { scrub } from '../src/scrub.ts'

describe('scrub', () => {
  test('returns unchanged text when no secrets', () => {
    const input = 'Hello, this is a normal message with no secrets.'
    const result = scrub(input)
    expect(result.text).toBe(input)
    expect(result.redacted).toBe(0)
  })

  test('redacts OpenAI-style API keys', () => {
    const result = scrub('My key is sk-abc123def456ghi789jkl012mno345')
    expect(result.text).toContain('[REDACTED-API-KEY]')
    expect(result.text).not.toContain('sk-abc123')
    expect(result.redacted).toBe(1)
  })

  test('redacts AWS access key IDs', () => {
    const result = scrub('AWS key: AKIAIOSFODNN7EXAMPLE')
    expect(result.text).toContain('[REDACTED-AWS-KEY]')
    expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(result.redacted).toBe(1)
  })

  test('redacts GitHub personal access tokens', () => {
    const result = scrub('Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl')
    expect(result.text).toContain('[REDACTED-GH-TOKEN]')
    expect(result.redacted).toBe(1)
  })

  test('redacts GitHub fine-grained tokens', () => {
    const result = scrub('Token: github_pat_ABCDEFGHIJKLMNOPQRST_1234567890')
    expect(result.text).toContain('[REDACTED-GH-TOKEN]')
    expect(result.redacted).toBe(1)
  })

  test('redacts Slack tokens', () => {
    const result = scrub('Slack: xoxb-123456789-abcdefghij')
    expect(result.text).toContain('[REDACTED-SLACK-TOKEN]')
    expect(result.redacted).toBe(1)
  })

  test('redacts PEM private keys', () => {
    const result = scrub('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')
    expect(result.text).toContain('[REDACTED-PRIVATE-KEY]')
    expect(result.redacted).toBe(1)
  })

  test('redacts Bearer tokens', () => {
    const result = scrub('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWI')
    expect(result.text).toContain('[REDACTED-BEARER-TOKEN]')
    expect(result.redacted).toBe(1)
  })

  test('redacts Telegram bot tokens', () => {
    const result = scrub('Bot token: 123456789:ABCDefgh_ijKLMnoPQRstuVWXyz-123456789')
    expect(result.text).toContain('[REDACTED-BOT-TOKEN]')
    expect(result.redacted).toBe(1)
  })

  test('redacts multiple secrets in one message', () => {
    const result = scrub(
      'AWS: AKIAIOSFODNN7EXAMPLE\nGH: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl'
    )
    expect(result.redacted).toBe(2)
    expect(result.text).toContain('[REDACTED-AWS-KEY]')
    expect(result.text).toContain('[REDACTED-GH-TOKEN]')
  })

  test('preserves surrounding text', () => {
    const result = scrub('Before AKIAIOSFODNN7EXAMPLE after')
    expect(result.text).toBe('Before [REDACTED-AWS-KEY] after')
  })

  test('handles empty string', () => {
    const result = scrub('')
    expect(result.text).toBe('')
    expect(result.redacted).toBe(0)
  })

  test('does not redact short strings that happen to start with sk-', () => {
    // sk- followed by less than 20 chars should not match
    const result = scrub('sk-short')
    expect(result.text).toBe('sk-short')
    expect(result.redacted).toBe(0)
  })
})

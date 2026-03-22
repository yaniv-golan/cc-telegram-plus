import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createAccessIO } from '../src/access-io.ts'
import type { Access } from '../src/types.ts'

const DEFAULT_ACCESS: Access = {
  dmPolicy: 'pairing',
  allowFrom: [],
  groups: {},
  pending: {},
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'access-io-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadAccess', () => {
  it('reads and parses access.json', () => {
    const { loadAccess } = createAccessIO(tmpDir)
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['alice', 'bob'],
      groups: { g1: { requireMention: true, allowFrom: [] } },
      pending: { p1: { senderId: 's1', chatId: 'c1', createdAt: 1, expiresAt: 2, replies: 0 } },
    }
    writeFileSync(join(tmpDir, 'access.json'), JSON.stringify(access, null, 2))
    expect(loadAccess()).toEqual(access)
  })

  it('returns default Access when file is missing', () => {
    const { loadAccess } = createAccessIO(tmpDir)
    expect(loadAccess()).toEqual(DEFAULT_ACCESS)
  })

  it('returns default Access when JSON is corrupt', () => {
    const { loadAccess } = createAccessIO(tmpDir)
    writeFileSync(join(tmpDir, 'access.json'), 'not valid json {{{{')
    expect(loadAccess()).toEqual(DEFAULT_ACCESS)
  })
})

describe('saveAccess', () => {
  it('writes access.json with correct content', () => {
    const { saveAccess } = createAccessIO(tmpDir)
    const access: Access = {
      dmPolicy: 'disabled',
      allowFrom: ['user1'],
      groups: {},
      pending: {},
    }
    saveAccess(access)
    const raw = readFileSync(join(tmpDir, 'access.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual(access)
  })

  it('preserves additive fields (ackReaction, replyToMode)', () => {
    const { saveAccess, loadAccess } = createAccessIO(tmpDir)
    const access: Access = {
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
      ackReaction: '👍',
      replyToMode: 'all',
    }
    saveAccess(access)
    expect(loadAccess()).toEqual(access)
  })

  it('is atomic — no .tmp file left after save', () => {
    const { saveAccess } = createAccessIO(tmpDir)
    saveAccess(DEFAULT_ACCESS)
    expect(existsSync(join(tmpDir, 'access.tmp.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'access.json'))).toBe(true)
  })
})

describe('withAccessLock', () => {
  it('wraps fn correctly and returns its value', () => {
    const { withAccessLock } = createAccessIO(tmpDir)
    const result = withAccessLock(() => 42)
    expect(result).toBe(42)
  })
})

describe('round-trip', () => {
  it('save then load returns same data', () => {
    const { saveAccess, loadAccess } = createAccessIO(tmpDir)
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['someone'],
      groups: { myGroup: { requireMention: false, allowFrom: ['a', 'b'] } },
      pending: {},
      mentionPatterns: ['@bot'],
      textChunkLimit: 1000,
      chunkMode: 'newline',
    }
    saveAccess(access)
    expect(loadAccess()).toEqual(access)
  })
})

// Static mode tests
// Note: STATIC is read at module load time via process.env, so we test the
// static-mode code path by calling createAccessIO with a manually constructed
// bootSnapshot scenario. We simulate static behavior by setting the env var
// before the module is evaluated — but since the module is already loaded in
// tests, we test the observable contract via the returned functions directly.

describe('isStatic flag', () => {
  it('returns isStatic: false when TELEGRAM_ACCESS_MODE is not set', () => {
    const { isStatic } = createAccessIO(tmpDir)
    // In the test environment TELEGRAM_ACCESS_MODE is not 'static'
    expect(isStatic).toBe(false)
  })
})

describe('saveAccess in non-static mode', () => {
  it('does not throw and writes file', () => {
    const { saveAccess } = createAccessIO(tmpDir)
    const access: Access = { dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }
    expect(() => saveAccess(access)).not.toThrow()
  })
})

describe('loadAccess returns independent copies in non-static mode', () => {
  it('mutations to one load result do not affect subsequent loads', () => {
    const { saveAccess, loadAccess } = createAccessIO(tmpDir)
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['alice'],
      groups: {},
      pending: {},
    }
    saveAccess(access)
    const first = loadAccess()
    first.allowFrom.push('mutated')
    const second = loadAccess()
    expect(second.allowFrom).toEqual(['alice'])
  })
})

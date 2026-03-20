import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gate, isMentioned, pruneExpired, assertAllowedChat, assertSendable, isUserAuthorized } from '../src/gate.ts'
import { createAccess, createTextCtx } from './helpers.ts'
import type { Access } from '../src/types.ts'

const BOT_USERNAME = 'testbot'

// ─── gate - DM ───────────────────────────────────────────────────────────────

describe('gate - DM', () => {
  it('disabled policy drops', () => {
    const ctx = createTextCtx('hello')
    const access = createAccess({ dmPolicy: 'disabled' })
    expect(gate(ctx, access, BOT_USERNAME)).toEqual({ action: 'drop' })
  })

  it('allowlist + known sender delivers', () => {
    const ctx = createTextCtx('hi', { userId: 12345 })
    const access = createAccess({ dmPolicy: 'allowlist', allowFrom: ['12345'] })
    const result = gate(ctx, access, BOT_USERNAME)
    expect(result.action).toBe('deliver')
  })

  it('allowlist + unknown sender drops', () => {
    const ctx = createTextCtx('hi', { userId: 99999 })
    const access = createAccess({ dmPolicy: 'allowlist', allowFrom: ['12345'] })
    expect(gate(ctx, access, BOT_USERNAME)).toEqual({ action: 'drop' })
  })

  it('pairing + known sender delivers', () => {
    const ctx = createTextCtx('hi', { userId: 12345 })
    const access = createAccess({ dmPolicy: 'pairing', allowFrom: ['12345'] })
    const result = gate(ctx, access, BOT_USERNAME)
    expect(result.action).toBe('deliver')
  })

  it('pairing + unknown sender creates pair with code', () => {
    const ctx = createTextCtx('hi', { userId: 99999, chatId: 99999 })
    const access = createAccess({ dmPolicy: 'pairing', allowFrom: ['12345'] })
    const result = gate(ctx, access, BOT_USERNAME, { generateCode: () => 'abcd' })
    expect(result).toEqual({
      action: 'pair',
      code: 'abcd',
      senderId: '99999',
      chatId: '99999',
      updatedAccess: expect.objectContaining({
        pending: {
          abcd: expect.objectContaining({
            senderId: '99999',
            chatId: '99999',
            replies: 0,
          }),
        },
      }),
    })
  })

  it('pairing + sender already pending reuses code and increments replies', () => {
    const ctx = createTextCtx('hi', { userId: 99999, chatId: 99999 })
    const access = createAccess({
      dmPolicy: 'pairing',
      allowFrom: ['12345'],
      pending: {
        xyzz: {
          senderId: '99999',
          chatId: '99999',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          replies: 0,
        },
      },
    })
    const result = gate(ctx, access, BOT_USERNAME, { generateCode: () => 'abcd' })
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.code).toBe('xyzz')
      expect(result.updatedAccess.pending['xyzz'].replies).toBe(1)
    }
  })

  it('pairing + reply cap reached (replies=2) drops', () => {
    const ctx = createTextCtx('hi', { userId: 99999, chatId: 99999 })
    const access = createAccess({
      dmPolicy: 'pairing',
      allowFrom: ['12345'],
      pending: {
        xyzz: {
          senderId: '99999',
          chatId: '99999',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          replies: 2,
        },
      },
    })
    expect(gate(ctx, access, BOT_USERNAME)).toEqual({ action: 'drop' })
  })

  it('pairing + 3 pending already drops new sender', () => {
    const ctx = createTextCtx('hi', { userId: 99999, chatId: 99999 })
    const access = createAccess({
      dmPolicy: 'pairing',
      allowFrom: ['12345'],
      pending: {
        aa: { senderId: '1', chatId: '1', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 0 },
        bb: { senderId: '2', chatId: '2', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 0 },
        cc: { senderId: '3', chatId: '3', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 0 },
      },
    })
    expect(gate(ctx, access, BOT_USERNAME)).toEqual({ action: 'drop' })
  })
})

// ─── gate - group ─────────────────────────────────────────────────────────────

describe('gate - group', () => {
  it('group not registered drops', () => {
    const ctx = createTextCtx('hello', { chatId: -1001 })
    ctx.chat.type = 'supergroup'
    const access = createAccess()
    expect(gate(ctx, access, BOT_USERNAME)).toEqual({ action: 'drop' })
  })

  it('requireMention true + not mentioned drops', () => {
    const ctx = createTextCtx('hello', { chatId: -1001 })
    ctx.chat.type = 'supergroup'
    const access = createAccess({
      groups: { '-1001': { requireMention: true, allowFrom: [] } },
    })
    expect(gate(ctx, access, BOT_USERNAME)).toEqual({ action: 'drop' })
  })

  it('@username mention delivers', () => {
    const ctx = createTextCtx('@testbot hello', { chatId: -1001 })
    ctx.chat.type = 'supergroup'
    ctx.message.entities = [{ type: 'mention', offset: 0, length: 8 }]
    const access = createAccess({
      groups: { '-1001': { requireMention: true, allowFrom: [] } },
    })
    const result = gate(ctx, access, BOT_USERNAME)
    expect(result.action).toBe('deliver')
  })

  it('reply to bot delivers', () => {
    const ctx = createTextCtx('hello', { chatId: -1001 })
    ctx.chat.type = 'supergroup'
    ctx.message.reply_to_message = {
      message_id: 5,
      from: { id: 0, username: 'testbot', is_bot: true },
    }
    const access = createAccess({
      groups: { '-1001': { requireMention: true, allowFrom: [] } },
    })
    const result = gate(ctx, access, BOT_USERNAME)
    expect(result.action).toBe('deliver')
  })

  it('regex pattern match delivers', () => {
    const ctx = createTextCtx('hey claude, do something', { chatId: -1001 })
    ctx.chat.type = 'supergroup'
    const access = createAccess({
      groups: { '-1001': { requireMention: true, allowFrom: [] } },
      mentionPatterns: ['\\bclaude\\b'],
    })
    const result = gate(ctx, access, BOT_USERNAME)
    expect(result.action).toBe('deliver')
  })

  it('per-group allowFrom: not in list drops', () => {
    const ctx = createTextCtx('hello', { chatId: -1001, userId: 99999 })
    ctx.chat.type = 'supergroup'
    const access = createAccess({
      groups: { '-1001': { requireMention: false, allowFrom: ['12345'] } },
    })
    expect(gate(ctx, access, BOT_USERNAME)).toEqual({ action: 'drop' })
  })

  it('per-group allowFrom: in list delivers', () => {
    const ctx = createTextCtx('hello', { chatId: -1001, userId: 12345 })
    ctx.chat.type = 'supergroup'
    const access = createAccess({
      groups: { '-1001': { requireMention: false, allowFrom: ['12345'] } },
    })
    const result = gate(ctx, access, BOT_USERNAME)
    expect(result.action).toBe('deliver')
  })
})

// ─── isMentioned ──────────────────────────────────────────────────────────────

describe('isMentioned', () => {
  it('@botusername entity returns true', () => {
    const ctx = createTextCtx('@testbot hello')
    ctx.message.entities = [{ type: 'mention', offset: 0, length: 8 }]
    expect(isMentioned(ctx, BOT_USERNAME)).toBe(true)
  })

  it('reply to bot returns true', () => {
    const ctx = createTextCtx('hello')
    ctx.message.reply_to_message = {
      message_id: 5,
      from: { id: 0, username: 'testbot', is_bot: true },
    }
    expect(isMentioned(ctx, BOT_USERNAME)).toBe(true)
  })

  it('regex match returns true', () => {
    const ctx = createTextCtx('hey claude help')
    expect(isMentioned(ctx, BOT_USERNAME, ['\\bclaude\\b'])).toBe(true)
  })

  it('no mention returns false', () => {
    const ctx = createTextCtx('just a message')
    expect(isMentioned(ctx, BOT_USERNAME)).toBe(false)
  })
})

// ─── pruneExpired ─────────────────────────────────────────────────────────────

describe('pruneExpired', () => {
  it('removes expired entries and returns true', () => {
    const access = createAccess({
      pending: {
        old: { senderId: '1', chatId: '1', createdAt: 0, expiresAt: 1, replies: 0 },
      },
    })
    expect(pruneExpired(access)).toBe(true)
    expect(access.pending).toEqual({})
  })

  it('nothing expired returns false', () => {
    const access = createAccess({
      pending: {
        fresh: {
          senderId: '1',
          chatId: '1',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          replies: 0,
        },
      },
    })
    expect(pruneExpired(access)).toBe(false)
    expect(Object.keys(access.pending)).toHaveLength(1)
  })

  it('mix of expired and valid removes only expired', () => {
    const access = createAccess({
      pending: {
        old: { senderId: '1', chatId: '1', createdAt: 0, expiresAt: 1, replies: 0 },
        fresh: {
          senderId: '2',
          chatId: '2',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          replies: 0,
        },
      },
    })
    expect(pruneExpired(access)).toBe(true)
    expect(access.pending['old']).toBeUndefined()
    expect(access.pending['fresh']).toBeDefined()
  })
})

// ─── assertSendable ───────────────────────────────────────────────────────────

describe('assertSendable', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gate-test-'))
    mkdirSync(join(tmpDir, 'inbox'), { recursive: true })
  })

  afterAll(() => {
    // cleanup happens automatically with temp dirs
  })

  it('file in state dir (not inbox) throws', () => {
    const filePath = join(tmpDir, 'secret.json')
    writeFileSync(filePath, 'data')
    expect(() => assertSendable(filePath, tmpDir)).toThrow()
  })

  it('file in inbox is ok', () => {
    const filePath = join(tmpDir, 'inbox', 'file.txt')
    writeFileSync(filePath, 'data')
    expect(() => assertSendable(filePath, tmpDir)).not.toThrow()
  })

  it('symlink in inbox resolving to outside throws', () => {
    // Create a file outside the state dir to simulate .env
    const envFile = join(tmpDir, '..', 'fake-env-' + Date.now())
    writeFileSync(envFile, 'SECRET=bad')
    const linkPath = join(tmpDir, 'inbox', 'sneaky-link')
    symlinkSync(envFile, linkPath)
    // The resolved path is outside stateDir entirely, so it should be OK per spec
    // Actually: resolved path is outside stateDir, so it's allowed. But the REAL
    // test is: symlink IN inbox that resolves to a file IN stateDir but NOT in inbox.
    rmSync(envFile)
    rmSync(linkPath)

    // Proper test: symlink in inbox pointing to stateDir root file
    const secretFile = join(tmpDir, 'access.json')
    writeFileSync(secretFile, '{"secret":true}')
    const sneakyLink = join(tmpDir, 'inbox', 'sneaky')
    symlinkSync(secretFile, sneakyLink)
    expect(() => assertSendable(sneakyLink, tmpDir)).toThrow()
  })

  it('file outside state dir is ok', () => {
    const outerDir = mkdtempSync(join(tmpdir(), 'gate-outer-'))
    const filePath = join(outerDir, 'external.txt')
    writeFileSync(filePath, 'data')
    expect(() => assertSendable(filePath, outerDir + '-not-state')).not.toThrow()
  })

  it('non-existent file throws', () => {
    expect(() => assertSendable('/tmp/nonexistent-file-xyz-123', tmpDir)).toThrow()
  })
})

// ─── assertAllowedChat ────────────────────────────────────────────────────────

describe('assertAllowedChat', () => {
  it('known user chat is ok', () => {
    const access = createAccess({ allowFrom: ['12345'] })
    expect(() => assertAllowedChat('12345', access)).not.toThrow()
  })

  it('group chat is ok', () => {
    const access = createAccess({
      groups: { '-1001': { requireMention: false, allowFrom: [] } },
    })
    expect(() => assertAllowedChat('-1001', access)).not.toThrow()
  })

  it('unknown chat throws', () => {
    const access = createAccess()
    expect(() => assertAllowedChat('99999', access)).toThrow()
  })
})

// ─── isUserAuthorized ─────────────────────────────────────────────────────────

describe('isUserAuthorized', () => {
  it('in allowFrom returns true', () => {
    const access = createAccess({ allowFrom: ['12345'] })
    expect(isUserAuthorized('12345', access)).toBe(true)
  })

  it('not in allowFrom returns false', () => {
    const access = createAccess({ allowFrom: ['12345'] })
    expect(isUserAuthorized('99999', access)).toBe(false)
  })
})

// ─── pending entry management ─────────────────────────────────────────────────

describe('pending entry management', () => {
  it('removing pending code frees slot for new sender', () => {
    const access = createAccess({
      dmPolicy: 'pairing',
      allowFrom: ['12345'],
      pending: {
        aa: { senderId: '1', chatId: '1', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 0 },
        bb: { senderId: '2', chatId: '2', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 0 },
        cc: { senderId: '3', chatId: '3', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 0 },
      },
    })

    // At capacity - new sender should be dropped
    const ctx1 = createTextCtx('hi', { userId: 99999, chatId: 99999 })
    expect(gate(ctx1, access, BOT_USERNAME)).toEqual({ action: 'drop' })

    // Remove one pending entry
    delete access.pending['cc']

    // Now new sender should be able to pair
    const ctx2 = createTextCtx('hi', { userId: 99999, chatId: 99999 })
    const result = gate(ctx2, access, BOT_USERNAME, { generateCode: () => 'newcode' })
    expect(result.action).toBe('pair')
  })
})

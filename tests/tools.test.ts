import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleToolCall } from '../src/tools.ts'
import { createMockDeps, createMockBot, createAccess } from './helpers.ts'
import type { Deps, MessageCache, SessionManager } from '../src/types.ts'

// ─── helpers ─────────────────────────────────────────────────────────────────

let msgIdCounter = 0
function stubWithMessageId(method: string, calls: any[]) {
  return (...args: any[]) => {
    calls.push({ method, args })
    return Promise.resolve({ message_id: ++msgIdCounter })
  }
}

function makeDeps(overrides: Partial<Deps> = {}): { deps: Deps; calls: any[] } {
  const calls: any[] = []
  const { bot } = createMockBot()

  // Override stubs to return message_id
  bot.api.sendMessage = stubWithMessageId('api.sendMessage', calls)
  bot.api.sendPhoto = stubWithMessageId('api.sendPhoto', calls)
  bot.api.sendDocument = stubWithMessageId('api.sendDocument', calls)
  bot.api.setMessageReaction = (...args: any[]) => {
    calls.push({ method: 'api.setMessageReaction', args })
    return Promise.resolve(true)
  }
  bot.api.editMessageText = (...args: any[]) => {
    calls.push({ method: 'api.editMessageText', args })
    return Promise.resolve({ message_id: 1 })
  }

  const cacheSets: { chatId: string; messageId: string; content: string }[] = []
  const cache: MessageCache = {
    get() { return undefined },
    set(chatId, messageId, content) { cacheSets.push({ chatId, messageId, content }) },
    flush() {},
    destroy() {},
  }

  const ackedMessages: Record<string, number[]> = {}
  const lastInbound: Record<string, string> = {}
  const sessions: SessionManager = {
    register() { return 'mock' },
    isActive() { return false },
    watch() {},
    stop() {},
    activate() {},
    async switchTo() { return true },
    getAll() { return {} },
    getDeepLink() { return '' },
    addAckedMessage(chatId, messageId) {
      if (!ackedMessages[chatId]) ackedMessages[chatId] = []
      ackedMessages[chatId].push(messageId)
    },
    clearAckedMessages(chatId) {
      const ids = ackedMessages[chatId] ?? []
      delete ackedMessages[chatId]
      return ids
    },
    getLastInbound(chatId) { return lastInbound[chatId] },
    setLastInbound(chatId, messageId) { lastInbound[chatId] = messageId },
  }

  const deps = createMockDeps({
    bot: bot as any,
    cache,
    sessions,
    ...overrides,
  })

  return { deps, calls }
}

// ─── reply ───────────────────────────────────────────────────────────────────

describe('reply', () => {
  beforeEach(() => { msgIdCounter = 0 })

  it('sends text reply via sendMessage', async () => {
    const { deps, calls } = makeDeps()
    const result = await handleToolCall('reply', { chat_id: '12345', text: 'hello' }, deps)
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0].args[0]).toBe('12345')
    expect(sends[0].args[1]).toBe('hello')
    expect(result.content[0].text).toContain('1')
  })

  it('chunks long text into multiple sendMessage calls', async () => {
    const { deps, calls } = makeDeps({
      loadAccess: () => createAccess({ textChunkLimit: 10 }),
    })
    const text = 'a'.repeat(25) // 3 chunks of 10, 10, 5
    await handleToolCall('reply', { chat_id: '12345', text }, deps)
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    expect(sends.length).toBeGreaterThanOrEqual(3)
  })

  it('sends image file via sendPhoto', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tools-test-'))
    const imgPath = join(tmpDir, 'test.jpg')
    writeFileSync(imgPath, Buffer.alloc(100))
    try {
      const { deps, calls } = makeDeps({ stateDir: join(tmpDir, 'state') })
      await handleToolCall('reply', { chat_id: '12345', files: [imgPath] }, deps)
      const sends = calls.filter(c => c.method === 'api.sendPhoto')
      expect(sends).toHaveLength(1)
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('sends non-image file via sendDocument', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tools-test-'))
    const filePath = join(tmpDir, 'test.pdf')
    writeFileSync(filePath, Buffer.alloc(100))
    try {
      const { deps, calls } = makeDeps({ stateDir: join(tmpDir, 'state') })
      await handleToolCall('reply', { chat_id: '12345', files: [filePath] }, deps)
      const sends = calls.filter(c => c.method === 'api.sendDocument')
      expect(sends).toHaveLength(1)
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('rejects unknown chat', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('reply', { chat_id: '99999', text: 'hello' }, deps)
    expect(result.content[0].text).toContain('not allowed')
  })

  it('blocks file inside state dir (not inbox)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tools-test-'))
    const stateDir = join(tmpDir, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filePath = join(stateDir, 'secret.json')
    writeFileSync(filePath, '{}')
    try {
      const { deps } = makeDeps({ stateDir })
      const result = await handleToolCall('reply', { chat_id: '12345', files: [filePath] }, deps)
      expect(result.content[0].text).toContain('not in inbox')
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('retries without parse_mode on MarkdownV2 parse error', async () => {
    const { deps, calls } = makeDeps()
    let callCount = 0
    ;(deps.bot as any).api.sendMessage = (...args: any[]) => {
      callCount++
      if (callCount === 1) {
        const err: any = new Error('Bad Request: can\'t parse entities')
        err.error_code = 400
        return Promise.reject(err)
      }
      calls.push({ method: 'api.sendMessage', args })
      return Promise.resolve({ message_id: 1 })
    }
    await handleToolCall('reply', { chat_id: '12345', text: 'hello *world' }, deps)
    // Second call should NOT have parse_mode
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0].args[2]?.parse_mode).toBeUndefined()
  })

  it('clears ack reactions on success', async () => {
    const { deps, calls } = makeDeps()
    // Pre-populate acked messages
    deps.sessions.addAckedMessage('12345', 100)
    deps.sessions.addAckedMessage('12345', 101)

    await handleToolCall('reply', { chat_id: '12345', text: 'hi' }, deps)
    const reactions = calls.filter(c => c.method === 'api.setMessageReaction')
    expect(reactions).toHaveLength(2)
    expect(reactions[0].args[1]).toBe(100)
    expect(reactions[1].args[1]).toBe(101)
  })

  it('stores sent message in cache', async () => {
    const cacheSets: any[] = []
    const cache: MessageCache = {
      get() { return undefined },
      set(chatId, messageId, content) { cacheSets.push({ chatId, messageId, content }) },
      flush() {},
      destroy() {},
    }
    const { deps } = makeDeps({ cache })
    await handleToolCall('reply', { chat_id: '12345', text: 'cached msg' }, deps)
    expect(cacheSets.length).toBeGreaterThanOrEqual(1)
    expect(cacheSets[0].content).toBe('cached msg')
  })

  it('replyToMode first: first chunk has reply_to', async () => {
    const { deps, calls } = makeDeps({
      loadAccess: () => createAccess({ replyToMode: 'first', textChunkLimit: 10 }),
    })
    deps.sessions.setLastInbound('12345', '42')
    await handleToolCall('reply', { chat_id: '12345', text: 'a'.repeat(25) }, deps)
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    expect(sends.length).toBeGreaterThanOrEqual(3)
    expect(sends[0].args[2]?.reply_parameters?.message_id).toBe(42)
    expect(sends[1].args[2]?.reply_parameters).toBeUndefined()
  })

  it('replyToMode all: all chunks have reply_to', async () => {
    const { deps, calls } = makeDeps({
      loadAccess: () => createAccess({ replyToMode: 'all', textChunkLimit: 10 }),
    })
    deps.sessions.setLastInbound('12345', '42')
    await handleToolCall('reply', { chat_id: '12345', text: 'a'.repeat(25) }, deps)
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    expect(sends.length).toBeGreaterThanOrEqual(3)
    for (const s of sends) {
      expect(s.args[2]?.reply_parameters?.message_id).toBe(42)
    }
  })

  it('explicit reply_to overrides replyToMode', async () => {
    const { deps, calls } = makeDeps({
      loadAccess: () => createAccess({ replyToMode: 'all' }),
    })
    deps.sessions.setLastInbound('12345', '42')
    await handleToolCall('reply', { chat_id: '12345', text: 'hi', reply_to: '99' }, deps)
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    expect(sends[0].args[2]?.reply_parameters?.message_id).toBe(99)
  })

  it('errors when no text and no files', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('reply', { chat_id: '12345' }, deps)
    expect(result.content[0].text).toContain('must have text or files')
  })
})

// ─── keyboard rules ──────────────────────────────────────────────────────────

describe('keyboard rules', () => {
  beforeEach(() => { msgIdCounter = 0 })

  it('inline_keyboard attaches to last text chunk', async () => {
    const { deps, calls } = makeDeps({
      loadAccess: () => createAccess({ textChunkLimit: 10 }),
    })
    const kb = [[{ text: 'Click', url: 'https://example.com' }]]
    await handleToolCall('reply', {
      chat_id: '12345',
      text: 'a'.repeat(25),
      inline_keyboard: kb,
    }, deps)
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    // Only last chunk has reply_markup
    for (let i = 0; i < sends.length - 1; i++) {
      expect(sends[i].args[2]?.reply_markup).toBeUndefined()
    }
    expect(sends[sends.length - 1].args[2]?.reply_markup?.inline_keyboard).toBeDefined()
  })

  it('reply_keyboard attaches to last text chunk', async () => {
    const { deps, calls } = makeDeps()
    const kb = [['Option A', 'Option B']]
    await handleToolCall('reply', {
      chat_id: '12345',
      text: 'pick one',
      reply_keyboard: kb,
    }, deps)
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    expect(sends[sends.length - 1].args[2]?.reply_markup?.keyboard).toBeDefined()
  })

  it('remove_keyboard sends ReplyKeyboardRemove', async () => {
    const { deps, calls } = makeDeps()
    await handleToolCall('reply', {
      chat_id: '12345',
      text: 'done',
      remove_keyboard: true,
    }, deps)
    const sends = calls.filter(c => c.method === 'api.sendMessage')
    expect(sends[0].args[2]?.reply_markup?.remove_keyboard).toBe(true)
  })

  it('inline_keyboard + reply_keyboard → error', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('reply', {
      chat_id: '12345',
      text: 'hi',
      inline_keyboard: [[{ text: 'a', url: 'https://x.com' }]],
      reply_keyboard: [['b']],
    }, deps)
    expect(result.content[0].text).toContain('only one')
  })

  it('inline_keyboard + remove_keyboard → error', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('reply', {
      chat_id: '12345',
      text: 'hi',
      inline_keyboard: [[{ text: 'a', url: 'https://x.com' }]],
      remove_keyboard: true,
    }, deps)
    expect(result.content[0].text).toContain('only one')
  })

  it('reply_keyboard + remove_keyboard → error', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('reply', {
      chat_id: '12345',
      text: 'hi',
      reply_keyboard: [['a']],
      remove_keyboard: true,
    }, deps)
    expect(result.content[0].text).toContain('only one')
  })

  it('one_time_keyboard without reply_keyboard → error', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('reply', {
      chat_id: '12345',
      text: 'hi',
      one_time_keyboard: true,
    }, deps)
    expect(result.content[0].text).toContain('one_time_keyboard')
  })

  it('files-only with keyboard → keyboard on last file', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tools-test-'))
    const f1 = join(tmpDir, 'a.jpg')
    const f2 = join(tmpDir, 'b.jpg')
    writeFileSync(f1, Buffer.alloc(100))
    writeFileSync(f2, Buffer.alloc(100))
    try {
      const { deps, calls } = makeDeps({ stateDir: join(tmpDir, 'state') })
      const kb = [[{ text: 'Click', url: 'https://example.com' }]]
      await handleToolCall('reply', {
        chat_id: '12345',
        files: [f1, f2],
        inline_keyboard: kb,
      }, deps)
      const sends = calls.filter(c => c.method === 'api.sendPhoto')
      expect(sends).toHaveLength(2)
      expect(sends[0].args[2]?.reply_markup).toBeUndefined()
      expect(sends[1].args[2]?.reply_markup?.inline_keyboard).toBeDefined()
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('InlineButton missing both callback_data and url → error', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('reply', {
      chat_id: '12345',
      text: 'hi',
      inline_keyboard: [[{ text: 'broken' }]],
    }, deps)
    expect(result.content[0].text).toContain('callback_data')
  })

  it('InlineButton with both callback_data and url → error', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('reply', {
      chat_id: '12345',
      text: 'hi',
      inline_keyboard: [[{ text: 'broken', callback_data: 'x', url: 'https://x.com' }]],
    }, deps)
    expect(result.content[0].text).toContain('callback_data')
  })
})

// ─── react ───────────────────────────────────────────────────────────────────

describe('react', () => {
  it('calls setMessageReaction with correct args', async () => {
    const { deps, calls } = makeDeps()
    await handleToolCall('react', { chat_id: '12345', message_id: '5', emoji: '👍' }, deps)
    const reactions = calls.filter(c => c.method === 'api.setMessageReaction')
    expect(reactions).toHaveLength(1)
    expect(reactions[0].args[0]).toBe('12345')
    expect(reactions[0].args[1]).toBe(5)
    expect(reactions[0].args[2]).toEqual([{ type: 'emoji', emoji: '👍' }])
  })

  it('rejects unknown chat', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('react', { chat_id: '99999', message_id: '5', emoji: '👍' }, deps)
    expect(result.content[0].text).toContain('not allowed')
  })

  it('returns error when API throws', async () => {
    const { deps } = makeDeps()
    ;(deps.bot as any).api.setMessageReaction = () => Promise.reject(new Error('Invalid emoji'))
    const result = await handleToolCall('react', { chat_id: '12345', message_id: '5', emoji: '💩' }, deps)
    expect(result.content[0].text).toContain('Invalid emoji')
  })
})

// ─── edit_message ────────────────────────────────────────────────────────────

describe('edit_message', () => {
  it('calls editMessageText with correct args', async () => {
    const { deps, calls } = makeDeps()
    await handleToolCall('edit_message', {
      chat_id: '12345',
      message_id: '10',
      text: 'updated',
    }, deps)
    const edits = calls.filter(c => c.method === 'api.editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0].args[0]).toBe('12345')
    expect(edits[0].args[1]).toBe(10)
    expect(edits[0].args[2]).toBe('updated')
  })

  it('rejects unknown chat', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('edit_message', {
      chat_id: '99999',
      message_id: '10',
      text: 'updated',
    }, deps)
    expect(result.content[0].text).toContain('not allowed')
  })

  it('supports parse_mode and inline_keyboard', async () => {
    const { deps, calls } = makeDeps()
    await handleToolCall('edit_message', {
      chat_id: '12345',
      message_id: '10',
      text: 'updated',
      parse_mode: 'HTML',
      inline_keyboard: [[{ text: 'Click', url: 'https://example.com' }]],
    }, deps)
    const edits = calls.filter(c => c.method === 'api.editMessageText')
    expect(edits[0].args[3]?.parse_mode).toBe('HTML')
    expect(edits[0].args[3]?.reply_markup?.inline_keyboard).toBeDefined()
  })
})

// ─── fetch_media ─────────────────────────────────────────────────────────────

describe('fetch_media', () => {
  it('downloads valid token and returns path', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tools-test-'))
    const stateDir = join(tmpDir, 'state')
    const inboxDir = join(stateDir, 'inbox')
    mkdirSync(inboxDir, { recursive: true })

    const { deps, calls } = makeDeps({ stateDir })
    // Mock getFile to return a file_path
    ;(deps.bot as any).api.getFile = (fileId: string) => {
      calls.push({ method: 'api.getFile', args: [fileId] })
      return Promise.resolve({ file_path: 'photos/file_1.jpg' })
    }
    // Mock global fetch for download
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any) => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(10),
    })) as any

    try {
      const result = await handleToolCall('fetch_media', {
        media_token: 'photo:abc123:unique456',
      }, deps)
      expect(result.content[0].text).toContain('inbox')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('errors on malformed token', async () => {
    const { deps } = makeDeps()
    const result = await handleToolCall('fetch_media', { media_token: 'bad' }, deps)
    expect(result.content[0].text).toContain('error')
  })
})

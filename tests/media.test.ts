import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { parseMediaToken, downloadMedia, transcribeAudio } from '../src/media.ts'

// ─── parseMediaToken ──────────────────────────────────────────────────────────

describe('parseMediaToken()', () => {
  it('parses a valid "photo:abc:def" token', () => {
    const token = parseMediaToken('photo:abc:def')
    expect(token).toEqual({ type: 'photo', fileId: 'abc', fileUniqueId: 'def' })
  })

  it('parses all 6 valid types', () => {
    const types = ['photo', 'document', 'video', 'audio', 'voice', 'sticker'] as const
    for (const type of types) {
      const token = parseMediaToken(`${type}:id1:uid1`)
      expect(token.type).toBe(type)
      expect(token.fileId).toBe('id1')
      expect(token.fileUniqueId).toBe('uid1')
    }
  })

  it('throws on malformed input with only 2 parts', () => {
    expect(() => parseMediaToken('photo:abc')).toThrow()
  })

  it('throws on unknown type "gif:abc:def"', () => {
    expect(() => parseMediaToken('gif:abc:def')).toThrow()
  })

  it('throws on empty string', () => {
    expect(() => parseMediaToken('')).toThrow()
  })
})

// ─── downloadMedia ────────────────────────────────────────────────────────────

describe('downloadMedia()', () => {
  let stateDir: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'))
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  function makeMockBot(filePath: string = 'photos/file.jpg') {
    return {
      token: 'test-bot-token',
      api: {
        getFile: async (_fileId: string) => ({ file_path: filePath }),
      },
    }
  }

  it('downloads successfully and returns an absolute file path', async () => {
    const bot = makeMockBot('photos/image.jpg')
    const token = parseMediaToken('photo:fileId123:uniqueId456')

    globalThis.fetch = async (_url: string) => {
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as any
    }

    const result = await downloadMedia(bot, token, stateDir)
    expect(path.isAbsolute(result)).toBe(true)
    expect(fs.existsSync(result)).toBe(true)
  })

  it('returned filename contains fileUniqueId', async () => {
    const bot = makeMockBot('photos/image.jpg')
    const token = parseMediaToken('photo:fileId123:myUniqueId789')

    globalThis.fetch = async (_url: string) => {
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as any
    }

    const result = await downloadMedia(bot, token, stateDir)
    expect(path.basename(result)).toContain('myUniqueId789')
  })

  it('uses extension from file_path (.jpg)', async () => {
    const bot = makeMockBot('photos/image.jpg')
    const token = parseMediaToken('photo:fileId123:uniqueId456')

    globalThis.fetch = async (_url: string) => {
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as any
    }

    const result = await downloadMedia(bot, token, stateDir)
    expect(result.endsWith('.jpg')).toBe(true)
  })

  it('retries on first fetch failure and succeeds on second attempt', async () => {
    const bot = makeMockBot('photos/image.jpg')
    const token = parseMediaToken('photo:fileId123:uniqueId456')

    let callCount = 0
    globalThis.fetch = async (_url: string) => {
      callCount++
      if (callCount === 1) {
        throw new Error('Network error')
      }
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as any
    }

    const result = await downloadMedia(bot, token, stateDir)
    expect(callCount).toBe(2)
    expect(fs.existsSync(result)).toBe(true)
  })

  it('ensures inbox directory is created', async () => {
    const bot = makeMockBot('photos/image.jpg')
    const token = parseMediaToken('photo:fileId123:uniqueId456')

    globalThis.fetch = async (_url: string) => {
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as any
    }

    const inboxDir = path.join(stateDir, 'inbox')
    expect(fs.existsSync(inboxDir)).toBe(false)

    await downloadMedia(bot, token, stateDir)

    expect(fs.existsSync(inboxDir)).toBe(true)
  })
})

// ─── transcribeAudio ──────────────────────────────────────────────────────────

describe('transcribeAudio()', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns transcribed text on success', async () => {
    globalThis.fetch = async (_url: string, _opts: any) => {
      return {
        ok: true,
        json: async () => ({ text: 'hello world' }),
      } as any
    }

    const buf = Buffer.from('fake audio data')
    const result = await transcribeAudio(buf, 'test-api-key')
    expect(result).toBe('hello world')
  })

  it('throws on non-200 response', async () => {
    globalThis.fetch = async (_url: string, _opts: any) => {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as any
    }

    const buf = Buffer.from('fake audio data')
    await expect(transcribeAudio(buf, 'bad-key')).rejects.toThrow()
  })
})

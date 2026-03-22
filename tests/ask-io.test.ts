import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readAskPending, writeAskPending, readAskReply, writeAskReply, deleteAskFiles } from '../src/ask-io.ts'
import type { AskPending, AskReply } from '../src/ask-io.ts'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ask-io-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('readAskPending', () => {
  it('returns null when file does not exist', () => {
    expect(readAskPending(tmpDir)).toBeNull()
  })

  it('returns parsed data when file exists', () => {
    const pending: AskPending = {
      nonce: 'abc12345',
      chatId: '100',
      sentMessageId: 42,
      options: [
        { label: 'Yes', description: 'Confirm' },
        { label: 'No', description: 'Cancel' },
      ],
      ts: Date.now(),
    }
    writeFileSync(join(tmpDir, 'ask-pending.json'), JSON.stringify(pending))
    expect(readAskPending(tmpDir)).toEqual(pending)
  })

  it('returns null when JSON is corrupt', () => {
    writeFileSync(join(tmpDir, 'ask-pending.json'), 'not json {{')
    expect(readAskPending(tmpDir)).toBeNull()
  })

  it('returns null and deletes file when expired', () => {
    const pending: AskPending = {
      nonce: 'expired1',
      chatId: '100',
      sentMessageId: 42,
      options: null,
      ts: Date.now() - 3_800_000,
    }
    writeFileSync(join(tmpDir, 'ask-pending.json'), JSON.stringify(pending))
    expect(readAskPending(tmpDir)).toBeNull()
    expect(existsSync(join(tmpDir, 'ask-pending.json'))).toBe(false)
  })
})

describe('writeAskPending', () => {
  it('writes ask-pending.json atomically', () => {
    const pending: AskPending = {
      nonce: 'deadbeef',
      chatId: '200',
      sentMessageId: 10,
      options: null,
      ts: Date.now(),
    }
    writeAskPending(tmpDir, pending)
    expect(existsSync(join(tmpDir, 'ask-pending.tmp.json'))).toBe(false)
    expect(readAskPending(tmpDir)).toEqual(pending)
  })
})

describe('readAskReply', () => {
  it('returns null when file does not exist', () => {
    expect(readAskReply(tmpDir)).toBeNull()
  })

  it('returns parsed data when file exists', () => {
    const reply: AskReply = {
      nonce: 'abc12345',
      answer: 'Yes',
      userId: '100',
      ts: Date.now(),
    }
    writeFileSync(join(tmpDir, 'ask-reply.json'), JSON.stringify(reply))
    expect(readAskReply(tmpDir)).toEqual(reply)
  })
})

describe('writeAskReply', () => {
  it('writes ask-reply.json atomically', () => {
    const reply: AskReply = {
      nonce: 'abc12345',
      answer: 'No',
      userId: '200',
      ts: Date.now(),
    }
    writeAskReply(tmpDir, reply)
    expect(existsSync(join(tmpDir, 'ask-reply.tmp.json'))).toBe(false)
    expect(readAskReply(tmpDir)).toEqual(reply)
  })
})

describe('deleteAskFiles', () => {
  it('removes both files', () => {
    writeFileSync(join(tmpDir, 'ask-pending.json'), '{}')
    writeFileSync(join(tmpDir, 'ask-reply.json'), '{}')
    deleteAskFiles(tmpDir)
    expect(existsSync(join(tmpDir, 'ask-pending.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'ask-reply.json'))).toBe(false)
  })

  it('does not throw when files are missing', () => {
    expect(() => deleteAskFiles(tmpDir)).not.toThrow()
  })
})

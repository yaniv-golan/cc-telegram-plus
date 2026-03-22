import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createPermissionRelay, type PermissionRelay } from '../src/permission-relay.ts'
import { createMockBot, createMockMcp, createAccess, type MockCall } from './helpers.ts'
import type { SessionManager, Access } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function createMockSessions(active = true): SessionManager {
  return {
    register() { return 'test-session' },
    isActive() { return active },
    watch() {},
    stop() {},
    activate() {},
    async switchTo() { return true },
    getAll() { return {} },
    getDeepLink() { return '' },
    addAckedMessage() {},
    clearAckedMessages() { return [] },
    getLastInbound() { return undefined },
    setLastInbound() {},
    renameSession() {},
  }
}

describe('permission-relay', () => {
  let tmpDir: string
  let botCalls: MockCall[]
  let bot: any
  let mcpNotifications: any[]
  let mcpServer: any

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'perm-relay-test-'))
    const mockBot = createMockBot()
    bot = mockBot.bot
    botCalls = mockBot.calls
    const mockMcp = createMockMcp()
    mcpServer = mockMcp.mcp
    mcpNotifications = mockMcp.notifications
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeRelay(opts: { active?: boolean; allowFrom?: string[] } = {}): PermissionRelay {
    const { active = true, allowFrom = ['111', '222'] } = opts
    const relay = createPermissionRelay({
      bot,
      mcp: mcpServer,
      sessions: createMockSessions(active),
      loadAccess: () => createAccess({ allowFrom }),
      stateDir: tmpDir,
      sessionId: 'test-session',
    })
    return relay
  }

  const sampleParams = {
    request_id: 'req-abc-123',
    tool_name: 'Bash',
    description: 'Run command',
    input_preview: 'npm test',
  }

  describe('handleRequest', () => {
    it('is a no-op when session is inactive', async () => {
      const relay = makeRelay({ active: false })
      relay.handleRequest(sampleParams)
      // Give async sends time to fire (they shouldn't)
      await new Promise(r => setTimeout(r, 50))
      expect(botCalls.filter(c => c.method === 'api.sendMessage')).toHaveLength(0)
    })

    it('sends buttons to all allowFrom users', async () => {
      const relay = makeRelay({ allowFrom: ['111', '222'] })
      relay.handleRequest(sampleParams)
      await new Promise(r => setTimeout(r, 50))

      const sends = botCalls.filter(c => c.method === 'api.sendMessage')
      expect(sends).toHaveLength(2)
      expect(sends[0].args[0]).toBe('111')
      expect(sends[1].args[0]).toBe('222')

      // Verify inline keyboard
      const markup = sends[0].args[2]?.reply_markup
      expect(markup?.inline_keyboard).toBeDefined()
      expect(markup.inline_keyboard[0]).toHaveLength(2)
      expect(markup.inline_keyboard[0][0].text).toContain('Allow')
      expect(markup.inline_keyboard[0][1].text).toContain('Deny')

      // Verify HTML parse mode
      expect(sends[0].args[2]?.parse_mode).toBe('HTML')

      relay.cleanup()
    })

    it('HTML-escapes tool fields', async () => {
      const relay = makeRelay({ allowFrom: ['111'] })
      relay.handleRequest({
        request_id: 'req-xss',
        tool_name: '<script>alert(1)</script>',
        description: 'a & b < c',
        input_preview: '<img src=x>',
      })
      await new Promise(r => setTimeout(r, 50))

      const sends = botCalls.filter(c => c.method === 'api.sendMessage')
      expect(sends).toHaveLength(1)
      const text: string = sends[0].args[1]
      expect(text).toContain('&lt;script&gt;')
      expect(text).toContain('a &amp; b &lt; c')
      expect(text).toContain('&lt;img src=x&gt;')
      expect(text).not.toContain('<script>')

      relay.cleanup()
    })

    it('does nothing when allowFrom is empty', async () => {
      const relay = makeRelay({ allowFrom: [] })
      relay.handleRequest(sampleParams)
      await new Promise(r => setTimeout(r, 50))
      expect(botCalls.filter(c => c.method === 'api.sendMessage')).toHaveLength(0)
    })
  })

  describe('resolveByKey', () => {
    it('returns true and sends notification for valid key', async () => {
      const relay = makeRelay({ allowFrom: ['111'] })
      relay.handleRequest(sampleParams)
      await new Promise(r => setTimeout(r, 50))

      // Extract key from callback_data
      const sends = botCalls.filter(c => c.method === 'api.sendMessage')
      const keyboard = sends[0].args[2]?.reply_markup?.inline_keyboard
      const allowData: string = keyboard[0][0].callback_data
      const key = allowData.split(':')[2]

      const result = await relay.resolveByKey(key, 'allow')
      expect(result).toBe('resolved')

      // Verify MCP notification sent back to CC
      expect(mcpNotifications).toHaveLength(1)
      expect(mcpNotifications[0]).toEqual({
        method: 'notifications/claude/channel/permission',
        params: { request_id: 'req-abc-123', behavior: 'allow' },
      })

      // Verify message edited
      const edits = botCalls.filter(c => c.method === 'api.editMessageText')
      expect(edits.length).toBeGreaterThan(0)
      expect(edits[0].args[2]).toContain('Allowed')
    })

    it('returns false for unknown key', async () => {
      const relay = makeRelay()
      const result = await relay.resolveByKey('nonexistent', 'allow')
      expect(result).toBe('not_found')
      expect(mcpNotifications).toHaveLength(0)
    })

    it('returns false on second call (already resolved)', async () => {
      const relay = makeRelay({ allowFrom: ['111'] })
      relay.handleRequest(sampleParams)
      await new Promise(r => setTimeout(r, 50))

      const sends = botCalls.filter(c => c.method === 'api.sendMessage')
      const keyboard = sends[0].args[2]?.reply_markup?.inline_keyboard
      const key = keyboard[0][0].callback_data.split(':')[2]

      expect(await relay.resolveByKey(key, 'allow')).toBe('resolved')
      expect(await relay.resolveByKey(key, 'deny')).toBe('not_found')

      // Only one MCP notification
      expect(mcpNotifications).toHaveLength(1)
    })

    it('sends deny notification correctly', async () => {
      const relay = makeRelay({ allowFrom: ['111'] })
      relay.handleRequest(sampleParams)
      await new Promise(r => setTimeout(r, 50))

      const sends = botCalls.filter(c => c.method === 'api.sendMessage')
      const keyboard = sends[0].args[2]?.reply_markup?.inline_keyboard
      const key = keyboard[0][1].callback_data.split(':')[2]

      const result = await relay.resolveByKey(key, 'deny')
      expect(result).toBe('resolved')

      expect(mcpNotifications[0].params.behavior).toBe('deny')

      const edits = botCalls.filter(c => c.method === 'api.editMessageText')
      expect(edits[0].args[2]).toContain('Denied')
    })
  })

  describe('cleanup', () => {
    it('edits pending messages to session ended', async () => {
      const relay = makeRelay({ allowFrom: ['111'] })
      relay.handleRequest(sampleParams)
      await new Promise(r => setTimeout(r, 50))

      relay.cleanup()

      const edits = botCalls.filter(c => c.method === 'api.editMessageText')
      expect(edits.length).toBeGreaterThan(0)
      expect(edits[0].args[2]).toContain('Session ended')
    })

    it('makes resolveByKey return false after cleanup', async () => {
      const relay = makeRelay({ allowFrom: ['111'] })
      relay.handleRequest(sampleParams)
      await new Promise(r => setTimeout(r, 50))

      const sends = botCalls.filter(c => c.method === 'api.sendMessage')
      const keyboard = sends[0].args[2]?.reply_markup?.inline_keyboard
      const key = keyboard[0][0].callback_data.split(':')[2]

      relay.cleanup()

      expect(await relay.resolveByKey(key, 'allow')).toBe('not_found')
      expect(mcpNotifications).toHaveLength(0)
    })
  })
})

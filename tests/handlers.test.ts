import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { registerHandlers } from '../src/handlers.ts'
import {
  createMockBot,
  createMockMcp,
  createMockDeps,
  createAccess,
  createTextCtx,
  createMediaCtx,
  createReactionCtx,
  createCallbackCtx,
} from './helpers.ts'
import type { Deps } from '../src/types.ts'
import { writeAskPending, readAskReply } from '../src/ask-io.ts'
import type { AskPending } from '../src/ask-io.ts'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Helper to trigger a registered handler by event name
async function triggerHandler(bot: any, event: string, ctx: any) {
  const handlers = bot._handlers[event]
  if (!handlers || handlers.length === 0) {
    throw new Error(`No handler registered for event: ${event}`)
  }
  for (const handler of handlers) {
    await handler(ctx)
  }
}

// ─── text handler ────────────────────────────────────────────────────────────

describe('text handler', () => {
  let deps: Deps
  let notifications: any[]
  let botCalls: any[]

  beforeEach(() => {
    const { bot, calls } = createMockBot()
    const { mcp, notifications: notifs } = createMockMcp()
    notifications = notifs
    botCalls = calls
    deps = createMockDeps({ bot, mcp })
    registerHandlers(deps)
  })

  it('allowed user emits notification with correct content + meta', async () => {
    const ctx = createTextCtx('hello world', { userId: 12345, chatId: 100 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].method).toBe('notifications/claude/channel')
    expect(notifications[0].params.content).toBe('hello world')
    expect(notifications[0].params.meta.chat_id).toBe('100')
    expect(notifications[0].params.meta.user_id).toBe('12345')
    expect(notifications[0].params.meta.user).toBe('testuser')
    expect(notifications[0].params.meta.message_id).toBe('1')
  })

  it('unknown user on allowlist policy emits no notification', async () => {
    const ctx = createTextCtx('hello', { userId: 99999 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(notifications).toHaveLength(0)
  })

  it('sends typing indicator', async () => {
    const ctx = createTextCtx('hi', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    const typingCall = botCalls.find(c => c.method === 'api.sendChatAction')
    expect(typingCall).toBeDefined()
    expect(typingCall.args[1]).toBe('typing')
  })

  it('extracts reply context and prepends it', async () => {
    const ctx = createTextCtx('my reply', {
      userId: 12345,
      replyTo: { text: 'original message', messageId: 5 },
    })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe(
      '[Replying to: "original message"]\nmy reply',
    )
  })

  it('truncates reply context to 200 chars', async () => {
    const longText = 'a'.repeat(300)
    const ctx = createTextCtx('reply', {
      userId: 12345,
      replyTo: { text: longText, messageId: 5 },
    })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(notifications).toHaveLength(1)
    const content = notifications[0].params.content
    expect(content).toContain('[Replying to: "')
    expect(content).toContain('..."]')
    // 200 a's + "..." = truncated
    const match = content.match(/\[Replying to: "(.+?)"\]/)
    expect(match[1].replace('...', '').length).toBe(200)
  })
})

// ─── media handlers ──────────────────────────────────────────────────────────

describe('media handlers', () => {
  let deps: Deps
  let notifications: any[]

  beforeEach(() => {
    const { bot, calls } = createMockBot()
    const { mcp, notifications: notifs } = createMockMcp()
    notifications = notifs
    deps = createMockDeps({ bot, mcp })
    registerHandlers(deps)
  })

  it('photo emits correct content + media_token', async () => {
    const ctx = createMediaCtx('photo', {
      userId: 12345,
      fileId: 'photo_file_id',
      fileUniqueId: 'photo_unique',
    })
    await triggerHandler(deps.bot, 'message:photo', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('(photo)')
    expect(notifications[0].params.meta.media_token).toBe('photo:photo_file_id:photo_unique')
  })

  it('document emits filename in content + token', async () => {
    const ctx = createMediaCtx('document', {
      userId: 12345,
      fileName: 'report.pdf',
      fileId: 'doc_file_id',
      fileUniqueId: 'doc_unique',
    })
    await triggerHandler(deps.bot, 'message:document', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('report.pdf')
    expect(notifications[0].params.meta.media_token).toBe('document:doc_file_id:doc_unique')
  })

  it('video emits (video) + token', async () => {
    const ctx = createMediaCtx('video', {
      userId: 12345,
      fileId: 'vid_file_id',
      fileUniqueId: 'vid_unique',
    })
    await triggerHandler(deps.bot, 'message:video', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('(video)')
    expect(notifications[0].params.meta.media_token).toBe('video:vid_file_id:vid_unique')
  })

  it('audio emits title in content + token', async () => {
    const ctx = createMediaCtx('audio', {
      userId: 12345,
      fileId: 'audio_file_id',
      fileUniqueId: 'audio_unique',
    })
    // Add title to audio
    ctx.message.audio.title = 'My Song'
    await triggerHandler(deps.bot, 'message:audio', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('My Song')
    expect(notifications[0].params.meta.media_token).toBe('audio:audio_file_id:audio_unique')
  })

  it('sticker emits (sticker: emoji) + token', async () => {
    const ctx = createMediaCtx('sticker', {
      userId: 12345,
      fileId: 'sticker_file_id',
      fileUniqueId: 'sticker_unique',
    })
    ctx.message.sticker.emoji = '\u{1F600}'
    await triggerHandler(deps.bot, 'message:sticker', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('(sticker: \u{1F600})')
    expect(notifications[0].params.meta.media_token).toBe('sticker:sticker_file_id:sticker_unique')
  })
})

// ─── voice handler ───────────────────────────────────────────────────────────

describe('voice handler', () => {
  let deps: Deps
  let notifications: any[]

  beforeEach(() => {
    const { bot, calls } = createMockBot()
    const { mcp, notifications: notifs } = createMockMcp()
    notifications = notifs
    // Make getFile return a file_path
    bot.api.getFile = () => Promise.resolve({ file_path: 'voice/file.ogg' })
    deps = createMockDeps({ bot, mcp })
  })

  it('with transcribe emits [Voice: "text"] + token', async () => {
    const transcribe = async (_buf: Buffer) => 'hello from voice'
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      transcribe,
    })
    // Mock fetch globally for voice download
    const origFetch = globalThis.fetch
    globalThis.fetch = () =>
      Promise.resolve(new Response(new ArrayBuffer(100))) as any
    registerHandlers(deps)

    const ctx = createMediaCtx('voice', {
      userId: 12345,
      fileId: 'voice_file_id',
      fileUniqueId: 'voice_unique',
    })
    await triggerHandler(deps.bot, 'message:voice', ctx)

    globalThis.fetch = origFetch

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('[Voice: "hello from voice"]')
    expect(notifications[0].params.meta.media_token).toBe('voice:voice_file_id:voice_unique')
  })

  it('transcription fails emits (voice message) + token', async () => {
    const transcribe = async (_buf: Buffer) => {
      throw new Error('transcription failed')
    }
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      transcribe,
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = () =>
      Promise.resolve(new Response(new ArrayBuffer(100))) as any
    registerHandlers(deps)

    const ctx = createMediaCtx('voice', {
      userId: 12345,
      fileId: 'voice_file_id',
      fileUniqueId: 'voice_unique',
    })
    await triggerHandler(deps.bot, 'message:voice', ctx)

    globalThis.fetch = origFetch

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('(voice message)')
    expect(notifications[0].params.meta.media_token).toBe('voice:voice_file_id:voice_unique')
  })

  it('without transcribe emits (voice message) + token', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      transcribe: undefined,
    })
    registerHandlers(deps)

    const ctx = createMediaCtx('voice', {
      userId: 12345,
      fileId: 'voice_file_id',
      fileUniqueId: 'voice_unique',
    })
    await triggerHandler(deps.bot, 'message:voice', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('(voice message)')
    expect(notifications[0].params.meta.media_token).toBe('voice:voice_file_id:voice_unique')
  })
})

// ─── reaction handler ────────────────────────────────────────────────────────

describe('reaction handler', () => {
  let deps: Deps
  let notifications: any[]

  beforeEach(() => {
    const { bot, calls } = createMockBot()
    const { mcp, notifications: notifs } = createMockMcp()
    notifications = notifs
    deps = createMockDeps({ bot, mcp })
  })

  it('added reaction emits notification with cached message', async () => {
    const cacheGet = (_chatId: string, _msgId: string) => 'cached message text'
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      cache: { ...deps.cache, get: cacheGet },
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
    })
    registerHandlers(deps)

    const ctx = createReactionCtx('\u{1F44D}', {
      userId: 12345,
      chatId: 100,
      messageId: 42,
    })
    // For reaction handler, the gate needs a private chat context
    // The reaction ctx has chat info inside messageReaction
    await triggerHandler(deps.bot, 'message_reaction', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('[Reacted \u{1F44D} to: "cached message text"]')
  })

  it('removed reaction (empty new) is ignored', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
    })
    registerHandlers(deps)

    const ctx = createReactionCtx('\u{1F44D}', {
      userId: 12345,
      chatId: 100,
    })
    // Make new_reaction contain same as old_reaction (no added)
    ctx.messageReaction.old_reaction = [{ type: 'emoji', emoji: '\u{1F44D}' }]
    await triggerHandler(deps.bot, 'message_reaction', ctx)

    expect(notifications).toHaveLength(0)
  })

  it('message not in cache emits message #id', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
    })
    registerHandlers(deps)

    const ctx = createReactionCtx('\u{1F44D}', {
      userId: 12345,
      chatId: 100,
      messageId: 77,
    })
    await triggerHandler(deps.bot, 'message_reaction', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('[Reacted \u{1F44D} to message #77]')
  })
})

// ─── callback handler ────────────────────────────────────────────────────────

describe('callback handler', () => {
  let deps: Deps
  let notifications: any[]

  beforeEach(() => {
    const { bot, calls } = createMockBot()
    const { mcp, notifications: notifs } = createMockMcp()
    notifications = notifs
    deps = createMockDeps({ bot, mcp })
  })

  it('regular callback emits [Button pressed: data] and answers', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
    })
    registerHandlers(deps)

    const ctx = createCallbackCtx('some_action', { userId: 12345 })
    await triggerHandler(deps.bot, 'callback_query:data', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('[Button pressed: some_action]')
    expect(ctx._answerCalls.length).toBeGreaterThan(0)
  })

  it('switch callback from authorized user calls switchTo', async () => {
    const switchToCalls: string[] = []
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
      sessions: {
        ...deps.sessions,
        switchTo: (id: string) => { switchToCalls.push(id) },
      },
    })
    registerHandlers(deps)

    const ctx = createCallbackCtx('switch_abc123', { userId: 12345 })
    await triggerHandler(deps.bot, 'callback_query:data', ctx)

    expect(switchToCalls).toEqual(['abc123'])
    expect(notifications).toHaveLength(0)
  })

  it('switch callback from unauthorized user answers "Not authorized"', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['99999'] }),
    })
    registerHandlers(deps)

    const ctx = createCallbackCtx('switch_abc123', { userId: 12345 })
    await triggerHandler(deps.bot, 'callback_query:data', ctx)

    expect(ctx._answerCalls).toHaveLength(1)
    expect(ctx._answerCalls[0][0]).toEqual({ text: 'Not authorized' })
    expect(notifications).toHaveLength(0)
  })
})

// ─── ack reaction ────────────────────────────────────────────────────────────

describe('ack reaction', () => {
  it('ack applied after notification success', async () => {
    const { bot, calls } = createMockBot()
    const { mcp, notifications } = createMockMcp()
    const addAckedCalls: any[] = []

    const deps = createMockDeps({
      bot,
      mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'], ackReaction: '\u{2705}' }),
      sessions: {
        ...createMockDeps().sessions,
        addAckedMessage: (chatId: string, msgId: number) => {
          addAckedCalls.push({ chatId, msgId })
        },
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('hello', { userId: 12345, messageId: 10 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(notifications).toHaveLength(1)
    const reactionCall = calls.find(c => c.method === 'api.setMessageReaction')
    expect(reactionCall).toBeDefined()
    expect(addAckedCalls).toHaveLength(1)
    expect(addAckedCalls[0]).toEqual({ chatId: '100', msgId: 10 })
  })

  it('ack NOT applied if notification throws', async () => {
    const { bot, calls } = createMockBot()
    const addAckedCalls: any[] = []

    // MCP that throws on notification
    const mcp: any = {
      notification: () => { throw new Error('mcp down') },
    }

    const deps = createMockDeps({
      bot,
      mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'], ackReaction: '\u{2705}' }),
      sessions: {
        ...createMockDeps().sessions,
        addAckedMessage: (chatId: string, msgId: number) => {
          addAckedCalls.push({ chatId, msgId })
        },
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('hello', { userId: 12345 })
    // The handler should catch or propagate the error
    try {
      await triggerHandler(deps.bot, 'message:text', ctx)
    } catch {
      // expected
    }

    const reactionCall = calls.find(c => c.method === 'api.setMessageReaction')
    expect(reactionCall).toBeUndefined()
    expect(addAckedCalls).toHaveLength(0)
  })
})

// ─── bot commands ────────────────────────────────────────────────────────────

describe('bot commands', () => {
  let deps: Deps
  let botCalls: any[]

  beforeEach(() => {
    const { bot, calls } = createMockBot()
    const { mcp } = createMockMcp()
    botCalls = calls
    deps = createMockDeps({ bot, mcp })
  })

  it('/chatid replies with chat ID', async () => {
    registerHandlers(deps)
    const ctx = createTextCtx('/chatid', { userId: 12345, chatId: 555 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    const sendCall = botCalls.find(c => c.method === 'api.sendMessage')
    expect(sendCall).toBeDefined()
    expect(sendCall.args[0]).toBe('555')
    expect(sendCall.args[1]).toContain('555')
  })

  it('/sessions from authorized shows session list', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
      sessions: {
        ...deps.sessions,
        getAll: () => ({
          'sess1': { pid: 1, instanceId: '1-1', label: 'main', startedAt: '2026-01-01', active: true },
          'sess2': { pid: 2, instanceId: '2-1', label: 'other', startedAt: '2026-01-02', active: false },
        }),
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/sessions', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    const sendCall = botCalls.find(c => c.method === 'api.sendMessage')
    expect(sendCall).toBeDefined()
    expect(sendCall.args[1]).toContain('main')
    expect(sendCall.args[1]).toContain('\u{1F7E2}') // 🟢 for active
    // Inactive sessions appear as switch buttons, not in text
    expect(sendCall.args[2]).toBeDefined() // reply_markup with buttons
  })

  it('/sessions from unauthorized in group has no response', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['99999'] }),
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/sessions', { userId: 12345 })
    ctx.chat.type = 'supergroup'
    await triggerHandler(deps.bot, 'message:text', ctx)

    // No sendMessage for sessions (gate drops it, and command returns true without sending)
    const sendCall = botCalls.find(c => c.method === 'api.sendMessage')
    expect(sendCall).toBeUndefined()
  })

  it('/status from authorized shows active session', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
      sessions: {
        ...deps.sessions,
        getAll: () => ({
          'sess1': { pid: 1, instanceId: '1-1', label: 'main', startedAt: '2026-01-01', active: true },
        }),
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/status', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    const sendCall = botCalls.find(c => c.method === 'api.sendMessage')
    expect(sendCall).toBeDefined()
    expect(sendCall.args[1]).toContain('main')
  })

  it('/status from unauthorized has no response', async () => {
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['99999'] }),
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/status', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    const sendCall = botCalls.find(c => c.method === 'api.sendMessage')
    expect(sendCall).toBeUndefined()
  })

  it('/switch from authorized in DM calls switchTo', async () => {
    const switchToCalls: string[] = []
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
      sessions: {
        ...deps.sessions,
        switchTo: (id: string) => { switchToCalls.push(id) },
        getAll: () => ({ target123: { pid: 1, instanceId: '1-0', label: 'test', startedAt: new Date().toISOString(), active: false } }),
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/switch target123', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(switchToCalls).toEqual(['target123'])
  })

  it('/switch from unauthorized has no response', async () => {
    const switchToCalls: string[] = []
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['99999'] }),
      sessions: {
        ...deps.sessions,
        switchTo: (id: string) => { switchToCalls.push(id) },
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/switch target123', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(switchToCalls).toHaveLength(0)
  })

  it('/switch in group has no response (DM only)', async () => {
    const switchToCalls: string[] = []
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
      sessions: {
        ...deps.sessions,
        switchTo: (id: string) => { switchToCalls.push(id) },
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/switch target123', { userId: 12345 })
    ctx.chat.type = 'supergroup'
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(switchToCalls).toHaveLength(0)
  })

  it('deep link /start switch_<id> from authorized calls switchTo', async () => {
    const switchToCalls: string[] = []
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['12345'] }),
      sessions: {
        ...deps.sessions,
        switchTo: (id: string) => { switchToCalls.push(id) },
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/start switch_abc456', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(switchToCalls).toEqual(['abc456'])
  })

  it('deep link /start switch_<id> from unauthorized has no response', async () => {
    const switchToCalls: string[] = []
    deps = createMockDeps({
      bot: deps.bot,
      mcp: deps.mcp,
      loadAccess: () => createAccess({ allowFrom: ['99999'] }),
      sessions: {
        ...deps.sessions,
        switchTo: (id: string) => { switchToCalls.push(id) },
      },
    })
    registerHandlers(deps)

    const ctx = createTextCtx('/start switch_abc456', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(switchToCalls).toHaveLength(0)
  })
})

// ─── cache + setLastInbound + ts format ─────────────────────────────────────

describe('inbound message cache and setLastInbound', () => {
  let deps: Deps
  let notifications: any[]
  let cacheSetCalls: any[]
  let setLastInboundCalls: any[]

  beforeEach(() => {
    const { bot } = createMockBot()
    const { mcp, notifications: notifs } = createMockMcp()
    notifications = notifs
    cacheSetCalls = []
    setLastInboundCalls = []
    deps = createMockDeps({
      bot,
      mcp,
      cache: {
        get: () => undefined,
        set: (chatId: string, messageId: string, content: string) => {
          cacheSetCalls.push({ chatId, messageId, content })
        },
        flush: () => {},
        destroy: () => {},
      },
      sessions: {
        ...createMockDeps().sessions,
        setLastInbound: (chatId: string, messageId: string) => {
          setLastInboundCalls.push({ chatId, messageId })
        },
      },
    })
    registerHandlers(deps)
  })

  it('inbound message stored in cache after text deliver', async () => {
    const ctx = createTextCtx('hello world', { userId: 12345, chatId: 200, messageId: 7 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(cacheSetCalls).toHaveLength(1)
    expect(cacheSetCalls[0]).toEqual({ chatId: '200', messageId: '7', content: 'hello world' })
  })

  it('setLastInbound called on deliver', async () => {
    const ctx = createTextCtx('hi', { userId: 12345, chatId: 200, messageId: 7 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(setLastInboundCalls).toHaveLength(1)
    expect(setLastInboundCalls[0]).toEqual({ chatId: '200', messageId: '7' })
  })

  it('ts meta field is ISO 8601', async () => {
    const ctx = createTextCtx('test', { userId: 12345 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    expect(notifications).toHaveLength(1)
    const ts = notifications[0].params.meta.ts
    expect(ts).toContain('T')
    expect(ts).toContain('Z')
  })
})

// ─── sticker with reply context ─────────────────────────────────────────────

describe('sticker with reply context', () => {
  it('sticker with reply context includes reply prefix', async () => {
    const { bot } = createMockBot()
    const { mcp, notifications } = createMockMcp()
    const deps = createMockDeps({ bot, mcp })
    registerHandlers(deps)

    const ctx = createMediaCtx('sticker', {
      userId: 12345,
      fileId: 'sticker_file_id',
      fileUniqueId: 'sticker_unique',
    })
    ctx.message.sticker.emoji = '\u{1F600}'
    ctx.message.reply_to_message = {
      message_id: 5,
      text: 'original message',
    }
    await triggerHandler(deps.bot, 'message:sticker', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe(
      '[Replying to: "original message"]\n(sticker: \u{1F600})',
    )
  })
})

describe('ask redirect — callback_query', () => {
  let deps: Deps
  let notifications: any[]
  let botCalls: any[]
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'handler-ask-test-'))
    const { bot, calls } = createMockBot()
    const { mcp, notifications: notifs } = createMockMcp()
    notifications = notifs
    botCalls = calls
    deps = createMockDeps({ bot, mcp, stateDir: tmpDir })
    registerHandlers(deps)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('routes ask_answer callback to reply file when pending exists', async () => {
    const pending: AskPending = {
      nonce: 'test1234',
      chatId: '100',
      sentMessageId: 50,
      options: [
        { label: 'Staging', description: 'Deploy to staging' },
        { label: 'Production', description: 'Deploy to prod' },
      ],
      ts: Date.now(),
    }
    writeAskPending(tmpDir, pending)

    const ctx = createCallbackCtx('ask_answer_0', { userId: 12345, chatId: 100, messageId: 50 })
    await triggerHandler(deps.bot, 'callback_query:data', ctx)

    const reply = readAskReply(tmpDir)
    expect(reply).not.toBeNull()
    expect(reply!.nonce).toBe('test1234')
    expect(reply!.answer).toBe('Staging')
    expect(ctx._answerCalls).toHaveLength(1)
    expect(notifications).toHaveLength(0)

    const deleteCall = botCalls.find(c => c.method === 'api.deleteMessage')
    expect(deleteCall).toBeDefined()
    expect(deleteCall.args[0]).toBe('100')
    expect(deleteCall.args[1]).toBe(50)
  })

  it('rejects unauthorized user on ask_answer callback', async () => {
    const pending: AskPending = {
      nonce: 'test5678',
      chatId: '100',
      sentMessageId: 50,
      options: [{ label: 'Yes', description: 'Confirm' }],
      ts: Date.now(),
    }
    writeAskPending(tmpDir, pending)

    const ctx = createCallbackCtx('ask_answer_0', { userId: 99999, chatId: 100, messageId: 50 })
    await triggerHandler(deps.bot, 'callback_query:data', ctx)

    const reply = readAskReply(tmpDir)
    expect(reply).toBeNull()
    expect(ctx._answerCalls[0][0]).toEqual({ text: 'Not authorized' })
  })

  it('rejects callback from wrong message (stale button)', async () => {
    const pending: AskPending = {
      nonce: 'test9999',
      chatId: '100',
      sentMessageId: 50,
      options: [{ label: 'Yes', description: 'Confirm' }],
      ts: Date.now(),
    }
    writeAskPending(tmpDir, pending)

    const ctx = createCallbackCtx('ask_answer_0', { userId: 12345, chatId: 100, messageId: 99 })
    await triggerHandler(deps.bot, 'callback_query:data', ctx)

    const reply = readAskReply(tmpDir)
    expect(reply).toBeNull()
    expect(ctx._answerCalls[0][0]).toEqual({ text: 'Expired prompt' })
  })

  it('falls through to normal callback when no pending', async () => {
    const ctx = createCallbackCtx('ask_answer_0', { userId: 12345, chatId: 100 })
    await triggerHandler(deps.bot, 'callback_query:data', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].params.content).toBe('[Button pressed: ask_answer_0]')
  })
})

describe('ask redirect — text handler', () => {
  let deps: Deps
  let notifications: any[]
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'handler-ask-text-'))
    const { bot, calls } = createMockBot()
    const { mcp, notifications: notifs } = createMockMcp()
    notifications = notifs
    deps = createMockDeps({ bot, mcp, stateDir: tmpDir })
    registerHandlers(deps)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('routes text to reply file when pending exists for matching chat', async () => {
    const pending: AskPending = {
      nonce: 'texttest1',
      chatId: '100',
      sentMessageId: 50,
      options: null,
      ts: Date.now(),
    }
    writeAskPending(tmpDir, pending)

    const ctx = createTextCtx('my free text answer', { userId: 12345, chatId: 100 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    const reply = readAskReply(tmpDir)
    expect(reply).not.toBeNull()
    expect(reply!.nonce).toBe('texttest1')
    expect(reply!.answer).toBe('my free text answer')
    expect(notifications).toHaveLength(0)
  })

  it('falls through when pending exists but for different chat', async () => {
    const pending: AskPending = {
      nonce: 'texttest2',
      chatId: '999',
      sentMessageId: 50,
      options: null,
      ts: Date.now(),
    }
    writeAskPending(tmpDir, pending)

    const ctx = createTextCtx('hello', { userId: 12345, chatId: 100 })
    await triggerHandler(deps.bot, 'message:text', ctx)

    const reply = readAskReply(tmpDir)
    expect(reply).toBeNull()
    expect(notifications).toHaveLength(1)
  })
})

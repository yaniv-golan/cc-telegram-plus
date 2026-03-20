import type { Access, Deps, SessionManager, MessageCache } from '../src/types.ts'

// ─── Access factory ───────────────────────────────────────────────────────────

export function createAccess(overrides: Partial<Access> = {}): Access {
  const defaults: Access = {
    dmPolicy: 'allowlist',
    allowFrom: ['12345'],
    groups: {},
    pending: {},
  }
  return {
    ...defaults,
    ...overrides,
    allowFrom: overrides.allowFrom ?? defaults.allowFrom,
    groups: { ...defaults.groups, ...(overrides.groups ?? {}) },
    pending: { ...defaults.pending, ...(overrides.pending ?? {}) },
  }
}

// ─── Mock Bot factory ─────────────────────────────────────────────────────────

export type MockCall = { method: string; args: any[] }

export function createMockBot() {
  const calls: MockCall[] = []
  const eventHandlers: Record<string, ((...args: any[]) => any)[]> = {}

  function stub(method: string) {
    return (...args: any[]) => {
      calls.push({ method, args })
      return Promise.resolve({})
    }
  }

  const bot: any = {
    api: {
      sendMessage: stub('api.sendMessage'),
      setMessageReaction: stub('api.setMessageReaction'),
      editMessageText: stub('api.editMessageText'),
      getFile: stub('api.getFile'),
      getMe: stub('api.getMe'),
      setMyCommands: stub('api.setMyCommands'),
      setMyDescription: stub('api.setMyDescription'),
      setMyShortDescription: stub('api.setMyShortDescription'),
      sendPhoto: stub('api.sendPhoto'),
      sendDocument: stub('api.sendDocument'),
    },
    on(event: string, handler: (...args: any[]) => any) {
      if (!eventHandlers[event]) eventHandlers[event] = []
      eventHandlers[event].push(handler)
    },
    start() {
      return Promise.resolve()
    },
    stop() {
      return Promise.resolve()
    },
    _handlers: eventHandlers,
  }

  return { bot, calls }
}

// ─── Text context factory ─────────────────────────────────────────────────────

export interface TextCtxOpts {
  chatId?: number
  userId?: number
  username?: string
  messageId?: number
  replyTo?: { text?: string; messageId?: number }
}

export function createTextCtx(text: string, opts: TextCtxOpts = {}) {
  const {
    chatId = 100,
    userId = 12345,
    username = 'testuser',
    messageId = 1,
    replyTo,
  } = opts

  const ctx: any = {
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      text,
      reply_to_message: replyTo
        ? {
            message_id: replyTo.messageId ?? 0,
            text: replyTo.text ?? '',
          }
        : undefined,
    },
    from: {
      id: userId,
      username,
      first_name: username,
      is_bot: false,
    },
    chat: {
      id: chatId,
      type: 'private',
    },
  }

  return ctx
}

// ─── Media context factory ────────────────────────────────────────────────────

export type MediaType = 'photo' | 'document' | 'video' | 'audio' | 'voice' | 'sticker'

export interface MediaCtxOpts extends TextCtxOpts {
  caption?: string
  fileName?: string
  fileId?: string
  fileUniqueId?: string
}

export function createMediaCtx(type: MediaType, opts: MediaCtxOpts = {}) {
  const {
    chatId = 100,
    userId = 12345,
    username = 'testuser',
    messageId = 1,
    caption,
    fileName = 'file.bin',
    fileId = 'file_id_mock',
    fileUniqueId = 'file_unique_id_mock',
  } = opts

  const mediaField: Record<string, any> = {}

  switch (type) {
    case 'photo':
      mediaField.photo = [
        { file_id: fileId, file_unique_id: fileUniqueId, width: 100, height: 100 },
      ]
      break
    case 'document':
      mediaField.document = {
        file_id: fileId,
        file_unique_id: fileUniqueId,
        file_name: fileName,
      }
      break
    case 'video':
      mediaField.video = {
        file_id: fileId,
        file_unique_id: fileUniqueId,
        width: 640,
        height: 480,
        duration: 10,
      }
      break
    case 'audio':
      mediaField.audio = {
        file_id: fileId,
        file_unique_id: fileUniqueId,
        duration: 30,
      }
      break
    case 'voice':
      mediaField.voice = {
        file_id: fileId,
        file_unique_id: fileUniqueId,
        duration: 5,
      }
      break
    case 'sticker':
      mediaField.sticker = {
        file_id: fileId,
        file_unique_id: fileUniqueId,
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
        type: 'regular',
      }
      break
  }

  const ctx: any = {
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      caption,
      ...mediaField,
    },
    from: {
      id: userId,
      username,
      first_name: username,
      is_bot: false,
    },
    chat: {
      id: chatId,
      type: 'private',
    },
  }

  return ctx
}

// ─── Reaction context factory ─────────────────────────────────────────────────

export interface ReactionCtxOpts {
  chatId?: number
  userId?: number
  username?: string
  messageId?: number
  oldEmoji?: string
}

export function createReactionCtx(emoji: string, opts: ReactionCtxOpts = {}) {
  const {
    chatId = 100,
    userId = 12345,
    username = 'testuser',
    messageId = 1,
    oldEmoji,
  } = opts

  const ctx: any = {
    messageReaction: {
      message_id: messageId,
      chat: { id: chatId, type: 'private' },
      user: { id: userId, username, first_name: username, is_bot: false },
      new_reaction: [{ type: 'emoji', emoji }],
      old_reaction: oldEmoji ? [{ type: 'emoji', emoji: oldEmoji }] : [],
    },
  }

  return ctx
}

// ─── Mock MCP factory ────────────────────────────────────────────────────────

export function createMockMcp() {
  const notifications: any[] = []
  const requestHandlers: Map<any, any> = new Map()

  const mcp: any = {
    notification(params: any) {
      notifications.push(params)
    },
    setRequestHandler(schema: any, handler: any) {
      requestHandlers.set(schema, handler)
    },
    _requestHandlers: requestHandlers,
  }

  return { mcp, notifications }
}

// ─── Mock Deps factory ────────────────────────────────────────────────────────

export function createMockDeps(overrides: Partial<Deps> = {}): Deps {
  const { bot } = createMockBot()
  const { mcp } = createMockMcp()

  const cache: MessageCache = {
    get(_chatId: string, _messageId: string) { return undefined },
    set(_chatId: string, _messageId: string, _content: string) {},
    flush() {},
    destroy() {},
  }

  const sessions: SessionManager = {
    register() { return 'mock-session-id' },
    isActive() { return false },
    watch() {},
    stop() {},
    activate() {},
    switchTo(_sessionId: string) {},
    getAll() { return {} },
    getDeepLink(_sessionId: string) { return '' },
    addAckedMessage(_chatId: string, _messageId: number) {},
    clearAckedMessages(_chatId: string) { return [] },
    getLastInbound(_chatId: string) { return undefined },
    setLastInbound(_chatId: string, _messageId: string) {},
  }

  const defaults: Deps = {
    bot: bot as any,
    mcp: mcp as any,
    cache,
    sessions,
    loadAccess: () => createAccess(),
    saveAccess: (_access: any) => {},
    withAccessLock: <T>(fn: () => T) => fn(),
    stateDir: '/tmp/test-state',
    botUsername: 'testbot',
    transcribe: undefined,
  }

  return { ...defaults, ...overrides }
}

// ─── Callback query context factory ──────────────────────────────────────────

export interface CallbackCtxOpts {
  chatId?: number
  userId?: number
  username?: string
  messageId?: number
  messageText?: string
}

export function createCallbackCtx(data: string, opts: CallbackCtxOpts = {}) {
  const {
    chatId = 100,
    userId = 12345,
    username = 'testuser',
    messageId = 1,
    messageText = '',
  } = opts

  const answerCalls: any[] = []

  const ctx: any = {
    callbackQuery: {
      id: 'cbq_mock',
      data,
      from: { id: userId, username, first_name: username, is_bot: false },
      message: {
        message_id: messageId,
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: messageText,
      },
    },
    from: { id: userId, username, first_name: username, is_bot: false },
    chat: { id: chatId, type: 'private' },
    answerCallbackQuery: (...args: any[]) => {
      answerCalls.push(args)
      return Promise.resolve()
    },
    _answerCalls: answerCalls,
  }

  return ctx
}

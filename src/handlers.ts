import type { Deps } from './types.ts'
import { gate, pruneExpired, isUserAuthorized } from './gate.ts'

export function registerHandlers(deps: Deps): void {
  const { bot, mcp, cache, sessions } = deps

  // ─── message:text (includes bot commands) ──────────────────────────────────
  bot.on('message:text', async (ctx: any) => {
    const text: string = ctx.message.text

    // ─── Bot commands ────────────────────────────────────────────────────────
    if (text.startsWith('/')) {
      const handled = await handleCommand(ctx, deps)
      if (handled) return
    }

    // ─── Gate ────────────────────────────────────────────────────────────────
    const result = runGate(ctx, deps)
    if (result.action === 'drop') return
    if (result.action === 'pair') {
      await bot.api.sendMessage(
        String(ctx.chat.id),
        `Your pairing code is: ${result.code}`,
      )
      return
    }

    // ─── Deliver ─────────────────────────────────────────────────────────────
    const { access } = result
    await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

    let content = text
    const replyPrefix = extractReplyContext(ctx)
    if (replyPrefix) content = replyPrefix + content

    const meta = buildMeta(ctx)

    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    })

    cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), content)
    sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))

    await applyAck(ctx, access, deps)
  })

  // ─── message:photo ─────────────────────────────────────────────────────────
  bot.on('message:photo', async (ctx: any) => {
    const result = runGate(ctx, deps)
    if (result.action === 'drop') return
    if (result.action === 'pair') {
      await bot.api.sendMessage(String(ctx.chat.id), `Your pairing code is: ${result.code}`)
      return
    }

    const { access } = result
    await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    const content = ctx.message.caption || '(photo)'
    const meta = buildMeta(ctx)
    meta.media_token = `photo:${best.file_id}:${best.file_unique_id}`

    const replyPrefix = extractReplyContext(ctx)
    const fullContent = replyPrefix ? replyPrefix + content : content

    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: fullContent, meta },
    })

    cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), fullContent)
    sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))

    await applyAck(ctx, access, deps)
  })

  // ─── message:document ──────────────────────────────────────────────────────
  bot.on('message:document', async (ctx: any) => {
    const result = runGate(ctx, deps)
    if (result.action === 'drop') return
    if (result.action === 'pair') {
      await bot.api.sendMessage(String(ctx.chat.id), `Your pairing code is: ${result.code}`)
      return
    }

    const { access } = result
    await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

    const doc = ctx.message.document
    const content = ctx.message.caption || doc.file_name || '(document)'
    const meta = buildMeta(ctx)
    meta.media_token = `document:${doc.file_id}:${doc.file_unique_id}`

    const replyPrefix = extractReplyContext(ctx)
    const fullContent = replyPrefix ? replyPrefix + content : content

    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: fullContent, meta },
    })

    cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), fullContent)
    sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))

    await applyAck(ctx, access, deps)
  })

  // ─── message:video ─────────────────────────────────────────────────────────
  bot.on('message:video', async (ctx: any) => {
    const result = runGate(ctx, deps)
    if (result.action === 'drop') return
    if (result.action === 'pair') {
      await bot.api.sendMessage(String(ctx.chat.id), `Your pairing code is: ${result.code}`)
      return
    }

    const { access } = result
    await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

    const video = ctx.message.video
    const content = ctx.message.caption || '(video)'
    const meta = buildMeta(ctx)
    meta.media_token = `video:${video.file_id}:${video.file_unique_id}`

    const replyPrefix = extractReplyContext(ctx)
    const fullContent = replyPrefix ? replyPrefix + content : content

    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: fullContent, meta },
    })

    cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), fullContent)
    sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))

    await applyAck(ctx, access, deps)
  })

  // ─── message:voice ─────────────────────────────────────────────────────────
  bot.on('message:voice', async (ctx: any) => {
    const result = runGate(ctx, deps)
    if (result.action === 'drop') return
    if (result.action === 'pair') {
      await bot.api.sendMessage(String(ctx.chat.id), `Your pairing code is: ${result.code}`)
      return
    }

    const { access } = result
    await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

    const voice = ctx.message.voice
    const meta = buildMeta(ctx)
    meta.media_token = `voice:${voice.file_id}:${voice.file_unique_id}`

    let content = '(voice message)'
    if (deps.transcribe) {
      try {
        const fileInfo = await bot.api.getFile(voice.file_id)
        const url = `https://api.telegram.org/file/bot${(bot as any).token}/${fileInfo.file_path}`
        const response = await fetch(url)
        const buf = Buffer.from(await response.arrayBuffer())
        const text = await deps.transcribe(buf)
        content = `[Voice: "${text}"]`
      } catch {
        content = '(voice message)'
      }
    }

    const replyPrefix = extractReplyContext(ctx)
    const fullContent = replyPrefix ? replyPrefix + content : content

    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: fullContent, meta },
    })

    cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), fullContent)
    sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))

    await applyAck(ctx, access, deps)
  })

  // ─── message:audio ─────────────────────────────────────────────────────────
  bot.on('message:audio', async (ctx: any) => {
    const result = runGate(ctx, deps)
    if (result.action === 'drop') return
    if (result.action === 'pair') {
      await bot.api.sendMessage(String(ctx.chat.id), `Your pairing code is: ${result.code}`)
      return
    }

    const { access } = result
    await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

    const audio = ctx.message.audio
    const content = ctx.message.caption || audio.title || audio.file_name || '(audio)'
    const meta = buildMeta(ctx)
    meta.media_token = `audio:${audio.file_id}:${audio.file_unique_id}`

    const replyPrefix = extractReplyContext(ctx)
    const fullContent = replyPrefix ? replyPrefix + content : content

    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: fullContent, meta },
    })

    cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), fullContent)
    sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))

    await applyAck(ctx, access, deps)
  })

  // ─── message:sticker ──────────────────────────────────────────────────────
  bot.on('message:sticker', async (ctx: any) => {
    const result = runGate(ctx, deps)
    if (result.action === 'drop') return
    if (result.action === 'pair') {
      await bot.api.sendMessage(String(ctx.chat.id), `Your pairing code is: ${result.code}`)
      return
    }

    const { access } = result
    await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

    const sticker = ctx.message.sticker
    const emoji = sticker.emoji || ''
    const content = `(sticker: ${emoji})`
    const meta = buildMeta(ctx)
    meta.media_token = `sticker:${sticker.file_id}:${sticker.file_unique_id}`

    const replyPrefix = extractReplyContext(ctx)
    const fullContent = replyPrefix ? replyPrefix + content : content

    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: fullContent, meta },
    })

    cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), fullContent)
    sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))

    await applyAck(ctx, access, deps)
  })

  // ─── message_reaction ─────────────────────────────────────────────────────
  bot.on('message_reaction', async (ctx: any) => {
    const reaction = ctx.messageReaction
    const newReactions = reaction.new_reaction ?? []
    const oldReactions = reaction.old_reaction ?? []

    // Find added emojis (in new but not in old)
    const oldSet = new Set(oldReactions.map((r: any) => r.emoji))
    const added = newReactions.filter((r: any) => !oldSet.has(r.emoji))

    if (added.length === 0) return

    // Gate check: verify chat is allowed
    const chatId = String(reaction.chat.id)
    const userId = String(reaction.user?.id ?? '')

    const gateCtx = {
      from: reaction.user,
      chat: reaction.chat,
      message: {},
    }

    const result = runGate(gateCtx, deps)
    if (result.action !== 'deliver') return

    const { access } = result

    for (const r of added) {
      const emoji = r.emoji
      const msgId = String(reaction.message_id)
      const cached = cache.get(chatId, msgId)

      let content: string
      if (cached) {
        content = `[Reacted ${emoji} to: "${cached}"]`
      } else {
        content = `[Reacted ${emoji} to message #${msgId}]`
      }

      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            chat_id: chatId,
            message_id: String(reaction.message_id),
            user: reaction.user?.first_name ?? reaction.user?.username ?? 'unknown',
            user_id: userId,
            ts: new Date().toISOString(),
          },
        },
      })
    }
  })

  // ─── callback_query:data ──────────────────────────────────────────────────
  bot.on('callback_query:data', async (ctx: any) => {
    const data = ctx.callbackQuery.data
    const userId = String(ctx.from.id)
    const chatId = String(ctx.chat.id)

    // Session switch callback
    if (data.startsWith('switch_')) {
      const access = deps.withAccessLock(() => deps.loadAccess())
      if (!isUserAuthorized(userId, access)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized' })
        return
      }
      const targetSessionId = data.slice('switch_'.length)
      sessions.switchTo(targetSessionId)
      const label = sessions.getAll()[targetSessionId]?.label ?? targetSessionId
      await ctx.answerCallbackQuery({ text: `Switched to: ${label}` })
      return
    }

    // Regular callback
    const meta = {
      chat_id: chatId,
      message_id: ctx.callbackQuery.message?.message_id,
      user: ctx.from.first_name ?? ctx.from.username ?? 'unknown',
      user_id: userId,
      ts: new Date((ctx.callbackQuery.message?.date ?? 0) * 1000).toISOString(),
      reply_to_message_id: ctx.callbackQuery.message?.message_id,
    }

    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `[Button pressed: ${data}]`,
        meta,
      },
    })

    await ctx.answerCallbackQuery()
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runGate(ctx: any, deps: Deps) {
  return deps.withAccessLock(() => {
    const access = deps.loadAccess()
    const pruned = pruneExpired(access)
    if (pruned) deps.saveAccess(access)

    const result = gate(ctx, access, deps.botUsername)

    if (result.action === 'pair') {
      deps.saveAccess(result.updatedAccess)
    }

    return result
  })
}

function extractReplyContext(ctx: any): string | null {
  const reply = ctx.message?.reply_to_message
  if (!reply) return null

  const text = reply.text ?? reply.caption ?? ''
  if (!text) return null

  const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text
  return `[Replying to: "${truncated}"]\n`
}

function relativeAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function buildMeta(ctx: any): Record<string, any> {
  return {
    chat_id: String(ctx.chat.id),
    message_id: String(ctx.message.message_id),
    user: ctx.from?.first_name ?? ctx.from?.username ?? 'unknown',
    user_id: String(ctx.from?.id ?? ''),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
  }
}

async function applyAck(ctx: any, access: any, deps: Deps): Promise<void> {
  if (!access.ackReaction) return

  try {
    await deps.bot.api.setMessageReaction(
      String(ctx.chat.id),
      ctx.message.message_id,
      [{ type: 'emoji', emoji: access.ackReaction }],
    )
    deps.sessions.addAckedMessage(String(ctx.chat.id), ctx.message.message_id)
  } catch {
    // ignore ack failures
  }
}

async function handleCommand(ctx: any, deps: Deps): Promise<boolean> {
  const text: string = ctx.message.text
  const parts = text.split(/\s+/)
  const cmd = parts[0].toLowerCase().split('@')[0]
  const chatId = String(ctx.chat.id)
  const userId = String(ctx.from.id)

  if (cmd === '/chatid') {
    await deps.bot.api.sendMessage(chatId, `Chat ID: ${chatId}`)
    return true
  }

  if (cmd === '/sessions') {
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    const all = deps.sessions.getAll()
    const lines: string[] = []
    for (const [id, session] of Object.entries(all)) {
      const icon = session.active ? '\u{1F7E2}' : '\u{26AA}' // 🟢 / ⚪
      const age = relativeAge(session.startedAt)
      lines.push(`${icon} ${session.label} (${age})`)
    }
    const msg = lines.length > 0 ? lines.join('\n') : 'No sessions'
    await deps.bot.api.sendMessage(chatId, msg)
    return true
  }

  if (cmd === '/status') {
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    const all = deps.sessions.getAll()
    const active = Object.entries(all).find(([, s]) => s.active)
    if (active) {
      const [id, session] = active
      await deps.bot.api.sendMessage(chatId, `Active session: ${session.label} [${id}]`)
    } else {
      await deps.bot.api.sendMessage(chatId, 'No active session')
    }
    return true
  }

  if (cmd === '/switch') {
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    if (ctx.chat.type !== 'private') return true
    const targetId = parts[1]
    if (targetId) {
      deps.sessions.switchTo(targetId)
      await deps.bot.api.sendMessage(chatId, `Switching to session ${targetId}`)
    }
    return true
  }

  if (cmd === '/start' && parts[1]?.startsWith('switch_')) {
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    const targetId = parts[1].slice('switch_'.length)
    deps.sessions.switchTo(targetId)
    await deps.bot.api.sendMessage(chatId, `Switching to session ${targetId}`)
    return true
  }

  return false
}

import type { Deps } from './types.ts'
import { gate, pruneExpired, isUserAuthorized } from './gate.ts'

export function registerHandlers(deps: Deps): void {
  const { bot, mcp, cache, sessions } = deps

  // ─── message:text (includes bot commands) ──────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text

    // Reply to /name prompt
    const replyTo = ctx.message?.reply_to_message
    if (replyTo?.from?.id === bot.botInfo?.id && replyTo?.text?.startsWith('Reply to this message with the new session name')) {
      const userId = String(ctx.from.id)
      const access = deps.withAccessLock(() => deps.loadAccess())
      if (isUserAuthorized(userId, access)) {
        deps.sessions.renameSession(text.trim())
        await bot.api.sendMessage(String(ctx.chat.id), `Session renamed: ${text.trim()}`)
      }
      return
    }

    // Bot commands
    if (text.startsWith('/')) {
      const handled = await handleCommand(ctx, deps)
      if (handled) return
    }

    // Deliver text message
    await handleInbound(ctx, text, undefined, deps)
  })

  // ─── Media handlers ───────────────────────────────────────────────────────

  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    const content = ctx.message.caption || '(photo)'
    const mediaToken = `photo:${best.file_id}:${best.file_unique_id}`
    await handleInbound(ctx, content, mediaToken, deps)
  })

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document
    const content = ctx.message.caption || doc.file_name || '(document)'
    const mediaToken = `document:${doc.file_id}:${doc.file_unique_id}`
    await handleInbound(ctx, content, mediaToken, deps)
  })

  bot.on('message:video', async (ctx) => {
    const video = ctx.message.video
    const content = ctx.message.caption || '(video)'
    const mediaToken = `video:${video.file_id}:${video.file_unique_id}`
    await handleInbound(ctx, content, mediaToken, deps)
  })

  bot.on('message:voice', async (ctx) => {
    const voice = ctx.message.voice
    const mediaToken = `voice:${voice.file_id}:${voice.file_unique_id}`

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

    await handleInbound(ctx, content, mediaToken, deps)
  })

  bot.on('message:audio', async (ctx) => {
    const audio = ctx.message.audio
    const content = ctx.message.caption || audio.title || audio.file_name || '(audio)'
    const mediaToken = `audio:${audio.file_id}:${audio.file_unique_id}`
    await handleInbound(ctx, content, mediaToken, deps)
  })

  bot.on('message:sticker', async (ctx) => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji || ''
    const content = `(sticker: ${emoji})`
    const mediaToken = `sticker:${sticker.file_id}:${sticker.file_unique_id}`
    await handleInbound(ctx, content, mediaToken, deps)
  })

  // ─── message_reaction ─────────────────────────────────────────────────────
  bot.on('message_reaction', async (ctx) => {
    const reaction = ctx.messageReaction
    const newReactions = reaction.new_reaction ?? []
    const oldReactions = reaction.old_reaction ?? []

    const oldSet = new Set(oldReactions.map((r: any) => r.emoji))
    const added = newReactions.filter((r: any) => !oldSet.has(r.emoji))
    if (added.length === 0) return

    const chatId = String(reaction.chat.id)
    const userId = String(reaction.user?.id ?? '')

    const gateCtx = { from: reaction.user, chat: reaction.chat, message: {} }
    const result = runGate(gateCtx, deps)
    if (result.action !== 'deliver') return

    for (const r of added) {
      const emoji = r.emoji
      const msgId = String(reaction.message_id)
      const cached = cache.get(chatId, msgId)
      const content = cached
        ? `[Reacted ${emoji} to: "${cached}"]`
        : `[Reacted ${emoji} to message #${msgId}]`

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
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data
    const userId = String(ctx.from.id)
    const chatId = String(ctx.chat!.id)

    // Session switch callback
    if (data.startsWith('switch_')) {
      const access = deps.withAccessLock(() => deps.loadAccess())
      if (!isUserAuthorized(userId, access)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized' })
        return
      }
      const targetSessionId = data.slice('switch_'.length)
      await sessions.switchTo(targetSessionId, { immediate: true })
      const label = sessions.getAll()[targetSessionId]?.label ?? targetSessionId
      await ctx.answerCallbackQuery({ text: `Switched to: ${label}` })
      return
    }

    // Regular callback
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `[Button pressed: ${data}]`,
        meta: {
          chat_id: chatId,
          message_id: String(ctx.callbackQuery.message?.message_id ?? ''),
          user: ctx.from.first_name ?? ctx.from.username ?? 'unknown',
          user_id: userId,
          ts: new Date((ctx.callbackQuery.message?.date ?? 0) * 1000).toISOString(),
          reply_to_message_id: String(ctx.callbackQuery.message?.message_id ?? ''),
        },
      },
    })

    await ctx.answerCallbackQuery()
  })
}

// ─── Shared inbound handler ──────────────────────────────────────────────────

async function handleInbound(
  ctx: any,
  content: string,
  mediaToken: string | undefined,
  deps: Deps,
): Promise<void> {
  const { bot, mcp, cache, sessions } = deps

  const result = runGate(ctx, deps)
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    await bot.api.sendMessage(String(ctx.chat.id), `Your pairing code is: ${result.code}`)
    return
  }

  const { access } = result
  await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

  const replyPrefix = extractReplyContext(ctx)
  const fullContent = replyPrefix ? replyPrefix + content : content

  const meta = buildMeta(ctx)
  if (mediaToken) meta.media_token = mediaToken

  mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: fullContent, meta },
  })

  cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), fullContent)
  sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))

  await applyAck(ctx, access, deps)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function buildMeta(ctx: any): Record<string, string> {
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
    const entries = Object.entries(all)
    if (entries.length === 0) {
      await deps.bot.api.sendMessage(chatId, 'No sessions')
      return true
    }
    const lines: string[] = []
    const buttons: { text: string; callback_data: string }[][] = []
    for (const [id, session] of entries) {
      const icon = session.active ? '\u{1F7E2}' : '\u{26AA}'
      const age = relativeAge(session.startedAt)
      lines.push(`${icon} ${session.label} (${age})`)
      if (!session.active) {
        buttons.push([{ text: `\u{1F504} ${session.label}`, callback_data: `switch_${id}` }])
      }
    }
    const opts = buttons.length > 0
      ? { reply_markup: { inline_keyboard: buttons } }
      : {}
    await deps.bot.api.sendMessage(chatId, lines.join('\n'), opts)
    return true
  }

  if (cmd === '/status') {
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    const all = deps.sessions.getAll()
    const active = Object.entries(all).find(([, s]) => s.active)
    if (active) {
      const [, session] = active
      await deps.bot.api.sendMessage(chatId, `Active: ${session.label}`)
    } else {
      await deps.bot.api.sendMessage(chatId, 'No active session')
    }
    return true
  }

  if (cmd === '/name') {
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    const newName = parts.slice(1).join(' ').trim()
    if (!newName) {
      await deps.bot.api.sendMessage(chatId, 'Reply to this message with the new session name', {
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Session name...' },
      })
      return true
    }
    deps.sessions.renameSession(newName)
    await deps.bot.api.sendMessage(chatId, `Session renamed: ${newName}`)
    return true
  }

  if (cmd === '/switch') {
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    if (ctx.chat.type !== 'private') return true
    const targetArg = parts.slice(1).join(' ').trim()
    if (targetArg) {
      const all = deps.sessions.getAll()
      let targetId = targetArg
      if (!all[targetArg]) {
        const match = Object.entries(all).find(([, s]) => s.label === targetArg)
        if (match) targetId = match[0]
      }
      if (!all[targetId]) {
        await deps.bot.api.sendMessage(chatId, `Session not found: ${targetArg}`)
        return true
      }
      await deps.sessions.switchTo(targetId, { immediate: true })
      const label = all[targetId]?.label ?? targetId
      await deps.bot.api.sendMessage(chatId, `Switched to ${label}`)
    } else {
      const all = deps.sessions.getAll()
      const entries = Object.entries(all)
      if (entries.length <= 1) {
        await deps.bot.api.sendMessage(chatId, 'Only one session active')
        return true
      }
      const buttons = entries
        .filter(([, s]) => !s.active)
        .map(([id, s]) => [{ text: `\u{1F504} ${s.label}`, callback_data: `switch_${id}` }])
      if (buttons.length > 0) {
        await deps.bot.api.sendMessage(chatId, 'Switch to:', {
          reply_markup: { inline_keyboard: buttons },
        })
      } else {
        await deps.bot.api.sendMessage(chatId, 'No other sessions to switch to')
      }
    }
    return true
  }

  if (cmd === '/start' && parts[1]?.startsWith('switch_')) {
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    const targetId = parts[1].slice('switch_'.length)
    await deps.sessions.switchTo(targetId, { immediate: true })
    await deps.bot.api.sendMessage(chatId, `Switching to session ${targetId}`)
    return true
  }

  return false
}

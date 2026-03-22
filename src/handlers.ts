import type { Deps } from './types.ts'
import { gate, pruneExpired, isUserAuthorized } from './gate.ts'
import { readAskPending, writeAskReply, deleteAskPending } from './ask-io.ts'

export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

export function registerHandlers(deps: Deps): void {
  const { bot, mcp, cache, sessions } = deps

  // ─── message:text (includes bot commands) ──────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text

    // Reply to /name prompt
    const replyTo = ctx.message?.reply_to_message
    if (replyTo?.from?.id === bot.botInfo?.id && replyTo?.text?.startsWith('Reply to this message with the new session name')) {
      if (ctx.chat?.type !== 'private') return
      const userId = String(ctx.from.id)
      const access = deps.withAccessLock(() => deps.loadAccess())
      if (isUserAuthorized(userId, access)) {
        const newName = text.trim()
        const cid = String(ctx.chat.id)
        deps.sessions.renameSession(newName)
        await bot.api.sendMessage(cid, `Renamed to ${newName}`)
        const pinned = await bot.api.sendMessage(cid, `Active session: <b>${newName}</b>`, { parse_mode: 'HTML' })
        await bot.api.pinChatMessage(cid, pinned.message_id, { disable_notification: true }).catch(() => {})
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
    const content = ctx.message.caption || safeName(doc.file_name) || '(document)'
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
    const content = ctx.message.caption || safeName(audio.title) || safeName(audio.file_name) || '(audio)'
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
      }).catch(err => process.stderr.write(`telegram channel: reaction notification error: ${err}\n`))
    }
  })

  // ─── callback_query:data ──────────────────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data
    const userId = String(ctx.from.id)
    const chatId = String(ctx.chat!.id)

    // Ask-user redirect: route callback to reply file
    if (data.startsWith('ask_answer_')) {
      const pending = readAskPending(deps.stateDir)
      if (pending) {
        // Validate callback is from the correct message/chat (prevents stale buttons)
        const cbMsgId = ctx.callbackQuery.message?.message_id
        if (chatId !== pending.chatId || (cbMsgId && cbMsgId !== pending.sentMessageId)) {
          await ctx.answerCallbackQuery({ text: 'Expired prompt' })
          return
        }

        const access = deps.withAccessLock(() => deps.loadAccess())
        if (!isUserAuthorized(userId, access)) {
          await ctx.answerCallbackQuery({ text: 'Not authorized' })
          return
        }

        const idx = parseInt(data.slice('ask_answer_'.length), 10)
        const answer = pending.options?.[idx]?.label ?? `Option ${idx}`

        writeAskReply(deps.stateDir, {
          nonce: pending.nonce,
          answer,
          userId,
          ts: Date.now(),
        })

        // Delete pending immediately so a second event can't overwrite the answer
        deleteAskPending(deps.stateDir)

        await ctx.answerCallbackQuery({ text: 'Sent!' })

        if (pending.sentMessageId) {
          await bot.api.deleteMessage(chatId, pending.sentMessageId).catch(() => {})
        }
        return
      }
    }

    // Session switch callback
    if (data.startsWith('switch_')) {
      const access = deps.withAccessLock(() => deps.loadAccess())
      if (!isUserAuthorized(userId, access)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized' })
        return
      }
      // "Keep" button sends switch_dismiss — just acknowledge
      if (data === 'switch_dismiss') {
        await ctx.answerCallbackQuery({ text: 'Kept current session' })
        return
      }
      const targetSessionId = data.slice('switch_'.length)
      // Validate target exists before switching
      const all = sessions.getAll()
      if (!all[targetSessionId]) {
        await ctx.answerCallbackQuery({ text: 'Session not found' })
        return
      }
      const switched = await sessions.switchTo(targetSessionId, { immediate: true })
      if (!switched) {
        await ctx.answerCallbackQuery({ text: 'Session not found' })
        return
      }
      const label = all[targetSessionId]?.label ?? targetSessionId
      await ctx.answerCallbackQuery({ text: `Switched to: ${label}` })
      return
    }

    // Permission relay callback
    if (data.startsWith('perm:')) {
      const access = deps.withAccessLock(() => deps.loadAccess())
      if (!isUserAuthorized(userId, access)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized' })
        return
      }

      const parts = data.split(':')
      const behavior = parts[1]
      const key = parts[2]

      if (!key || (behavior !== 'allow' && behavior !== 'deny')) {
        await ctx.answerCallbackQuery({ text: 'Invalid' })
        return
      }

      const result = await deps.permissionRelay.resolveByKey(key, behavior)
      if (result === 'not_found') {
        await ctx.answerCallbackQuery({ text: 'Already resolved' })
        return
      }
      if (result === 'send_failed') {
        await ctx.answerCallbackQuery({ text: 'Failed to send — respond in terminal' })
        return
      }

      await ctx.answerCallbackQuery({
        text: behavior === 'allow' ? 'Allowed' : 'Denied',
      })
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
    }).catch(err => process.stderr.write(`telegram channel: callback notification error: ${err}\n`))

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

  // Ask-user redirect: route text reply to file (only text, not media)
  if (!mediaToken) {
    const askPending = readAskPending(deps.stateDir)
    if (askPending && String(ctx.chat.id) === askPending.chatId) {
      writeAskReply(deps.stateDir, {
        nonce: askPending.nonce,
        answer: content,
        userId: String(ctx.from.id),
        ts: Date.now(),
      })
      deleteAskPending(deps.stateDir)
      return
    }
  }

  await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})

  const replyPrefix = extractReplyContext(ctx)
  const fullContent = replyPrefix ? replyPrefix + content : content

  const meta = buildMeta(ctx)
  if (mediaToken) meta.media_token = mediaToken

  // Await the notification so we only cache/ack on successful send.
  // Note: resolving only means the transport accepted the bytes, not that
  // Claude Code received them. But rejecting means a known send failure
  // (broken pipe, buffer error) — in that case, don't show success UI.
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: fullContent, meta },
    })
    cache.set(String(ctx.chat!.id), String(ctx.message!.message_id), fullContent)
    sessions.setLastInbound(String(ctx.chat!.id), String(ctx.message!.message_id))
    await applyAck(ctx, access, deps)
  } catch (err) {
    process.stderr.write(`telegram channel: inbound notification failed: ${err}\n`)
  }
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
    if (ctx.chat?.type !== 'private') return true
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
    const all = deps.sessions.getAll()
    const entries = Object.entries(all)
    if (entries.length === 0) {
      await deps.bot.api.sendMessage(chatId, 'No sessions')
      return true
    }
    const active = entries.find(([, s]) => s.active)
    const activeLabel = active ? active[1].label : 'none'
    const inactive = entries.filter(([, s]) => !s.active)
    if (inactive.length === 0) {
      await deps.bot.api.sendMessage(chatId, `\u{1F7E2} <b>${activeLabel}</b> is active\n\nNo other sessions`, { parse_mode: 'HTML' })
    } else {
      const buttons = inactive.map(([id, s]) => [{ text: s.label, callback_data: `switch_${id}` }])
      await deps.bot.api.sendMessage(chatId, `\u{1F7E2} <b>${activeLabel}</b> is active\n\nSwitch to:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      })
    }
    return true
  }

  if (cmd === '/status') {
    if (ctx.chat?.type !== 'private') return true
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
    if (ctx.chat?.type !== 'private') return true
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
    await deps.bot.api.sendMessage(chatId, `Renamed to ${newName}`)
    const pinned = await deps.bot.api.sendMessage(chatId, `Active session: <b>${newName}</b>`, { parse_mode: 'HTML' })
    await deps.bot.api.pinChatMessage(chatId, pinned.message_id, { disable_notification: true }).catch(() => {})
    return true
  }

  if (cmd === '/switch') {
    if (ctx.chat?.type !== 'private') return true
    const access = deps.withAccessLock(() => deps.loadAccess())
    if (!isUserAuthorized(userId, access)) return true
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
      const switched = await deps.sessions.switchTo(targetId, { immediate: true })
      if (!switched) {
        await deps.bot.api.sendMessage(chatId, `Session not found: ${targetArg}`)
        return true
      }
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

  if (cmd === '/start') {
    // All /start variants are DM-only
    if (ctx.chat?.type !== 'private') return true
    // Deep-link: /start switch_<id> for session switching
    if (parts[1]?.startsWith('switch_')) {
      const access = deps.withAccessLock(() => deps.loadAccess())
      if (!isUserAuthorized(userId, access)) return true
      const targetId = parts[1].slice('switch_'.length)
      const all = deps.sessions.getAll()
      if (!all[targetId]) {
        await deps.bot.api.sendMessage(chatId, `Session not found: ${targetId}`)
        return true
      }
      const switched = await deps.sessions.switchTo(targetId, { immediate: true })
      if (!switched) {
        await deps.bot.api.sendMessage(chatId, `Session not found: ${targetId}`)
        return true
      }
      await deps.bot.api.sendMessage(chatId, `Switching to ${all[targetId]?.label ?? targetId}`)
      return true
    }
    const access = deps.withAccessLock(() => deps.loadAccess())
    const pairingText = access.dmPolicy === 'pairing'
      ? `To pair:\n` +
        `1. DM me anything — you'll get a 4-char code\n` +
        `2. In Claude Code: /telegram:access pair <code>\n\n` +
        `After that, DMs here reach that session.`
      : access.dmPolicy === 'disabled'
        ? `This bot isn't accepting new connections.`
        : `This bot is in allowlist mode. Ask the bot owner to add you.`
    await deps.bot.api.sendMessage(chatId,
      `This bot bridges Telegram to a Claude Code session.\n\n${pairingText}`
    )
    return true
  }

  if (cmd === '/help') {
    if (ctx.chat?.type !== 'private') return true
    await deps.bot.api.sendMessage(chatId,
      `Messages you send here route to a paired Claude Code session. ` +
      `Text, photos, documents, and voice messages are forwarded; replies and reactions come back.\n\n` +
      `/start — pairing instructions\n` +
      `/sessions — list active sessions\n` +
      `/switch — switch to another session\n` +
      `/status — show current active session\n` +
      `/chatid — show this chat's ID`
    )
    return true
  }

  return false
}

import { statSync } from 'node:fs'
import { InputFile } from 'grammy'
import type { Deps } from './types.ts'
import { assertAllowedChat, assertSendable } from './gate.ts'
import { chunk } from './chunk.ts'
import { parseMediaToken, downloadMedia } from './media.ts'

type ToolResult = { content: { type: string; text: string }[] }

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text: `error: ${text}` }] }
}

function isImageFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
}

export async function handleToolCall(
  name: string,
  args: Record<string, any>,
  deps: Deps,
): Promise<ToolResult> {
  switch (name) {
    case 'reply':
      return handleReply(args, deps)
    case 'react':
      return handleReact(args, deps)
    case 'edit_message':
      return handleEditMessage(args, deps)
    case 'fetch_media':
      return handleFetchMedia(args, deps)
    default:
      return err(`Unknown tool: ${name}`)
  }
}

// ─── reply ───────────────────────────────────────────────────────────────────

async function handleReply(args: Record<string, any>, deps: Deps): Promise<ToolResult> {
  const {
    chat_id,
    text,
    files,
    reply_to,
    parse_mode,
    inline_keyboard,
    reply_keyboard,
    one_time_keyboard,
    remove_keyboard,
  } = args

  // 1. Access check
  let access
  try {
    access = deps.loadAccess()
    assertAllowedChat(chat_id, access)
  } catch (e: any) {
    return err(e.message)
  }

  // 2. Must have text or files
  if (!text && (!files || files.length === 0)) {
    return err('must have text or files')
  }

  // 3. Keyboard mutual exclusivity
  const kbCount = [inline_keyboard, reply_keyboard, remove_keyboard].filter(Boolean).length
  if (kbCount > 1) {
    return err('only one of inline_keyboard, reply_keyboard, remove_keyboard allowed')
  }
  if (one_time_keyboard && !reply_keyboard) {
    return err('one_time_keyboard requires reply_keyboard')
  }

  // 4. Validate InlineButtons
  if (inline_keyboard) {
    for (const row of inline_keyboard) {
      for (const btn of row) {
        const hasCb = 'callback_data' in btn && btn.callback_data !== undefined
        const hasUrl = 'url' in btn && btn.url !== undefined
        if (hasCb && hasUrl) {
          return err('InlineButton must have exactly one of callback_data or url, not both')
        }
        if (!hasCb && !hasUrl) {
          return err('InlineButton must have exactly one of callback_data or url')
        }
      }
    }
  }

  // 5. Chunk text
  const effectiveParseMode = parse_mode
  const chunkLimit = access.textChunkLimit ?? 4096
  const chunkMode = access.chunkMode ?? 'length'
  const chunks = text ? chunk(text, chunkLimit, chunkMode) : []

  // 6. Auto-threading
  let replyToMsgId: number | undefined
  if (reply_to) {
    replyToMsgId = parseInt(reply_to)
  } else if (access.replyToMode === 'first' || access.replyToMode === 'all') {
    const lastInbound = deps.sessions.getLastInbound(chat_id)
    if (lastInbound) {
      replyToMsgId = parseInt(lastInbound)
    }
  }

  // Build keyboard markup
  let replyMarkup: any
  if (inline_keyboard) {
    replyMarkup = { inline_keyboard }
  } else if (reply_keyboard) {
    replyMarkup = {
      keyboard: reply_keyboard,
      one_time_keyboard: one_time_keyboard ?? false,
      resize_keyboard: true,
    }
  } else if (remove_keyboard) {
    replyMarkup = { remove_keyboard: true }
  }

  const sentIds: number[] = []
  const hasFiles = files && files.length > 0
  const lastTextIdx = chunks.length - 1
  const lastFileIdx = hasFiles ? files.length - 1 : -1

  // 7. Send text chunks
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === lastTextIdx
    const opts: any = { ...(effectiveParseMode ? { parse_mode: effectiveParseMode } : {}) }

    // reply_to logic
    if (replyToMsgId) {
      if (reply_to) {
        // explicit: all chunks
        opts.reply_parameters = { message_id: replyToMsgId }
      } else if (access.replyToMode === 'all') {
        opts.reply_parameters = { message_id: replyToMsgId }
      } else if (access.replyToMode === 'first' && i === 0) {
        opts.reply_parameters = { message_id: replyToMsgId }
      }
    }

    // Attach keyboard to last text chunk only if there are no files after
    if (isLast && replyMarkup && !hasFiles) {
      opts.reply_markup = replyMarkup
    }

    try {
      const result = await deps.bot.api.sendMessage(chat_id, chunks[i], opts)
      sentIds.push((result as any).message_id)
      deps.cache.set(chat_id, String((result as any).message_id), chunks[i])
    } catch (e: any) {
      // 400 parse error → retry without parse_mode
      if (e.error_code === 400 || (e.message && e.message.includes("can't parse"))) {
        const { parse_mode: _, ...retryOpts } = opts
        const result = await deps.bot.api.sendMessage(chat_id, chunks[i], retryOpts)
        sentIds.push((result as any).message_id)
        deps.cache.set(chat_id, String((result as any).message_id), chunks[i])
      } else {
        throw e
      }
    }
  }

  // 9-10. Send files
  if (hasFiles) {
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i]

      // assertSendable
      try {
        assertSendable(filePath, deps.stateDir)
      } catch (e: any) {
        return err(e.message)
      }

      // Size check
      try {
        const stat = statSync(filePath)
        if (stat.size > MAX_FILE_SIZE) {
          return err(`File ${filePath} exceeds 50MB limit`)
        }
      } catch (e: any) {
        return err(`Cannot stat file: ${filePath}`)
      }

      const isLastFile = i === lastFileIdx
      const opts: any = {}

      if (isLastFile && replyMarkup) {
        opts.reply_markup = replyMarkup
      }

      const inputFile = new InputFile(filePath)

      try {
        let result: any
        if (isImageFile(filePath)) {
          result = await deps.bot.api.sendPhoto(chat_id, inputFile, opts)
        } else {
          result = await deps.bot.api.sendDocument(chat_id, inputFile, opts)
        }
        sentIds.push(result.message_id)
      } catch (e: any) {
        return err(e.message)
      }
    }
  }

  // 11. Clear ack reactions
  const ackedMsgIds = deps.sessions.clearAckedMessages(chat_id)
  for (const msgId of ackedMsgIds) {
    try {
      await deps.bot.api.setMessageReaction(chat_id, msgId, [])
    } catch {
      // ignore reaction clearing errors
    }
  }

  // 12. Return sent message IDs
  return ok(`Sent message(s): ${sentIds.join(', ')}`)
}

// ─── react ───────────────────────────────────────────────────────────────────

async function handleReact(args: Record<string, any>, deps: Deps): Promise<ToolResult> {
  const { chat_id, message_id, emoji } = args

  try {
    assertAllowedChat(chat_id, deps.loadAccess())
  } catch (e: any) {
    return err(e.message)
  }

  try {
    await deps.bot.api.setMessageReaction(chat_id, parseInt(message_id), [
      { type: 'emoji', emoji },
    ])
    return ok('Reaction set')
  } catch (e: any) {
    return err(e.message)
  }
}

// ─── edit_message ────────────────────────────────────────────────────────────

async function handleEditMessage(args: Record<string, any>, deps: Deps): Promise<ToolResult> {
  const { chat_id, message_id, text, parse_mode, inline_keyboard } = args

  try {
    assertAllowedChat(chat_id, deps.loadAccess())
  } catch (e: any) {
    return err(e.message)
  }

  const opts: any = {}
  if (parse_mode) {
    opts.parse_mode = parse_mode
  }
  if (inline_keyboard) {
    opts.reply_markup = { inline_keyboard }
  }

  try {
    await deps.bot.api.editMessageText(chat_id, parseInt(message_id), text, opts)
    return ok('Message edited')
  } catch (e: any) {
    // Parse error fallback
    if (opts.parse_mode && (e.error_code === 400 || (e.message && e.message.includes("can't parse")))) {
      delete opts.parse_mode
      try {
        await deps.bot.api.editMessageText(chat_id, parseInt(message_id), text, opts)
        return ok('Message edited (without parse_mode)')
      } catch (e2: any) {
        return err(e2.message)
      }
    }
    return err(e.message)
  }
}

// ─── fetch_media ─────────────────────────────────────────────────────────────

async function handleFetchMedia(args: Record<string, any>, deps: Deps): Promise<ToolResult> {
  const { media_token } = args

  try {
    const token = parseMediaToken(media_token)
    const localPath = await downloadMedia(deps.bot, token, deps.stateDir)
    return ok(localPath)
  } catch (e: any) {
    return err(e.message)
  }
}

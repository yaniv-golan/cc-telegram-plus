import { realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import type { Access, GateResult } from './types.ts'

type GateOpts = {
  generateCode?: () => string
}

export function gate(
  ctx: any,
  access: Access,
  botUsername: string,
  opts?: GateOpts,
): GateResult {
  const chatType: string = ctx.chat?.type ?? 'private'

  if (chatType === 'private') {
    return gateDM(ctx, access, botUsername, opts)
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    return gateGroup(ctx, access, botUsername)
  }

  return { action: 'drop' }
}

function gateDM(
  ctx: any,
  access: Access,
  botUsername: string,
  opts?: GateOpts,
): GateResult {
  const senderId = String(ctx.from.id)
  const chatId = String(ctx.chat.id)

  if (access.dmPolicy === 'disabled') {
    return { action: 'drop' }
  }

  if (access.dmPolicy === 'allowlist') {
    if (access.allowFrom.includes(senderId)) {
      return { action: 'deliver', access }
    }
    return { action: 'drop' }
  }

  // pairing
  if (access.allowFrom.includes(senderId)) {
    return { action: 'deliver', access }
  }

  // Check if sender already has a pending entry
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.senderId === senderId) {
      entry.replies++
      if (entry.replies >= 2) {
        return { action: 'drop' }
      }
      return {
        action: 'pair',
        code,
        senderId,
        chatId,
        updatedAccess: access,
      }
    }
  }

  // Capacity check
  if (Object.keys(access.pending).length >= 3) {
    return { action: 'drop' }
  }

  // Create new pending entry
  const generateCode = opts?.generateCode ?? (() => crypto.randomBytes(2).toString('hex'))
  const code = generateCode()
  access.pending[code] = {
    senderId,
    chatId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600000,
    replies: 0,
  }

  return {
    action: 'pair',
    code,
    senderId,
    chatId,
    updatedAccess: access,
  }
}

function gateGroup(
  ctx: any,
  access: Access,
  botUsername: string,
): GateResult {
  const chatId = String(ctx.chat.id)
  const group = access.groups[chatId]

  if (!group) {
    return { action: 'drop' }
  }

  if (group.requireMention && !isMentioned(ctx, botUsername, access.mentionPatterns)) {
    return { action: 'drop' }
  }

  if (group.allowFrom.length > 0 && !group.allowFrom.includes(String(ctx.from.id))) {
    return { action: 'drop' }
  }

  return { action: 'deliver', access }
}

export function isMentioned(
  ctx: any,
  botUsername: string,
  patterns?: string[],
): boolean {
  const entities: any[] | undefined = ctx.message?.entities
  const text: string = ctx.message?.text ?? ''

  if (entities) {
    for (const entity of entities) {
      if (entity.type === 'mention') {
        const extracted = text.slice(entity.offset, entity.offset + entity.length)
        if (extracted === `@${botUsername}`) {
          return true
        }
      }
    }
  }

  if (ctx.message?.reply_to_message?.from?.username === botUsername) {
    return true
  }

  if (patterns?.some(p => new RegExp(p, 'i').test(text))) {
    return true
  }

  return false
}

export function pruneExpired(access: Access): boolean {
  const now = Date.now()
  let removed = false

  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.expiresAt <= now) {
      delete access.pending[code]
      removed = true
    }
  }

  return removed
}

export function assertAllowedChat(chatId: string, access: Access): void {
  if (access.allowFrom.includes(chatId)) return
  if (chatId in access.groups) return
  throw new Error(`Chat ${chatId} is not allowed`)
}

export function assertSendable(filePath: string, stateDir: string): void {
  let resolved: string
  try {
    resolved = realpathSync(filePath)
  } catch {
    throw new Error(`File does not exist: ${filePath}`)
  }

  let resolvedStateDir: string
  try {
    resolvedStateDir = realpathSync(stateDir)
  } catch {
    // stateDir doesn't exist — file can't be inside it, so it's fine
    return
  }

  // Inside stateDir?
  if (resolved.startsWith(resolvedStateDir + '/') || resolved === resolvedStateDir) {
    // Must be inside inbox — only do realpathSync check if inbox exists
    let resolvedInbox: string
    const inboxPath = join(resolvedStateDir, 'inbox')
    if (!existsSync(inboxPath)) {
      // inbox doesn't exist, file can't be in it
      throw new Error(`File ${filePath} is inside state dir but not in inbox`)
    }
    try {
      resolvedInbox = realpathSync(inboxPath)
    } catch {
      throw new Error(`File ${filePath} is inside state dir but not in inbox`)
    }
    if (!resolved.startsWith(resolvedInbox + '/') && resolved !== resolvedInbox) {
      throw new Error(`File ${filePath} is inside state dir but not in inbox`)
    }
  }
  // Outside stateDir is fine
}

export function isUserAuthorized(userId: string, access: Access): boolean {
  return access.allowFrom.includes(userId)
}

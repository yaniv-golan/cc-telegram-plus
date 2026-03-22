import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot } from 'grammy'
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import type { Access, SessionManager } from './types.ts'

export type PermissionRequestParams = {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export interface PermissionRelay {
  handleRequest(params: PermissionRequestParams): void
  resolveByKey(key: string, behavior: 'allow' | 'deny'): Promise<'resolved' | 'not_found' | 'send_failed'>
  cleanup(): void
}

type PendingEntry = {
  requestId: string
  messageIds: { chatId: string; messageId: number }[]
  timer: ReturnType<typeof setTimeout>
}

const TTL_MS = 5 * 60 * 1000 // 5 minutes

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function generateKey(pending: Map<string, PendingEntry>): string {
  for (let i = 0; i < 10; i++) {
    const key = randomBytes(3).toString('hex')
    if (!pending.has(key)) return key
  }
  // Extremely unlikely fallback — use longer key
  return randomBytes(8).toString('hex')
}

export function createPermissionRelay(opts: {
  bot: Bot
  mcp: McpServer
  sessions: SessionManager
  loadAccess: () => Access
  stateDir: string
  sessionId: string
}): PermissionRelay {
  const { bot, mcp, sessions, loadAccess, stateDir, sessionId } = opts
  const pending = new Map<string, PendingEntry>()

  function editMessages(entry: PendingEntry, text: string): void {
    for (const { chatId, messageId } of entry.messageIds) {
      bot.api.editMessageText(chatId, messageId, text, {
        reply_markup: undefined,
      }).catch(() => {})
    }
  }

  function expireEntry(key: string): void {
    const entry = pending.get(key)
    if (!entry) return
    editMessages(entry, '\u23F0 Expired')
    pending.delete(key)
  }

  const relay: PermissionRelay = {
    handleRequest(params) {
      if (!sessions.isActive()) return

      const chatIds = loadAccess().allowFrom
      if (chatIds.length === 0) return

      const key = generateKey(pending)
      const text = [
        '\u26A0\uFE0F <b>Approval needed</b>',
        '',
        `<b>Tool:</b> ${escapeHtml(params.tool_name)}`,
        escapeHtml(params.description),
        '',
        `<pre>${escapeHtml(params.input_preview)}</pre>`,
      ].join('\n')

      const keyboard = [[
        { text: '\u2705 Allow', callback_data: `perm:allow:${key}` },
        { text: '\u274C Deny', callback_data: `perm:deny:${key}` },
      ]]

      const messageIds: { chatId: string; messageId: number }[] = []

      // Send to all allowFrom users, then store pending entry
      const sends = chatIds.map(chatId =>
        bot.api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard },
        }).then(msg => {
          messageIds.push({ chatId, messageId: msg.message_id })
        }).catch(() => {})
      )

      Promise.all(sends).then(() => {
        if (messageIds.length === 0) return

        const timer = setTimeout(() => expireEntry(key), TTL_MS)
        pending.set(key, { requestId: params.request_id, messageIds, timer })

        // Write activity entry (no sent_messages — so the watcher renders progress)
        const entry = JSON.stringify({
          type: 'permission',
          ts: new Date().toISOString(),
          session_id: sessionId,
        })
        try {
          appendFileSync(join(stateDir, 'activity.jsonl'), entry + '\n')
        } catch {}
      })
    },

    async resolveByKey(key, behavior) {
      const entry = pending.get(key)
      if (!entry) return 'not_found'

      // Await the notification so we only show success UI if the transport
      // accepted the bytes. On rejection, leave the pending entry intact
      // so expiry can clean it up.
      try {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: entry.requestId, behavior },
        })
      } catch (err) {
        process.stderr.write(`telegram channel: permission notification failed: ${err}\n`)
        return 'send_failed'
      }

      // Only update Telegram after successful send
      const resultText = behavior === 'allow' ? '\u2705 Allowed' : '\u274C Denied'
      editMessages(entry, resultText)

      clearTimeout(entry.timer)
      pending.delete(key)
      return 'resolved'
    },

    cleanup() {
      for (const [key, entry] of pending) {
        clearTimeout(entry.timer)
        editMessages(entry, '\u23F0 Session ended')
        pending.delete(key)
      }
    },
  }

  return relay
}

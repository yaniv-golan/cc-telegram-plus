import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot } from 'grammy'

type ActivityEntry = {
  ts: string
  session_id: string
  type: 'tool' | 'stop' | 'subagent_start' | 'subagent_stop' | 'permission'
  tool?: string
  detail?: string
  agent_type?: string
  message?: string
  sent_messages?: { chat_id: string; message_id: number }[]
}

function formatToolLine(entry: ActivityEntry): string | null {
  if (entry.type === 'tool') {
    const tool = entry.tool ?? ''
    const detail = entry.detail ?? ''

    switch (tool) {
      case 'Read': return `\u{1F4C4} Read ${detail}`
      case 'Edit': return `\u{270F}\u{FE0F} Edit ${detail}`
      case 'Write': return `\u{1F4DD} Write ${detail}`
      case 'Bash': return `\u{1F4BB} $ ${detail}`
      case 'Grep': return `\u{1F50D} grep ${detail}`
      case 'Glob': return `\u{1F50D} glob ${detail}`
      case 'Agent': return `\u{1F916} Agent: ${detail}`
      case 'WebSearch': return `\u{1F310} Search: ${detail}`
      case 'WebFetch': return `\u{1F310} Fetch: ${detail}`
      case 'LS': return `\u{1F4C2} ls ${detail}`
      case 'ToolSearch': return `\u{1F50D} ToolSearch`
      default: return `\u{1F527} ${tool}${detail ? ': ' + detail : ''}`
    }
  }
  if (entry.type === 'subagent_start') {
    return `\u{1F916} Subagent: ${entry.agent_type ?? 'working'}...`
  }
  if (entry.type === 'permission') {
    return `\u{26A0}\u{FE0F} Waiting for approval in terminal`
  }
  return null
}

export function startActivityWatcher(opts: {
  stateDir: string
  bot: Bot
  getChatIds: () => string[]
  isActive: () => boolean
}): { stop: () => void; clearProgress: () => void } {
  const activityFile = join(opts.stateDir, 'activity.jsonl')
  let lastSize = 0
  let progressMessageIds: Record<string, number> = {}
  let permissionMessageIds: { chat_id: string; message_id: number }[] = []
  let toolHistory: string[] = [] // accumulated tool lines for current turn
  let opChain: Promise<void> = Promise.resolve()

  try { readFileSync(activityFile) } catch {
    writeFileSync(activityFile, '')
  }

  // Skip to end on startup
  try { lastSize = readFileSync(activityFile, 'utf8').length } catch {}

  function deleteProgressMessages() {
    opChain = opChain.then(async () => {
      for (const [chatId, msgId] of Object.entries(progressMessageIds)) {
        await opts.bot.api.deleteMessage(chatId, msgId).catch(() => {})
      }
      for (const { chat_id, message_id } of permissionMessageIds) {
        await opts.bot.api.deleteMessage(chat_id, message_id).catch(() => {})
      }
      progressMessageIds = {}
      permissionMessageIds = []
      toolHistory = []
    })
  }

  function sendOrUpdateProgress() {
    const text = toolHistory.join('\n')
    if (!text) return

    const chatIds = opts.getChatIds()
    opChain = opChain.then(async () => {
      for (const chatId of chatIds) {
        const existingMsgId = progressMessageIds[chatId]
        if (existingMsgId) {
          await opts.bot.api.editMessageText(chatId, existingMsgId, text).catch(() => {})
        } else {
          try {
            const sent = await opts.bot.api.sendMessage(chatId, text)
            progressMessageIds[chatId] = sent.message_id
          } catch {}
        }
      }
    })
  }

  const check = () => {
    if (!opts.isActive()) return

    let content: string
    try { content = readFileSync(activityFile, 'utf8') } catch { return }
    if (content.length <= lastSize) return

    const newContent = content.slice(lastSize)
    lastSize = content.length

    const lines = newContent.trim().split('\n').filter(Boolean)
    let needsUpdate = false

    for (const line of lines) {
      let entry: ActivityEntry
      try { entry = JSON.parse(line) } catch { continue }

      // Stop — grace period then delete
      if (entry.type === 'stop' || entry.type === 'subagent_stop') {
        opChain = opChain.then(() => new Promise(r => setTimeout(r, 1500)))
        deleteProgressMessages()
        continue
      }

      // Track permission messages for cleanup
      if (entry.type === 'permission' && entry.sent_messages?.length) {
        permissionMessageIds.push(...entry.sent_messages)
        continue
      }

      const toolLine = formatToolLine(entry)
      if (!toolLine) continue

      // Avoid consecutive duplicates
      if (toolHistory.length > 0 && toolHistory[toolHistory.length - 1] === toolLine) continue

      toolHistory.push(toolLine)
      // Cap at 8 lines to keep message readable
      if (toolHistory.length > 8) toolHistory.shift()
      needsUpdate = true
    }

    if (needsUpdate) {
      sendOrUpdateProgress()
    }
  }

  const interval = setInterval(check, 500)

  return {
    stop: () => {
      clearInterval(interval)
      deleteProgressMessages()
    },
    clearProgress: () => {
      deleteProgressMessages()
    },
  }
}

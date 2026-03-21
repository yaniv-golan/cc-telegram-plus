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

function formatEntry(entry: ActivityEntry): string | null {
  if (entry.type === 'tool') {
    const tool = entry.tool ?? ''
    const detail = entry.detail ?? ''

    // Developer-friendly labels with as much context as possible
    switch (tool) {
      case 'Read':
        return `\u{1F4C4} Read ${detail}`
      case 'Edit':
        return `\u{270F}\u{FE0F} Edit ${detail}`
      case 'Write':
        return `\u{1F4DD} Write ${detail}`
      case 'Bash':
        return `\u{1F4BB} $ ${detail}`
      case 'Grep':
        return `\u{1F50D} grep ${detail}`
      case 'Glob':
        return `\u{1F50D} glob ${detail}`
      case 'Agent':
        return `\u{1F916} Agent: ${detail}`
      case 'WebSearch':
        return `\u{1F310} Search: ${detail}`
      case 'WebFetch':
        return `\u{1F310} Fetch: ${detail}`
      case 'LS':
        return `\u{1F4C2} ls ${detail}`
      case 'ToolSearch':
        return `\u{1F50D} ToolSearch`
      default:
        return `\u{1F527} ${tool}${detail ? ': ' + detail : ''}`
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
  let progressMessageIds: Record<string, number> = {} // chatId → msgId
  let permissionMessageIds: { chat_id: string; message_id: number }[] = [] // from hook
  let lastLabel = ''

  // Ensure file exists
  try { readFileSync(activityFile) } catch {
    writeFileSync(activityFile, '')
  }

  // Skip to end of file on startup (don't replay old events)
  try { lastSize = readFileSync(activityFile, 'utf8').length } catch {}

  function deleteProgressMessages() {
    for (const [chatId, msgId] of Object.entries(progressMessageIds)) {
      opts.bot.api.deleteMessage(chatId, msgId).catch(() => {})
    }
    for (const { chat_id, message_id } of permissionMessageIds) {
      opts.bot.api.deleteMessage(chat_id, message_id).catch(() => {})
    }
    progressMessageIds = {}
    permissionMessageIds = []
    lastLabel = ''
  }

  const check = () => {
    if (!opts.isActive()) return

    let content: string
    try {
      content = readFileSync(activityFile, 'utf8')
    } catch { return }

    if (content.length <= lastSize) return

    const newContent = content.slice(lastSize)
    lastSize = content.length

    const lines = newContent.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      let entry: ActivityEntry
      try { entry = JSON.parse(line) } catch { continue }

      // Stop event — delete all progress and permission messages
      if (entry.type === 'stop' || entry.type === 'subagent_stop') {
        deleteProgressMessages()
        continue
      }

      // Track permission messages sent by the hook for cleanup
      if (entry.type === 'permission' && entry.sent_messages?.length) {
        permissionMessageIds.push(...entry.sent_messages)
        continue // Already sent by hook script, don't send again
      }

      const label = formatEntry(entry)
      if (!label || label === lastLabel) continue
      lastLabel = label

      const chatIds = opts.getChatIds()
      for (const chatId of chatIds) {
        const existingMsgId = progressMessageIds[chatId]
        if (existingMsgId) {
          opts.bot.api.editMessageText(chatId, existingMsgId, label).catch(() => {})
        } else {
          opts.bot.api.sendMessage(chatId, label).then(
            (sent) => { progressMessageIds[chatId] = sent.message_id },
            () => {},
          )
        }
      }
    }
  }

  const interval = setInterval(check, 500)

  return {
    stop: () => {
      clearInterval(interval)
      deleteProgressMessages()
    },
    // Called by the reply tool to clear progress before sending the reply
    clearProgress: () => {
      deleteProgressMessages()
    },
  }
}

import { watchFile, unwatchFile, readFileSync, writeFileSync } from 'node:fs'
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
}

const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  Bash: 'Running',
  Grep: 'Searching',
  Glob: 'Finding files',
  Agent: 'Subagent',
  WebSearch: 'Searching web',
  WebFetch: 'Fetching',
}

function formatEntry(entry: ActivityEntry): string | null {
  if (entry.type === 'tool') {
    const verb = TOOL_LABELS[entry.tool ?? ''] ?? entry.tool ?? 'Working'
    const detail = entry.detail ? `: ${entry.detail}` : ''
    return `\u{1F504} ${verb}${detail}`
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
}): { stop: () => void } {
  const activityFile = join(opts.stateDir, 'activity.jsonl')
  let lastSize = 0
  let progressMessageIds: Record<string, number> = {} // chatId → msgId
  let lastLabel = ''

  // Ensure file exists
  try { readFileSync(activityFile) } catch {
    writeFileSync(activityFile, '')
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

      // Only the active session processes events (checked via isActive above)

      // Stop event — delete progress message
      if (entry.type === 'stop' || entry.type === 'subagent_stop') {
        for (const [chatId, msgId] of Object.entries(progressMessageIds)) {
          opts.bot.api.deleteMessage(chatId, msgId).catch(() => {})
        }
        progressMessageIds = {}
        lastLabel = ''
        continue
      }

      const label = formatEntry(entry)
      if (!label || label === lastLabel) continue
      lastLabel = label

      const chatIds = opts.getChatIds()
      for (const chatId of chatIds) {
        const existingMsgId = progressMessageIds[chatId]
        if (existingMsgId) {
          // Edit existing progress message
          opts.bot.api.editMessageText(chatId, existingMsgId, label).catch(() => {})
        } else {
          // Send new progress message
          opts.bot.api.sendMessage(chatId, label).then(
            (sent) => { progressMessageIds[chatId] = sent.message_id },
            () => {},
          )
        }
      }
    }
  }

  // Poll the file every 500ms (fs.watch is unreliable on macOS)
  const interval = setInterval(check, 500)

  return {
    stop: () => {
      clearInterval(interval)
      // Clean up progress messages
      for (const [chatId, msgId] of Object.entries(progressMessageIds)) {
        opts.bot.api.deleteMessage(chatId, msgId).catch(() => {})
      }
      progressMessageIds = {}
    },
  }
}

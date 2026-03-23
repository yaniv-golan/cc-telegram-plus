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

const TOOL_ICONS: Record<string, string> = {
  Read: '\u{1F4C4}',
  Edit: '\u{270F}\u{FE0F}',
  Write: '\u{1F4DD}',
  Bash: '\u{1F4BB}',
  Grep: '\u{1F50D}',
  Glob: '\u{1F50D}',
  Agent: '\u{1F916}',
  WebSearch: '\u{1F310}',
  WebFetch: '\u{1F310}',
  LS: '\u{1F4C2}',
  ToolSearch: '\u{1F50D}',
}

function truncateDetail(detail: string, maxLen: number): string {
  return detail.length > maxLen ? detail.slice(0, maxLen) + '...' : detail
}

function formatToolLine(entry: ActivityEntry, verbose: boolean = false): string | null {
  if (entry.type === 'tool') {
    const tool = entry.tool ?? ''
    const detail = entry.detail ?? ''
    const icon = TOOL_ICONS[tool] ?? '\u{1F527}'

    // Level 2 (verbose): show full detail, no truncation
    // Level 1: show short detail (truncate long paths/commands)
    const maxLen = verbose ? 200 : 60
    const d = truncateDetail(detail, maxLen)

    switch (tool) {
      case 'Bash': return `${icon} $ ${d}`
      case 'Grep': return `${icon} grep ${d}`
      case 'Glob': return `${icon} glob ${d}`
      case 'ToolSearch': return `${icon} ToolSearch`
      default: return `${icon} ${tool}${d ? ' ' + d : ''}`
    }
  }
  if (entry.type === 'subagent_start') {
    return `\u{1F916} Subagent: ${entry.agent_type ?? 'working'}...`
  }
  if (entry.type === 'permission') {
    return `\u{26A0}\u{FE0F} Awaiting approval`
  }
  return null
}

export function startActivityWatcher(opts: {
  stateDir: string
  bot: Bot
  getChatIds: () => string[]
  isActive: () => boolean
  getActivityLevel?: () => 0 | 1 | 2
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

  let toolCount = 0
  let turnStartTime = 0
  let toolNames: string[] = [] // per-tool names for level 2 summary

  function finalizeProgressMessages() {
    const level = opts.getActivityLevel?.() ?? 1
    if (level >= 2 && toolCount > 0) {
      // Keep the progress message with a per-tool summary
      const elapsed = ((Date.now() - turnStartTime) / 1000).toFixed(1)
      // Count tool usage: "Read ×3, Bash ×2, Edit ×1"
      const counts = new Map<string, number>()
      for (const name of toolNames) {
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      const parts = Array.from(counts.entries())
        .map(([name, count]) => count > 1 ? `${name} \u00D7${count}` : name)
      const summaryText = `\u2705 ${parts.join(', ')} (${elapsed}s)`
      opChain = opChain.then(async () => {
        for (const [chatId, msgId] of Object.entries(progressMessageIds)) {
          await opts.bot.api.editMessageText(chatId, msgId, summaryText).catch(() => {})
        }
        progressMessageIds = {}
        permissionMessageIds = []
        toolHistory = []
        toolCount = 0
        toolNames = []
      })
    } else {
      deleteProgressMessages()
      toolCount = 0
      toolNames = []
    }
  }

  const check = () => {
    if (!opts.isActive()) return

    const level = opts.getActivityLevel?.() ?? 1
    if (level === 0) return // silent mode

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

      // Stop — grace period then finalize
      if (entry.type === 'stop' || entry.type === 'subagent_stop') {
        opChain = opChain.then(() => new Promise(r => setTimeout(r, 1500)))
        finalizeProgressMessages()
        continue
      }

      // Track permission messages for cleanup
      if (entry.type === 'permission' && entry.sent_messages?.length) {
        permissionMessageIds.push(...entry.sent_messages)
        continue
      }

      const verbose = level >= 2
      const toolLine = formatToolLine(entry, verbose)
      if (!toolLine) continue

      if (toolCount === 0) turnStartTime = Date.now()
      toolCount++
      if (entry.type === 'tool' && entry.tool) toolNames.push(entry.tool)

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

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { withLock, isProcessAlive, INSTANCE_ID } from './lock.ts'
import type { Session, SessionManager, Access, InlineButton } from './types.ts'

type StateFile = {
  sessions: Record<string, Session>
  ackedMessages: string[]
  lastInbound: Record<string, string>
}

/**
 * Check if a session is still alive. PID alone is unreliable because macOS
 * aggressively reuses PIDs (especially for bun processes). We write a pidfile
 * containing the instanceId at registration; if the PID is alive but the
 * pidfile is missing or has a different instanceId, it's a reused PID.
 */
function isSessionAlive(session: Session, stateDir?: string): boolean {
  if (!isProcessAlive(session.pid)) return false
  if (!stateDir) return true // can't verify without stateDir, assume alive
  const pidfile = join(stateDir, `session-${session.pid}.pid`)
  try {
    const content = readFileSync(pidfile, 'utf8').trim()
    return content === session.instanceId
  } catch {
    // Pidfile missing — PID is alive but not our process
    return false
  }
}

function writePidfile(stateDir: string): void {
  writeFileSync(join(stateDir, `session-${process.pid}.pid`), INSTANCE_ID)
}

function removePidfile(stateDir: string): void {
  try { unlinkSync(join(stateDir, `session-${process.pid}.pid`)) } catch {}
}

function readState(stateDir: string): StateFile {
  const filePath = join(stateDir, 'sessions.json')
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return { sessions: {}, ackedMessages: [], lastInbound: {} }
  }
}

function writeState(stateDir: string, state: StateFile): void {
  const filePath = join(stateDir, 'sessions.json')
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(state, null, 2))
  renameSync(tmpPath, filePath)
}

function cleanStaleSessions(state: StateFile, opts?: {
  stateDir: string
  sendNotification: (chatId: string, text: string, keyboard?: InlineButton[][], parseMode?: string, pin?: boolean) => Promise<void>
  loadAccess: () => Access
}): { cleaned: boolean; activeRemoved: boolean } {
  let cleaned = false
  let activeRemoved = false
  const toRemove: string[] = []

  for (const [id, session] of Object.entries(state.sessions)) {
    if (!isSessionAlive(session, opts?.stateDir)) {
      toRemove.push(id)
      if (session.active) activeRemoved = true
    }
  }

  for (const id of toRemove) {
    const session = state.sessions[id]
    delete state.sessions[id]
    cleaned = true
    if (opts && session) {
      try { unlinkSync(join(opts.stateDir, `cache-${id}.json`)) } catch {}
      try { unlinkSync(join(opts.stateDir, `session-${session.pid}.pid`)) } catch {}
    }
  }

  if (activeRemoved) {
    // Promote earliest remaining session
    const remaining = Object.entries(state.sessions)
    if (remaining.length > 0) {
      remaining.sort(([, a], [, b]) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
      remaining[0][1].active = true
      const newActiveSession = remaining[0][1]
      if (opts) {
        for (const userId of opts.loadAccess().allowFrom) {
          void opts.sendNotification(userId, `Session switched to: ${newActiveSession.label} (previous session ended)`)
        }
      }
    }
  }

  return { cleaned, activeRemoved }
}

export function createSessionManager(opts: {
  stateDir: string
  startPolling: () => void
  stopPolling: () => void
  sendNotification: (chatId: string, text: string, keyboard?: InlineButton[][], parseMode?: string, pin?: boolean) => Promise<void>
  loadAccess: () => Access
  botUsername: string
  label: string
}): SessionManager {
  const { stateDir, startPolling, stopPolling, sendNotification, loadAccess, botUsername, label } = opts
  const lockPath = join(stateDir, 'sessions.lock')

  let sessionId: string = ''
  let watchInterval: ReturnType<typeof setInterval> | null = null
  let wasActive: boolean | null = null

  function lockedOp<T>(fn: (state: StateFile) => T): T {
    return withLock(lockPath, () => {
      const state = readState(stateDir)
      const result = fn(state)
      writeState(stateDir, state)
      return result
    })
  }

  const manager: SessionManager = {
    register(): string {
      sessionId = randomBytes(4).toString('hex')

      const notifyNewSession = lockedOp((state) => {
        // Clean stale before deciding active status
        cleanStaleSessions(state, { stateDir, sendNotification, loadAccess })

        const isFirst = Object.keys(state.sessions).length === 0

        // Find active session before registering (for notification)
        let activeSession: Session | null = null
        if (!isFirst) {
          for (const session of Object.values(state.sessions)) {
            if (session.active) { activeSession = session; break }
          }
        }

        state.sessions[sessionId] = {
          pid: process.pid,
          instanceId: INSTANCE_ID,
          label,
          startedAt: new Date().toISOString(),
          active: isFirst,
        }

        return activeSession
      })

      writePidfile(stateDir)

      if (notifyNewSession) {
        const access = loadAccess()
        const shortLabel = label.includes(' \u{2014} ') ? label.split(' \u{2014} ')[1] : label
        for (const userId of access.allowFrom) {
          void sendNotification(userId,
            `\u{1F7E2} <b>${notifyNewSession.label}</b>\n\u{26AA} <b>${label}</b> (new)`,
            [[{ text: shortLabel, callback_data: `switch_${sessionId}` }, { text: 'Keep', callback_data: 'switch_dismiss' }]],
            'HTML',
          )
        }
      }

      return sessionId
    },

    activate(): void {
      const active = manager.isActive()
      wasActive = active
      if (active) {
        startPolling()
        // Pin active session status (replaces any stale pin from a dead session)
        const access = loadAccess()
        for (const chatId of access.allowFrom) {
          sendNotification(chatId, `Active session: <b>${label}</b>`, undefined, 'HTML', true).catch(() => {})
        }
      }
      manager.watch()
    },

    isActive(): boolean {
      const state = readState(stateDir)
      const session = state.sessions[sessionId]
      return session?.active ?? false
    },

    watch(): void {
      if (watchInterval) return

      const checkState = async () => {
        const state = readState(stateDir)

        // Check for stale sessions and clean up under lock
        let needsCleanup = false
        for (const [, session] of Object.entries(state.sessions)) {
          if (!isSessionAlive(session, stateDir)) {
            needsCleanup = true
            break
          }
        }

        if (needsCleanup) {
          lockedOp((lockedState) => {
            cleanStaleSessions(lockedState, { stateDir, sendNotification, loadAccess })
          })
        }

        // Re-read after potential cleanup
        const freshState = readState(stateDir)
        const mySession = freshState.sessions[sessionId]
        if (!mySession) return

        const nowActive = mySession.active
        if (wasActive !== null && nowActive !== wasActive) {
          if (nowActive) {
            startPolling()
          } else {
            await stopPolling()
          }
        }
        wasActive = nowActive
      }

      watchInterval = setInterval(() => void checkState(), 3000)

      // SIGUSR1 = immediate wake-up from switchTo() in another process
      process.on('SIGUSR1', checkState)
    },

    stop(): void {
      if (watchInterval) {
        clearInterval(watchInterval)
        watchInterval = null
      }

      void stopPolling()

      lockedOp((state) => {
        delete state.sessions[sessionId]
      })

      removePidfile(stateDir)

      // Clean up cache file
      const cacheFile = join(stateDir, `cache-${sessionId}.json`)
      try {
        unlinkSync(cacheFile)
      } catch {
        // ignore if not exists
      }
    },

    async switchTo(targetId: string, opts?: { immediate?: boolean }): Promise<void> {
      // If this process is the active poller, stop polling BEFORE writing
      // the switch. This prevents a 409 race: Telegram rejects concurrent
      // getUpdates calls, and the old poller's grammY crashes on 409.
      // bot.stop() takes ~3s (waits for pending getUpdates to complete).
      if (opts?.immediate && wasActive) {
        await stopPolling()
        wasActive = false
      }

      let targetPid: number | null = null

      lockedOp((state) => {
        for (const [id, session] of Object.entries(state.sessions)) {
          session.active = id === targetId
          if (id === targetId) targetPid = session.pid
        }
      })

      // Signal the target process to wake up and start polling immediately.
      // Safe to do without delay because bot.stop() already completed above.
      if (targetPid && targetPid !== process.pid) {
        try { process.kill(targetPid, 'SIGUSR1') } catch {}
      }

      // Notify allowFrom users and pin the status message
      const access = loadAccess()
      const targetSession = readState(stateDir).sessions[targetId]
      const targetLabel = targetSession?.label ?? targetId
      for (const chatId of access.allowFrom) {
        sendNotification(chatId, `Active session: <b>${targetLabel}</b>`, undefined, 'HTML', true).catch(() => {})
      }
    },

    getAll(): Record<string, Session> {
      const state = readState(stateDir)

      // Check for stale sessions
      let needsCleanup = false
      for (const [, session] of Object.entries(state.sessions)) {
        if (!isProcessAlive(session.pid)) {
          needsCleanup = true
          break
        }
      }

      if (needsCleanup) {
        lockedOp((lockedState) => {
          cleanStaleSessions(lockedState, { stateDir, sendNotification, loadAccess })
        })
        return readState(stateDir).sessions
      }

      return state.sessions
    },

    getDeepLink(targetSessionId: string): string {
      return `https://t.me/${botUsername}?start=switch_${targetSessionId}`
    },

    addAckedMessage(chatId: string, messageId: number): void {
      lockedOp((state) => {
        const key = `${chatId}:${messageId}`
        state.ackedMessages.push(key)
        if (state.ackedMessages.length > 50) {
          state.ackedMessages = state.ackedMessages.slice(-50)
        }
      })
    },

    clearAckedMessages(chatId: string): number[] {
      return lockedOp((state) => {
        const prefix = `${chatId}:`
        const cleared: number[] = []
        const remaining: string[] = []

        for (const entry of state.ackedMessages) {
          if (entry.startsWith(prefix)) {
            cleared.push(parseInt(entry.slice(prefix.length), 10))
          } else {
            remaining.push(entry)
          }
        }

        state.ackedMessages = remaining
        return cleared
      })
    },

    getLastInbound(chatId: string): string | undefined {
      const state = readState(stateDir)
      return state.lastInbound[chatId]
    },

    setLastInbound(chatId: string, messageId: string): void {
      lockedOp((state) => {
        if (!state.lastInbound) state.lastInbound = {}
        state.lastInbound[chatId] = messageId
      })
    },

    renameSession(newLabel: string): void {
      lockedOp((state) => {
        const session = state.sessions[sessionId]
        if (session) session.label = newLabel
      })
    },
  }

  return manager
}

export function startApprovalPoller(opts: {
  stateDir: string
  sendNotification: (chatId: string, text: string) => Promise<void>
}): NodeJS.Timeout {
  const approvedDir = join(opts.stateDir, 'approved')
  try { mkdirSync(approvedDir, { recursive: true }) } catch {}

  const timer = setInterval(async () => {
    let entries: string[]
    try {
      entries = readdirSync(approvedDir)
    } catch {
      return
    }

    for (const entry of entries) {
      const filePath = join(approvedDir, entry)

      if (entry.endsWith('.claimed')) {
        // Check for orphaned .claimed files older than 30 seconds
        try {
          const stat = statSync(filePath)
          const age = Date.now() - stat.mtimeMs
          if (age > 30_000) {
            const unclaimedName = entry.replace(/\.claimed$/, '')
            const unclaimedPath = join(approvedDir, unclaimedName)
            try { renameSync(filePath, unclaimedPath) } catch {}
          }
        } catch {}
        continue
      }

      // Unclaimed file — try to claim it
      const claimedPath = filePath + '.claimed'
      try {
        renameSync(filePath, claimedPath)
      } catch {
        // Another session claimed it first (ENOENT) — skip
        continue
      }

      const senderId = entry
      try {
        await opts.sendNotification(senderId, 'Your pairing has been approved! You can now send messages.')
        // Success — delete the claimed file
        try { unlinkSync(claimedPath) } catch {}
      } catch {
        // DM send failed — rename back to unclaimed for retry
        try { renameSync(claimedPath, filePath) } catch {}
      }
    }
  }, 5000)

  return timer
}

export function stopApprovalPoller(timer: NodeJS.Timeout): void {
  clearInterval(timer)
}

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { withLock, isProcessAlive } from './lock.ts'
import type { Session, SessionManager, Access, InlineButton } from './types.ts'

const INSTANCE_ID = `${process.pid}-${Date.now()}`

type StateFile = {
  sessions: Record<string, Session>
  ackedMessages: string[]
  lastInbound: Record<string, string>
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
  sendNotification: (chatId: string, text: string, keyboard?: InlineButton[][]) => Promise<void>
  loadAccess: () => Access
}): { cleaned: boolean; activeRemoved: boolean } {
  let cleaned = false
  let activeRemoved = false
  const toRemove: string[] = []

  for (const [id, session] of Object.entries(state.sessions)) {
    if (!isProcessAlive(session.pid)) {
      toRemove.push(id)
      if (session.active) activeRemoved = true
    }
  }

  for (const id of toRemove) {
    delete state.sessions[id]
    cleaned = true
    if (opts) {
      try { unlinkSync(join(opts.stateDir, `cache-${id}.json`)) } catch {}
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
  sendNotification: (chatId: string, text: string, keyboard?: InlineButton[][]) => Promise<void>
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
      sessionId = randomBytes(8).toString('hex')

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

      if (notifyNewSession) {
        const access = loadAccess()
        for (const userId of access.allowFrom) {
          void sendNotification(userId,
            `New session started: ${label}\n\nCurrently active: ${notifyNewSession.label}`,
            [[{ text: `Switch to ${label}`, callback_data: `switch_${sessionId}` }, { text: 'Keep current', callback_data: 'switch_dismiss' }]]
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

      watchInterval = setInterval(() => {
        const state = readState(stateDir)

        // Check for stale sessions and clean up under lock
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
            stopPolling()
          }
        }
        wasActive = nowActive
      }, 3000)
    },

    stop(): void {
      if (watchInterval) {
        clearInterval(watchInterval)
        watchInterval = null
      }

      stopPolling()

      lockedOp((state) => {
        delete state.sessions[sessionId]
      })

      // Clean up cache file
      const cacheFile = join(stateDir, `cache-${sessionId}.json`)
      try {
        unlinkSync(cacheFile)
      } catch {
        // ignore if not exists
      }
    },

    switchTo(targetId: string): void {
      lockedOp((state) => {
        for (const [id, session] of Object.entries(state.sessions)) {
          session.active = id === targetId
        }
      })

      // Notify allowFrom users
      const access = loadAccess()
      const targetSession = readState(stateDir).sessions[targetId]
      const targetLabel = targetSession?.label ?? targetId
      for (const chatId of access.allowFrom) {
        sendNotification(chatId, `Switched active session to: ${targetLabel}`).catch(() => {})
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

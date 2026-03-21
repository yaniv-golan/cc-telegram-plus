import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSessionManager, startApprovalPoller, stopApprovalPoller } from '../src/sessions.ts'
import type { Access, InlineButton } from '../src/types.ts'

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
  return dir
}

/** Write a pidfile so isSessionAlive recognizes this PID as ours */
function writePidfile(stateDir: string, pid: number, instanceId: string): void {
  writeFileSync(join(stateDir, `session-${pid}.pid`), instanceId)
}

function makeOpts(stateDir: string, overrides: Record<string, any> = {}) {
  const calls: { method: string; args: any[] }[] = []

  return {
    opts: {
      stateDir,
      startPolling: () => { calls.push({ method: 'startPolling', args: [] }) },
      stopPolling: () => { calls.push({ method: 'stopPolling', args: [] }) },
      sendNotification: async (chatId: string, text: string, keyboard?: InlineButton[][]) => {
        calls.push({ method: 'sendNotification', args: [chatId, text, keyboard] })
      },
      loadAccess: (): Access => overrides.access ?? {
        dmPolicy: 'allowlist' as const,
        allowFrom: ['111', '222'],
        groups: {},
        pending: {},
      },
      botUsername: overrides.botUsername ?? 'testbot',
      label: overrides.label ?? 'test-session',
    },
    calls,
  }
}

function readStateFile(stateDir: string) {
  return JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'))
}

function writeStateFile(stateDir: string, state: any) {
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify(state))
}

describe('registration', () => {
  it('first session registers and claims active', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    const id = mgr.register()

    const state = readStateFile(dir)
    expect(state.sessions[id].active).toBe(true)
  })

  it('second session registers as inactive', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr1 = createSessionManager(opts)
    const id1 = mgr1.register()

    const { opts: opts2 } = makeOpts(dir, { label: 'second' })
    const mgr2 = createSessionManager(opts2)
    const id2 = mgr2.register()

    const state = readStateFile(dir)
    expect(state.sessions[id1].active).toBe(true)
    expect(state.sessions[id2].active).toBe(false)
  })

  it('register() returns a hex string ID', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    const id = mgr.register()

    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })

  it('session has instanceId field', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    const id = mgr.register()

    const state = readStateFile(dir)
    expect(state.sessions[id].instanceId).toMatch(/^\d+-\d+$/)
  })
})

describe('stale cleanup', () => {
  it('dead PID session removed on getAll', () => {
    const dir = makeTmp()
    // Write a session with a dead PID
    writeStateFile(dir, {
      sessions: {
        'dead-session': {
          pid: 999999,
          instanceId: '999999-0',
          label: 'dead',
          startedAt: new Date().toISOString(),
          active: false,
        },
      },
      ackedMessages: [],
      lastInbound: {},
    })

    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.register()

    const all = mgr.getAll()
    expect(all['dead-session']).toBeUndefined()
  })

  it('active session dies and first remaining takes over', () => {
    const dir = makeTmp()
    const now = Date.now()
    const aliveInstanceId = `${process.pid}-${now}`
    writeStateFile(dir, {
      sessions: {
        'dead-active': {
          pid: 999999,
          instanceId: '999999-0',
          label: 'dead-active',
          startedAt: new Date(now - 2000).toISOString(),
          active: true,
        },
        'alive-inactive': {
          pid: process.pid,
          instanceId: aliveInstanceId,
          label: 'alive',
          startedAt: new Date(now - 1000).toISOString(),
          active: false,
        },
      },
      ackedMessages: [],
      lastInbound: {},
    })
    writePidfile(dir, process.pid, aliveInstanceId)

    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    // getAll triggers stale cleanup
    const all = mgr.getAll()

    expect(all['dead-active']).toBeUndefined()
    expect(all['alive-inactive'].active).toBe(true)
  })
})

describe('shared state', () => {
  it('addAckedMessage + clearAckedMessages round-trip', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.register()

    mgr.addAckedMessage('chat1', 10)
    mgr.addAckedMessage('chat1', 20)
    mgr.addAckedMessage('chat2', 30)

    const cleared = mgr.clearAckedMessages('chat1')
    expect(cleared).toEqual([10, 20])

    // chat2 should still be there
    const state = readStateFile(dir)
    expect(state.ackedMessages).toEqual(['chat2:30'])
  })

  it('clearAckedMessages returns cleared IDs', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.register()

    mgr.addAckedMessage('c1', 5)
    mgr.addAckedMessage('c1', 15)

    const ids = mgr.clearAckedMessages('c1')
    expect(ids).toEqual([5, 15])
  })

  it('ackedMessages capped at 50', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.register()

    for (let i = 0; i < 60; i++) {
      mgr.addAckedMessage('chat', i)
    }

    const state = readStateFile(dir)
    expect(state.ackedMessages.length).toBe(50)
    // Should keep the last 50 (indices 10-59)
    expect(state.ackedMessages[0]).toBe('chat:10')
    expect(state.ackedMessages[49]).toBe('chat:59')
  })

  it('setLastInbound + getLastInbound round-trip', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.register()

    mgr.setLastInbound('chat1', '42')
    expect(mgr.getLastInbound('chat1')).toBe('42')

    // Non-existent chat returns undefined
    expect(mgr.getLastInbound('nope')).toBeUndefined()
  })
})

describe('watch and switch', () => {
  it('switchTo changes active session', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr1 = createSessionManager(opts)
    const id1 = mgr1.register()

    const { opts: opts2 } = makeOpts(dir, { label: 'second' })
    const mgr2 = createSessionManager(opts2)
    const id2 = mgr2.register()

    // id1 is active, id2 inactive
    expect(mgr1.isActive()).toBe(true)

    mgr1.switchTo(id2)

    const state = readStateFile(dir)
    expect(state.sessions[id1].active).toBe(false)
    expect(state.sessions[id2].active).toBe(true)
  })

  it('getDeepLink returns correct URL', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir, { botUsername: 'mybot' })
    const mgr = createSessionManager(opts)

    const link = mgr.getDeepLink('abc123')
    expect(link).toBe('https://t.me/mybot?start=switch_abc123')
  })
})

describe('stop', () => {
  it('stop() removes session from file', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    const id = mgr.register()

    expect(readStateFile(dir).sessions[id]).toBeDefined()

    mgr.stop()

    const state = readStateFile(dir)
    expect(state.sessions[id]).toBeUndefined()
  })

  it('stop() calls stopPolling', () => {
    const dir = makeTmp()
    const { opts, calls } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.register()

    mgr.stop()

    const stopCalls = calls.filter(c => c.method === 'stopPolling')
    expect(stopCalls.length).toBe(1)
  })

  it('stop() clears watch interval', () => {
    const dir = makeTmp()
    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.register()
    mgr.activate()

    // Watch is now running
    mgr.stop()

    // Verify no errors from cleared interval — if interval were still running
    // it would try to read a removed session. We confirm stop completes cleanly.
    const state = readStateFile(dir)
    expect(state.sessions).toEqual({})
  })
})

describe('approval poller', () => {
  it('processes unclaimed file', async () => {
    const dir = makeTmp()
    const approvedDir = join(dir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    writeFileSync(join(approvedDir, '123'), '')

    const notifications: { chatId: string; text: string }[] = []
    const timer = startApprovalPoller({
      stateDir: dir,
      sendNotification: async (chatId, text) => {
        notifications.push({ chatId, text })
      },
    })

    // Wait for poller to run
    await new Promise(r => setTimeout(r, 6000))
    stopApprovalPoller(timer)

    expect(notifications.length).toBe(1)
    expect(notifications[0].chatId).toBe('123')
    expect(notifications[0].text).toContain('approved')
    expect(existsSync(join(approvedDir, '123'))).toBe(false)
    expect(existsSync(join(approvedDir, '123.claimed'))).toBe(false)
  }, 10000)

  it('skips on send failure and retries', async () => {
    const dir = makeTmp()
    const approvedDir = join(dir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    writeFileSync(join(approvedDir, '456'), '')

    let callCount = 0
    const timer = startApprovalPoller({
      stateDir: dir,
      sendNotification: async () => {
        callCount++
        throw new Error('DM send failed')
      },
    })

    // Wait for poller to run once
    await new Promise(r => setTimeout(r, 6000))
    stopApprovalPoller(timer)

    // File should be renamed back to unclaimed for retry
    expect(existsSync(join(approvedDir, '456'))).toBe(true)
    expect(existsSync(join(approvedDir, '456.claimed'))).toBe(false)
    expect(callCount).toBeGreaterThanOrEqual(1)
  }, 10000)

  it('recovers orphaned .claimed file', async () => {
    const dir = makeTmp()
    const approvedDir = join(dir, 'approved')
    mkdirSync(approvedDir, { recursive: true })

    const claimedPath = join(approvedDir, '789.claimed')
    writeFileSync(claimedPath, '')
    // Set mtime to 60 seconds ago
    const oldTime = new Date(Date.now() - 60_000)
    utimesSync(claimedPath, oldTime, oldTime)

    const timer = startApprovalPoller({
      stateDir: dir,
      sendNotification: async () => {},
    })

    await new Promise(r => setTimeout(r, 6000))
    stopApprovalPoller(timer)

    // Should be renamed back to unclaimed
    expect(existsSync(join(approvedDir, '789'))).toBe(true)
    expect(existsSync(join(approvedDir, '789.claimed'))).toBe(false)
  }, 10000)
})

describe('notifications', () => {
  it('new session notification sent to allowFrom', async () => {
    const dir = makeTmp()
    const { opts, calls } = makeOpts(dir, { label: 'first' })
    const mgr1 = createSessionManager(opts)
    mgr1.register()

    const { opts: opts2, calls: calls2 } = makeOpts(dir, { label: 'second' })
    const mgr2 = createSessionManager(opts2)
    mgr2.register()

    // Wait for async notifications to fire
    await new Promise(r => setTimeout(r, 100))

    const notifCalls = calls2.filter(c => c.method === 'sendNotification')
    expect(notifCalls.length).toBe(2)
    expect(notifCalls[0].args[0]).toBe('111')
    expect(notifCalls[0].args[1]).toContain('New session: second')
    expect(notifCalls[0].args[1]).toContain('Active: first')
    expect(notifCalls[1].args[0]).toBe('222')
  })

  it('failover notification sent', async () => {
    const dir = makeTmp()
    const now = Date.now()
    const aliveInstanceId = `${process.pid}-${now}`
    writeStateFile(dir, {
      sessions: {
        'dead-active': {
          pid: 999999,
          instanceId: '999999-0',
          label: 'dead-active',
          startedAt: new Date(now - 2000).toISOString(),
          active: true,
        },
        'alive-inactive': {
          pid: process.pid,
          instanceId: aliveInstanceId,
          label: 'alive',
          startedAt: new Date(now - 1000).toISOString(),
          active: false,
        },
      },
      ackedMessages: [],
      lastInbound: {},
    })
    writePidfile(dir, process.pid, aliveInstanceId)

    const { opts, calls } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.getAll()

    // Wait for async notifications
    await new Promise(r => setTimeout(r, 100))

    const notifCalls = calls.filter(c => c.method === 'sendNotification')
    expect(notifCalls.length).toBe(2)
    expect(notifCalls[0].args[1]).toContain('Session switched to: alive')
    expect(notifCalls[0].args[1]).toContain('previous session ended')
  })

  it('dead session cache file deleted', () => {
    const dir = makeTmp()
    const now = Date.now()

    // Write a cache file for the dead session
    writeFileSync(join(dir, 'cache-dead-session.json'), '{}')

    writeStateFile(dir, {
      sessions: {
        'dead-session': {
          pid: 999999,
          instanceId: '999999-0',
          label: 'dead',
          startedAt: new Date(now - 2000).toISOString(),
          active: false,
        },
      },
      ackedMessages: [],
      lastInbound: {},
    })

    const { opts } = makeOpts(dir)
    const mgr = createSessionManager(opts)
    mgr.register()

    // Cache file for dead session should be cleaned up
    expect(existsSync(join(dir, 'cache-dead-session.json'))).toBe(false)
  })
})

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Access } from './types.ts'
import { withLock } from './lock.ts'

const DEFAULT_ACCESS: Access = {
  dmPolicy: 'pairing',
  allowFrom: [],
  groups: {},
  pending: {},
}

const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

export function createAccessIO(stateDir: string): {
  loadAccess: () => Access
  saveAccess: (access: Access) => void
  withAccessLock: <T>(fn: () => T) => T
  isStatic: boolean
} {
  function readAccessFile(): Access {
    try {
      const raw = readFileSync(join(stateDir, 'access.json'), 'utf8')
      return JSON.parse(raw) as Access
    } catch {
      return { ...DEFAULT_ACCESS, allowFrom: [], groups: {}, pending: {} }
    }
  }

  // In static mode, snapshot at boot and never re-read or write
  let bootSnapshot: Access | null = null
  if (STATIC) {
    const a = readAccessFile()
    if (a.dmPolicy === 'pairing') {
      process.stderr.write(
        'telegram channel: static mode — dmPolicy "pairing" downgraded to "allowlist"\n',
      )
      a.dmPolicy = 'allowlist'
    }
    a.pending = {}
    bootSnapshot = a
  }

  function loadAccess(): Access {
    if (bootSnapshot) {
      // Deep clone so callers can't mutate the snapshot
      return JSON.parse(JSON.stringify(bootSnapshot))
    }
    return readAccessFile()
  }

  function saveAccess(access: Access): void {
    if (STATIC) return // silent no-op
    mkdirSync(stateDir, { recursive: true })
    const tmpPath = join(stateDir, 'access.tmp.json')
    const finalPath = join(stateDir, 'access.json')
    writeFileSync(tmpPath, JSON.stringify(access, null, 2))
    renameSync(tmpPath, finalPath)
  }

  function withAccessLock<T>(fn: () => T): T {
    return withLock(join(stateDir, 'access.lock'), fn)
  }

  return { loadAccess, saveAccess, withAccessLock, isStatic: STATIC }
}

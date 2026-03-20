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

export function createAccessIO(stateDir: string): {
  loadAccess: () => Access
  saveAccess: (access: Access) => void
  withAccessLock: <T>(fn: () => T) => T
} {
  function loadAccess(): Access {
    try {
      const raw = readFileSync(join(stateDir, 'access.json'), 'utf8')
      return JSON.parse(raw) as Access
    } catch {
      return { ...DEFAULT_ACCESS, allowFrom: [], groups: {}, pending: {} }
    }
  }

  function saveAccess(access: Access): void {
    mkdirSync(stateDir, { recursive: true })
    const tmpPath = join(stateDir, 'access.tmp.json')
    const finalPath = join(stateDir, 'access.json')
    writeFileSync(tmpPath, JSON.stringify(access, null, 2))
    renameSync(tmpPath, finalPath)
  }

  function withAccessLock<T>(fn: () => T): T {
    return withLock(join(stateDir, 'access.lock'), fn)
  }

  return { loadAccess, saveAccess, withAccessLock }
}

import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// Generated once at module load — survives PID reuse detection
export const INSTANCE_ID = `${process.pid}-${Date.now()}`

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function withLock<T>(lockDir: string, fn: () => T, opts?: { maxWait?: number }): T {
  const maxWait = opts?.maxWait ?? 5000
  const deadline = Date.now() + maxWait

  while (true) {
    try {
      mkdirSync(lockDir)
      // Acquired — write owner file immediately
      writeFileSync(join(lockDir, 'owner'), `${process.pid}\n${INSTANCE_ID}`)
      break
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err

      // Lock already exists — inspect it
      let ownerContent: string | null = null
      try {
        ownerContent = readFileSync(join(lockDir, 'owner'), 'utf8')
      } catch {
        // Owner file missing — check how old the lock dir is
        let dirMtime: number
        try {
          dirMtime = statSync(lockDir).mtimeMs
        } catch {
          // Lock dir disappeared between our mkdir failure and stat — retry
          continue
        }

        const age = Date.now() - dirMtime
        if (age < 2000) {
          // Owner is about to write — wait
          if (Date.now() >= deadline) throw new Error('session lock timeout')
          Bun.sleepSync(50)
          continue
        } else {
          // Orphaned lock — break it
          try { rmSync(lockDir, { recursive: true }) } catch { /* ignore race */ }
          continue
        }
      }

      // Parse owner file
      const [pidStr] = ownerContent.trim().split('\n')
      const ownerPid = parseInt(pidStr, 10)

      if (!isNaN(ownerPid) && isProcessAlive(ownerPid)) {
        // Owner is alive — spin wait
        if (Date.now() >= deadline) throw new Error('session lock timeout')
        Bun.sleepSync(50)
      } else {
        // Owner is dead — break stale lock
        try { rmSync(lockDir, { recursive: true }) } catch { /* ignore race */ }
      }
    }
  }

  try {
    return fn()
  } finally {
    try { rmSync(lockDir, { recursive: true }) } catch { /* ignore */ }
  }
}

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { withLock, isProcessAlive } from '../src/lock.ts'

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'lock-test-'))
}

describe('withLock', () => {
  it('acquires lock, runs fn, releases lock — lock dir does not exist after', () => {
    const base = makeTmp()
    const lockDir = join(base, 'test.lock')

    withLock(lockDir, () => {
      expect(existsSync(lockDir)).toBe(true)
    })

    expect(existsSync(lockDir)).toBe(false)
  })

  it('passes through the return value of fn', () => {
    const base = makeTmp()
    const lockDir = join(base, 'test.lock')

    const result = withLock(lockDir, () => 42)
    expect(result).toBe(42)
  })

  it('breaks a stale lock with a dead PID', () => {
    const base = makeTmp()
    const lockDir = join(base, 'stale.lock')

    // Simulate a stale lock held by dead PID 999999
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `999999\n999999-0`)

    const result = withLock(lockDir, () => 'ran')
    expect(result).toBe('ran')
    expect(existsSync(lockDir)).toBe(false)
  })

  it('breaks an orphaned lock dir with no owner file and mtime > 2s ago', () => {
    const base = makeTmp()
    const lockDir = join(base, 'orphan.lock')

    // Create lock dir with no owner file and backdated mtime
    mkdirSync(lockDir)
    const oldTime = new Date(Date.now() - 5000)
    utimesSync(lockDir, oldTime, oldTime)

    const result = withLock(lockDir, () => 'ok')
    expect(result).toBe('ok')
    expect(existsSync(lockDir)).toBe(false)
  })

  it('throws Error("session lock timeout") after maxWait when lock is held', () => {
    const base = makeTmp()
    const lockDir = join(base, 'held.lock')

    // Simulate a lock held by the current process (alive)
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid}\nsome-instance-id`)

    expect(() => withLock(lockDir, () => {}, { maxWait: 200 })).toThrow('session lock timeout')

    // Clean up manually
    import('fs').then(({ rmSync }) => rmSync(lockDir, { recursive: true }))
  })

  it('releases lock even if fn throws', () => {
    const base = makeTmp()
    const lockDir = join(base, 'throw.lock')

    expect(() =>
      withLock(lockDir, () => {
        throw new Error('fn error')
      })
    ).toThrow('fn error')

    expect(existsSync(lockDir)).toBe(false)
  })
})

describe('isProcessAlive', () => {
  it('returns true for the current process pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns false for PID 999999', () => {
    expect(isProcessAlive(999999)).toBe(false)
  })
})

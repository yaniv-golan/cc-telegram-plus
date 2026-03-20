import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCache } from '../src/cache.ts'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cache-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('createCache()', () => {
  it('set + get returns stored content', () => {
    const cache = createCache(join(tmpDir, 'cache.json'))
    cache.set('chat1', 'msg1', 'hello world')
    expect(cache.get('chat1', 'msg1')).toBe('hello world')
  })

  it('content is truncated to 200 chars on set', () => {
    const cache = createCache(join(tmpDir, 'cache.json'))
    const long = 'x'.repeat(300)
    cache.set('chat1', 'msg1', long)
    expect(cache.get('chat1', 'msg1')).toBe('x'.repeat(200))
  })

  it('FIFO eviction at max entries (maxEntries=3)', () => {
    const cache = createCache(join(tmpDir, 'cache.json'), 3)
    cache.set('chat1', 'msg1', 'first')
    cache.set('chat1', 'msg2', 'second')
    cache.set('chat1', 'msg3', 'third')
    // Adding a 4th entry should evict the first (FIFO)
    cache.set('chat1', 'msg4', 'fourth')
    expect(cache.get('chat1', 'msg1')).toBeUndefined()
    expect(cache.get('chat1', 'msg2')).toBe('second')
    expect(cache.get('chat1', 'msg3')).toBe('third')
    expect(cache.get('chat1', 'msg4')).toBe('fourth')
  })

  it('get for unknown key returns undefined', () => {
    const cache = createCache(join(tmpDir, 'cache.json'))
    expect(cache.get('chat1', 'nonexistent')).toBeUndefined()
  })

  it('flush writes to disk, new createCache loads it back', () => {
    const filePath = join(tmpDir, 'cache.json')
    const cache = createCache(filePath)
    cache.set('chat1', 'msg1', 'persisted content')
    cache.flush()

    const cache2 = createCache(filePath)
    expect(cache2.get('chat1', 'msg1')).toBe('persisted content')
  })

  it('missing cache file on load → empty cache, no throw', () => {
    const filePath = join(tmpDir, 'nonexistent.json')
    expect(() => {
      const cache = createCache(filePath)
      expect(cache.get('chat1', 'msg1')).toBeUndefined()
    }).not.toThrow()
  })

  it('corrupt JSON file on load → empty cache, no throw', () => {
    const filePath = join(tmpDir, 'corrupt.json')
    writeFileSync(filePath, 'not valid json }{')
    expect(() => {
      const cache = createCache(filePath)
      expect(cache.get('chat1', 'msg1')).toBeUndefined()
    }).not.toThrow()
  })

  it('destroy deletes the cache file', () => {
    const filePath = join(tmpDir, 'cache.json')
    const cache = createCache(filePath)
    cache.set('chat1', 'msg1', 'some content')
    cache.flush()
    expect(existsSync(filePath)).toBe(true)
    cache.destroy()
    expect(existsSync(filePath)).toBe(false)
  })

  it('atomic write: tmp file does not remain after flush', () => {
    const filePath = join(tmpDir, 'cache.json')
    const cache = createCache(filePath)
    cache.set('chat1', 'msg1', 'data')
    cache.flush()
    expect(existsSync(filePath + '.tmp')).toBe(false)
    expect(existsSync(filePath)).toBe(true)
  })

  it('per-session isolation: two caches with different paths do not interfere', () => {
    const filePath1 = join(tmpDir, 'cache1.json')
    const filePath2 = join(tmpDir, 'cache2.json')
    const cache1 = createCache(filePath1)
    const cache2 = createCache(filePath2)

    cache1.set('chat1', 'msg1', 'from cache1')
    cache2.set('chat1', 'msg1', 'from cache2')

    expect(cache1.get('chat1', 'msg1')).toBe('from cache1')
    expect(cache2.get('chat1', 'msg1')).toBe('from cache2')

    cache1.flush()
    const reloaded1 = createCache(filePath1)
    expect(reloaded1.get('chat1', 'msg1')).toBe('from cache1')

    // cache2 data only in its own file
    const reloaded2 = createCache(filePath2)
    expect(reloaded2.get('chat1', 'msg1')).toBeUndefined() // not flushed
  })
})

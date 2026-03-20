import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MessageCache } from './types.ts'

const MAX_CONTENT_LENGTH = 200

export function createCache(filePath: string, maxEntries: number = 500): MessageCache {
  const map = new Map<string, string>()

  // Load from disk on construction
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as { version: number; entries: [string, string][] }
    if (data && Array.isArray(data.entries)) {
      for (const [key, value] of data.entries) {
        map.set(key, value)
      }
    }
  } catch {
    // Missing file or corrupt JSON → start with empty cache
  }

  return {
    get(chatId: string, messageId: string): string | undefined {
      return map.get(`${chatId}:${messageId}`)
    },

    set(chatId: string, messageId: string, content: string): void {
      const key = `${chatId}:${messageId}`
      const truncated = content.slice(0, MAX_CONTENT_LENGTH)
      map.set(key, truncated)
      // FIFO eviction: if over max, delete the oldest (first) entry
      if (map.size > maxEntries) {
        const firstKey = map.keys().next().value
        if (firstKey !== undefined) {
          map.delete(firstKey)
        }
      }
    },

    flush(): void {
      mkdirSync(dirname(filePath), { recursive: true })
      const entries = Array.from(map.entries())
      const data = JSON.stringify({ version: 1, entries })
      const tmpPath = `${filePath}.tmp`
      writeFileSync(tmpPath, data, 'utf-8')
      renameSync(tmpPath, filePath)
    },

    destroy(): void {
      try {
        unlinkSync(filePath)
      } catch {
        // File may not exist — ignore
      }
    },
  }
}

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { MediaToken } from './types.ts'

const VALID_TYPES = new Set(['photo', 'document', 'video', 'audio', 'voice', 'sticker'])

// ─── parseMediaToken ──────────────────────────────────────────────────────────

export function parseMediaToken(token: string): MediaToken {
  if (!token) {
    throw new Error('parseMediaToken: empty string')
  }

  const parts = token.split(':')
  if (parts.length !== 3) {
    throw new Error(`parseMediaToken: expected 3 colon-separated parts, got ${parts.length} in "${token}"`)
  }

  const [type, fileId, fileUniqueId] = parts

  if (!VALID_TYPES.has(type)) {
    throw new Error(`parseMediaToken: unknown media type "${type}"`)
  }

  return {
    type: type as MediaToken['type'],
    fileId,
    fileUniqueId,
  }
}

// ─── downloadMedia ────────────────────────────────────────────────────────────

const RETRY_DELAYS = [1000, 2000]
const MAX_JITTER = 200

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function downloadMedia(
  bot: any,
  token: MediaToken,
  stateDir: string,
): Promise<string> {
  const { file_path } = await bot.api.getFile(token.fileId)

  const ext = file_path?.includes('.') ? file_path.split('.').pop() ?? 'bin' : 'bin'
  const filename = `${Date.now()}-${token.fileUniqueId}.${ext}`
  const inboxDir = path.join(stateDir, 'inbox')

  fs.mkdirSync(inboxDir, { recursive: true })

  const url = `https://api.telegram.org/file/bot${bot.token}/${file_path}`
  const destPath = path.join(inboxDir, filename)

  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const baseDelay = RETRY_DELAYS[attempt - 1] ?? 2000
      const jitter = Math.floor(Math.random() * MAX_JITTER)
      await sleep(baseDelay + jitter)
    }
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`downloadMedia: HTTP ${response.status} ${response.statusText}`)
      }
      const buffer = await response.arrayBuffer()
      fs.writeFileSync(destPath, Buffer.from(buffer))
      return destPath
    } catch (err) {
      lastError = err
    }
  }

  throw lastError
}

// ─── transcribeAudio ──────────────────────────────────────────────────────────

export async function transcribeAudio(buffer: Buffer, apiKey: string): Promise<string> {
  const formData = new FormData()
  const blob = new Blob([buffer], { type: 'audio/ogg' })
  formData.append('file', blob, 'voice.ogg')
  formData.append('model', 'whisper-1')

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  })

  if (!response.ok) {
    throw new Error(`transcribeAudio: HTTP ${response.status} ${response.statusText}`)
  }

  const result = await response.json()
  return result.text
}

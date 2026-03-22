import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'

export type AskOption = {
  label: string
  description: string
}

export type AskPending = {
  nonce: string
  chatId: string
  sentMessageId: number
  options: AskOption[] | null
  ts: number
}

export type AskReply = {
  nonce: string
  answer: string
  userId: string
  ts: number
}

export const ASK_PENDING_MAX_AGE_MS = 3_700_000 // ~61 min, just over 3600s hook timeout

export function readAskPending(stateDir: string): AskPending | null {
  try {
    const raw = readFileSync(join(stateDir, 'ask-pending.json'), 'utf8')
    const pending = JSON.parse(raw) as AskPending
    // Auto-expire stale pending files to prevent chat wedging after hook timeout
    if (Date.now() - pending.ts > ASK_PENDING_MAX_AGE_MS) {
      try { unlinkSync(join(stateDir, 'ask-pending.json')) } catch {}
      return null
    }
    return pending
  } catch {
    return null
  }
}

export function writeAskPending(stateDir: string, pending: AskPending): void {
  const tmpPath = join(stateDir, 'ask-pending.tmp.json')
  const finalPath = join(stateDir, 'ask-pending.json')
  writeFileSync(tmpPath, JSON.stringify(pending))
  renameSync(tmpPath, finalPath)
}

export function readAskReply(stateDir: string): AskReply | null {
  try {
    const raw = readFileSync(join(stateDir, 'ask-reply.json'), 'utf8')
    return JSON.parse(raw) as AskReply
  } catch {
    return null
  }
}

export function writeAskReply(stateDir: string, reply: AskReply): void {
  const tmpPath = join(stateDir, 'ask-reply.tmp.json')
  const finalPath = join(stateDir, 'ask-reply.json')
  writeFileSync(tmpPath, JSON.stringify(reply))
  renameSync(tmpPath, finalPath)
}

export function deleteAskPending(stateDir: string): void {
  try { unlinkSync(join(stateDir, 'ask-pending.json')) } catch {}
}

export function deleteAskFiles(stateDir: string): void {
  try { unlinkSync(join(stateDir, 'ask-pending.json')) } catch {}
  try { unlinkSync(join(stateDir, 'ask-reply.json')) } catch {}
}

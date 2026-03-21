import type { Bot } from 'grammy'
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'pair'; code: string; senderId: string; chatId: string; updatedAccess: Access }
  | { action: 'drop' }

export type MediaToken = {
  type: 'photo' | 'document' | 'video' | 'audio' | 'voice' | 'sticker'
  fileId: string
  fileUniqueId: string
}

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }

export type Session = {
  pid: number
  instanceId: string      // "${pid}-${Date.now()}" — survives PID reuse
  label: string
  startedAt: string       // ISO 8601
  active: boolean
}

export interface MessageCache {
  get(chatId: string, messageId: string): string | undefined
  set(chatId: string, messageId: string, content: string): void
  flush(): void
  destroy(): void
}

export interface SessionManager {
  register(): string
  isActive(): boolean
  watch(): void
  stop(): void
  activate(): void
  switchTo(sessionId: string): void
  getAll(): Record<string, Session>
  getDeepLink(sessionId: string): string
  addAckedMessage(chatId: string, messageId: number): void
  clearAckedMessages(chatId: string): number[]
  getLastInbound(chatId: string): string | undefined
  setLastInbound(chatId: string, messageId: string): void
  renameSession(newLabel: string): void
}

export type Deps = {
  bot: Bot
  mcp: McpServer
  cache: MessageCache
  sessions: SessionManager
  loadAccess: () => Access
  saveAccess: (access: Access) => void
  withAccessLock: <T>(fn: () => T) => T
  stateDir: string
  botUsername: string
  transcribe?: (buf: Buffer) => Promise<string>
}

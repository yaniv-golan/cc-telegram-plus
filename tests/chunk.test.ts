import { describe, it, expect } from 'bun:test'
import { chunk } from '../src/chunk.ts'

describe('chunk()', () => {
  it('short text (< limit) returns single chunk', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  it('empty string returns single chunk with empty string', () => {
    expect(chunk('', 100, 'length')).toEqual([''])
  })

  it('text exactly at limit returns single chunk', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  it('long text in length mode splits at limit boundary, all chunks <= limit', () => {
    const limit = 10
    const text = 'abcdefghijklmnopqrstuvwxyz' // 26 chars
    const result = chunk(text, limit, 'length')
    expect(result.length).toBeGreaterThan(1)
    for (const ch of result) {
      expect(ch.length).toBeLessThanOrEqual(limit)
    }
    expect(result.join('')).toBe(text)
    // Verify exact split points
    expect(result[0]).toBe('abcdefghij')
    expect(result[1]).toBe('klmnopqrst')
    expect(result[2]).toBe('uvwxyz')
  })

  it('long text in newline mode splits at \\n\\n boundary', () => {
    const part1 = 'a'.repeat(8)
    const part2 = 'b'.repeat(8)
    const text = part1 + '\n\n' + part2 // 18 chars with \n\n
    const result = chunk(text, 12, 'newline')
    expect(result.length).toBe(2)
    expect(result[0]).toBe(part1)
    expect(result[1]).toBe(part2)
  })

  it('newline mode with no \\n\\n falls back to \\n boundary', () => {
    const part1 = 'hello'
    const part2 = 'world'
    const text = part1 + '\n' + part2 // 11 chars
    const result = chunk(text, 8, 'newline')
    expect(result.length).toBe(2)
    expect(result[0]).toBe(part1)
    expect(result[1]).toBe(part2)
  })

  it('newline mode with no newlines falls back to hard cut at limit', () => {
    const text = 'abcdefghijklmnop' // 16 chars, no newlines
    const result = chunk(text, 10, 'newline')
    expect(result.length).toBe(2)
    expect(result[0]).toBe('abcdefghij')
    expect(result[1]).toBe('klmnop')
  })

  it('limit > 4096 is clamped to 4096', () => {
    const text = 'x'.repeat(4097)
    const result = chunk(text, 5000, 'length')
    expect(result.length).toBe(2)
    expect(result[0].length).toBe(4096)
    expect(result[1].length).toBe(1)
  })

  it('multiple chunks needed when text is 3x the limit', () => {
    const limit = 10
    const text = 'a'.repeat(30)
    const result = chunk(text, limit, 'length')
    expect(result.length).toBe(3)
    for (const ch of result) {
      expect(ch.length).toBeLessThanOrEqual(limit)
    }
    expect(result.join('')).toBe(text)
  })
})

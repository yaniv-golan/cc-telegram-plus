import { describe, it, expect } from 'bun:test'
import { safeName } from '../src/handlers.ts'

describe('safeName()', () => {
  it('safeName(undefined) returns undefined', () => {
    expect(safeName(undefined)).toBeUndefined()
  })

  it("safeName('report.pdf') returns 'report.pdf' (clean names pass through)", () => {
    expect(safeName('report.pdf')).toBe('report.pdf')
  })

  it("safeName('file<script>.txt') returns 'file_script_.txt' (strips angle brackets)", () => {
    expect(safeName('file<script>.txt')).toBe('file_script_.txt')
  })

  it("safeName('file[0].txt') returns 'file_0_.txt' (strips square brackets)", () => {
    expect(safeName('file[0].txt')).toBe('file_0_.txt')
  })

  it("safeName('file\\r\\nname.txt') returns 'file__name.txt' (strips newlines)", () => {
    expect(safeName('file\r\nname.txt')).toBe('file__name.txt')
  })

  it("safeName('file;name.txt') returns 'file_name.txt' (strips semicolons)", () => {
    expect(safeName('file;name.txt')).toBe('file_name.txt')
  })
})

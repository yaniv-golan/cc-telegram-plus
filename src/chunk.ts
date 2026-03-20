const TELEGRAM_LIMIT = 4096

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  const effectiveLimit = Math.min(limit, TELEGRAM_LIMIT)

  if (text.length <= effectiveLimit) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > effectiveLimit) {
    let splitAt: number

    if (mode === 'newline') {
      // Search backward from effectiveLimit for \n\n
      const doubleNl = remaining.lastIndexOf('\n\n', effectiveLimit - 1)
      if (doubleNl > 0) {
        splitAt = doubleNl
        chunks.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt + 2) // skip the \n\n
        continue
      }

      // Fall back to single \n
      const singleNl = remaining.lastIndexOf('\n', effectiveLimit - 1)
      if (singleNl > 0) {
        splitAt = singleNl
        chunks.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt + 1) // skip the \n
        continue
      }
    }

    // Hard cut (length mode, or newline mode with no newlines found)
    chunks.push(remaining.slice(0, effectiveLimit))
    remaining = remaining.slice(effectiveLimit)
  }

  chunks.push(remaining)
  return chunks
}

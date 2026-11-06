/**
 * Text a child process wrote, decoded by the encoding it actually used.
 *
 * A Windows console gives a child process the console code page, and a
 * Chinese system is 936 (GBK): `cmd.exe` says "不是内部或外部命令" in GBK
 * bytes. The pipe carries bytes and no encoding, so decoding them as UTF-8
 * turned every one of those bytes into U+FFFD — the install error read
 * `'dsh' �����ڲ����ⲿ���Ҳ���ǿ����еĳ���` (#1122), which tells the person
 * looking at it nothing at all.
 *
 * UTF-8 is tried first and strictly, so text that IS UTF-8 decodes exactly as
 * before; only bytes that cannot be UTF-8 fall through to the code page. No
 * `chcp` probe: that costs a process per install, and the answer is already
 * in the bytes.
 */

/** Decode a complete child output buffer. */
export function decodeChildOutput(bytes: Buffer, platform: NodeJS.Platform = process.platform): string {
  if (bytes.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Not UTF-8. Only Windows consoles hand a child a non-UTF-8 code page;
    // elsewhere keep the previous behaviour (replace the bad bytes) rather
    // than invent Chinese out of binary noise.
    if (platform !== 'win32') return new TextDecoder('utf-8').decode(bytes)
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      // A Node without the GBK table (small-icu build). Showing the bytes as
      // UTF-8 is still better than showing nothing.
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}

/**
 * The last `limit` bytes of one child stream, decoded when it is asked for.
 *
 * Kept as bytes rather than as a string because the encoding cannot be known
 * from a prefix: the first chunks of a pnpm run are ASCII either way, and
 * decoding each chunk as it arrives fixes the encoding before the text that
 * decides it has been seen.
 */
export function createOutputBuffer(limit: number, platform: NodeJS.Platform = process.platform): {
  push(chunk: Buffer): void
  text(): string
} {
  const chunks: Buffer[] = []
  let size = 0
  return {
    push(chunk: Buffer): void {
      if (chunk.length === 0) return
      chunks.push(chunk)
      size += chunk.length
      while (size > limit && chunks.length > 1) {
        size -= chunks.shift()!.length
      }
      const first = chunks[0]
      if (first !== undefined && size > limit) {
        chunks[0] = first.subarray(size - limit)
        size = limit
      }
    },
    text(): string {
      return decodeChildOutput(Buffer.concat(chunks), platform)
    },
  }
}

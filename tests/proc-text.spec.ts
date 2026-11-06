/**
 * Child-process output is bytes, and on Windows those bytes are often GBK.
 *
 * The report (#1122): an install failed on a Chinese Windows machine and the
 * reason read `'dsh' �����ڲ����ⲿ���Ҳ���ǿ����еĳ���`. The bytes were fine;
 * they had been decoded as UTF-8 because `chunk.toString()` defaults to it.
 */

import { describe, expect, it } from 'vitest'
import { createOutputBuffer, decodeChildOutput } from '../src/proc-text.ts'

/** 「不是内部或外部命令」 in GBK — what `cmd.exe` writes on a 936 console. */
const GBK = Buffer.from('b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1ee', 'hex')

describe('decodeChildOutput', () => {
  it('leaves UTF-8 exactly as it was', () => {
    expect(decodeChildOutput(Buffer.from("'dsh' 不是内部或外部命令…", 'utf8'), 'win32'))
      .toBe("'dsh' 不是内部或外部命令…")
  })

  it('reads a Windows console\'s GBK instead of replacing every character', () => {
    expect(decodeChildOutput(Buffer.concat([Buffer.from("'dsh' "), GBK]), 'win32')).toBe("'dsh' 不是内部或外部命令")
  })

  it('keeps the old replacement characters off Windows', () => {
    // A POSIX child could emit any bytes at all. Inventing Chinese out of
    // binary noise would be worse than admitting it is unreadable.
    expect(decodeChildOutput(GBK, 'darwin')).toContain('�')
  })

  it('answers an empty stream with an empty string', () => {
    expect(decodeChildOutput(Buffer.alloc(0))).toBe('')
  })
})

describe('createOutputBuffer', () => {
  it('decodes text whose bytes arrived split across chunks', () => {
    // The encoding is chosen once, at the end, so a multi-byte character
    // cut in half by a pipe boundary is not two replacement characters.
    const buffer = createOutputBuffer(1024)
    const utf8 = Buffer.from('插件市场', 'utf8')
    buffer.push(utf8.subarray(0, 2))
    buffer.push(utf8.subarray(2))
    expect(buffer.text()).toBe('插件市场')
  })

  it('keeps the tail and drops what fell out of the window', () => {
    const buffer = createOutputBuffer(8)
    buffer.push(Buffer.from('aaaa'))
    buffer.push(Buffer.from('bbbb'))
    buffer.push(Buffer.from('cccc'))
    expect(buffer.text()).toBe('bbbbcccc')
  })

  it('keeps the tail when a single chunk is longer than the window', () => {
    const buffer = createOutputBuffer(4)
    buffer.push(Buffer.from('0123456789'))
    expect(buffer.text()).toBe('6789')
  })
})

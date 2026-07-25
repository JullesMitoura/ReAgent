/**
 * Port of _HeadTailBuffer from src/tools/exec_sessions.py (Codex's head+tail
 * policy), shared by the shell pipes and the exec sessions. Includes the pure
 * head+tail cap (_cap_head_tail) and the carry of incomplete UTF-8 between
 * chunks (_hold_incomplete_utf8) used by the same consumers.
 *
 * Layering rule: lib/* imports nothing from the project.
 */

/**
 * Incremental buffer with a head+tail policy: once past the cap, it freezes the
 * first cap/2 chars and keeps a rolling window with the last cap/2, counting the
 * discarded middle. take() delivers what accumulated since the last read (the
 * cursor) and resets.
 */
export class HeadTailBuffer {
  readonly cap: number;
  private head = "";
  private tail = "";
  private omitted = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  append(text: string): void {
    this.tail += text;
    const half = Math.floor(this.cap / 2);
    if (this.omitted) {
      if (this.tail.length > half) {
        this.omitted += this.tail.length - half;
        this.tail = this.tail.slice(-half);
      }
      return;
    }
    if (this.head.length + this.tail.length > this.cap) {
      const whole = this.head + this.tail;
      this.head = whole.slice(0, half);
      const keep = whole.slice(half);
      this.omitted = keep.length - half;
      this.tail = keep.slice(-half);
    }
  }

  /** Returns the increment since the last take (with a marker if it cut). */
  take(): string {
    const out = this.omitted
      ? `${this.head}\n... [${this.omitted} chars omitted] ...\n${this.tail}`
      : this.head + this.tail;
    this.head = "";
    this.tail = "";
    this.omitted = 0;
    return out;
  }
}

/** Cuts large text keeping the start and end, with a discard marker. */
export function capHeadTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const half = Math.floor(cap / 2);
  const omitted = text.length - 2 * half;
  return `${text.slice(0, half)}\n... [${omitted} chars omitted] ...\n${text.slice(-half)}`;
}

/** Splits an incomplete UTF-8 sequence at the end of the chunk for the next one. */
export function holdIncompleteUtf8(data: Buffer): [Buffer, Buffer] {
  const max = Math.min(3, data.length);
  for (let i = 1; i <= max; i++) {
    const b = data[data.length - i] as number;
    if (b < 0x80) break; // ASCII: nothing pending
    if (b >= 0xc0) {
      // initial byte of a multibyte sequence
      const need = b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
      if (i < need) {
        return [data.subarray(0, data.length - i), data.subarray(data.length - i)];
      }
      break;
    }
    // 0x80..0xBF: continuation byte, keep looking backwards
  }
  return [data, Buffer.alloc(0)];
}

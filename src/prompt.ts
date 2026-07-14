// Reads one secret line (an API key) from a terminal with no echo, or from a
// piped stream when stdin isn't a TTY. Everything is passed in — no direct
// reference to process.stdin/stdout — so this is testable without a real pty.

export class HiddenLineAbortedError extends Error {
  constructor(message = 'input cancelled') {
    super(message);
    this.name = 'HiddenLineAbortedError';
  }
}

export interface ReadHiddenLineOptions {
  input: NodeJS.EventEmitter & { setRawMode?: (mode: boolean) => void };
  output: { write: (chunk: string) => unknown };
  isTTY: boolean;
  prompt: string;
}

// Neutralizes bracketed-paste escape sequences (and anything else non-key-
// shaped) that can ride along in a single pasted chunk; a jotnow key is only
// ever letters, digits, and underscores.
const NON_KEY_CHARS = /[^A-Za-z0-9_]/g;

export function readHiddenLine({ input, output, isTTY, prompt }: ReadHiddenLineOptions): Promise<string> {
  output.write(prompt);

  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    // Every terminal path below (finish/abort) runs cleanup() exactly once —
    // this is the event-driven equivalent of a try/finally: setRawMode(false)
    // is restored on success, cancellation, error, and stream end alike.
    function cleanup(): void {
      input.removeListener?.('data', onData);
      input.removeListener?.('end', onEnd);
      input.removeListener?.('error', onError);
      if (isTTY) input.setRawMode?.(false);
    }

    function finish(value: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      resolve(value.replace(NON_KEY_CHARS, ''));
    }

    function abort(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      reject(error);
    }

    function onData(chunk: Buffer | string): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      if (!isTTY) {
        // Piped stdin: no control-character handling, just find one line.
        const newline = text.indexOf('\n');
        if (newline === -1) {
          buffer += text;
          return;
        }
        buffer += text.slice(0, newline);
        finish(buffer.replace(/\r$/, ''));
        return;
      }

      // Paste can arrive as a single multi-char chunk that itself contains
      // the terminator, so we always process it character by character
      // rather than assuming one chunk == one keystroke.
      for (const ch of text) {
        if (ch === '\x03') {
          abort(new HiddenLineAbortedError());
          return;
        }
        if (ch === '\r' || ch === '\n' || ch === '\x04') {
          finish(buffer);
          return;
        }
        if (ch === '\x7f' || ch === '\x08') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    }

    function onEnd(): void {
      finish(buffer);
    }

    function onError(error: Error): void {
      abort(error);
    }

    if (isTTY) input.setRawMode?.(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}

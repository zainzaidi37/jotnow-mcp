import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { readHiddenLine } from './prompt.js';

// input only needs .on/.removeListener (EventEmitter gives us both) plus an
// injected setRawMode spy — readHiddenLine must not depend on anything else
// from a real TTY, which is exactly what makes it testable without a pty.
function fakeInput(): EventEmitter & { setRawMode: ReturnType<typeof vi.fn> } {
  const input = new EventEmitter() as EventEmitter & { setRawMode: ReturnType<typeof vi.fn> };
  input.setRawMode = vi.fn();
  return input;
}

function fakeOutput(): { write: ReturnType<typeof vi.fn>; all: () => string } {
  const writes: string[] = [];
  const write = vi.fn((chunk: string) => {
    writes.push(chunk);
    return true;
  });
  return { write, all: () => writes.join('') };
}

describe('readHiddenLine (TTY path)', () => {
  it('accumulates chunks and resolves the full key on \\r', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: true, prompt: 'P: ' });

    input.emit('data', Buffer.from('jn_'));
    input.emit('data', Buffer.from('live_abc'));
    input.emit('data', Buffer.from('\r'));

    await expect(promise).resolves.toBe('jn_live_abc');
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false);
  });

  it('never writes any input character to output — only the prompt and a final newline', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: true, prompt: 'Secret: ' });

    input.emit('data', Buffer.from('SUPERSECRETVALUE'));
    input.emit('data', Buffer.from('\r'));
    await promise;

    expect(output.all()).toBe('Secret: \n');
    expect(output.all()).not.toContain('SUPERSECRETVALUE');
    expect(output.all()).not.toContain('*');
  });

  it('a pasted single chunk ending in \\n resolves, with the terminator stripped', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: true, prompt: 'P: ' });

    input.emit('data', Buffer.from('jn_live_pasted_whole_chunk\n'));

    await expect(promise).resolves.toBe('jn_live_pasted_whole_chunk');
  });

  it('backspace (\\x7f) removes the last buffered character', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: true, prompt: 'P: ' });

    input.emit('data', Buffer.from('abc'));
    input.emit('data', Buffer.from('\x7f')); // removes 'c'
    input.emit('data', Buffer.from('d'));
    input.emit('data', Buffer.from('\r'));

    await expect(promise).resolves.toBe('abd');
  });

  it('backspace (\\x08) also removes the last buffered character', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: true, prompt: 'P: ' });

    input.emit('data', Buffer.from('xy'));
    input.emit('data', Buffer.from('\x08'));
    input.emit('data', Buffer.from('\n'));

    await expect(promise).resolves.toBe('x');
  });

  it('Ctrl+C (\\x03) rejects with a distinct error and still restores setRawMode(false)', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: true, prompt: 'P: ' });

    input.emit('data', Buffer.from('partial'));
    input.emit('data', Buffer.from('\x03'));

    await expect(promise).rejects.toThrow();
    // Distinct from a plain validation Error — callers can tell "user
    // cancelled" apart from "bad input".
    await promise.catch((err: unknown) => {
      expect((err as Error).name).toBe('HiddenLineAbortedError');
    });
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false);
  });

  it('Ctrl+D (\\x04) ends input, resolving with whatever was buffered', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: true, prompt: 'P: ' });

    input.emit('data', Buffer.from('partial_key'));
    input.emit('data', Buffer.from('\x04'));

    await expect(promise).resolves.toBe('partial_key');
  });

  it('strips escape/bracketed-paste bytes outside [A-Za-z0-9_] from the accumulated input', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: true, prompt: 'P: ' });

    // A bracketed-paste-wrapped value, terminated with \r.
    const raw = '\x1b[200~jn_live_abc\x1b[201~';
    input.emit('data', Buffer.from(raw));
    input.emit('data', Buffer.from('\r'));

    const expected = raw.replace(/[^A-Za-z0-9_]/g, '');
    await expect(promise).resolves.toBe(expected);
  });
});

describe('readHiddenLine (non-TTY / piped path)', () => {
  it('reads one line from a piped stream, trims the terminator, and never touches setRawMode', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: false, prompt: 'P: ' });

    input.emit('data', Buffer.from('jn_live_piped_key\n'));

    await expect(promise).resolves.toBe('jn_live_piped_key');
    expect(input.setRawMode).not.toHaveBeenCalled();
  });

  it('resolves on stream end even without a trailing newline', async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const promise = readHiddenLine({ input, output, isTTY: false, prompt: 'P: ' });

    input.emit('data', Buffer.from('jn_live_no_newline'));
    input.emit('end');

    await expect(promise).resolves.toBe('jn_live_no_newline');
    expect(input.setRawMode).not.toHaveBeenCalled();
  });
});

import { ApiError, NotesApi, type RecallMatch, type SearchHit, type SearchResult } from './api.js';
import { API_KEY_PATTERN, DEFAULT_API_URL, resolveConfig } from './config.js';
import { configDir, saveStoredKey } from './configFile.js';
import { readHiddenLine, type ReadHiddenLineOptions } from './prompt.js';
import { serveStdio } from './server.js';

export const VERSION = '0.1.2';

export const HELP = `jotnow — jot and find notes from the terminal

For terminal use anywhere: npm i -g jotnow, then jotnow key

Usage:
  jotnow add <title> [--body <text>] [--tags a,b] [--folder <name>]
                                 (body is read from stdin when piped)
  jotnow search <query>
  jotnow recall <query>          semantic search by meaning (Pro plan)
  jotnow get <id>
  jotnow recent [n]
  jotnow                         run the MCP server on stdio (for MCP configs)
  jotnow init --key jn_live_...
                                 validate a key and print the MCP config block
  jotnow key
                                 store your API key for this machine (input hidden)

Environment:
  JOTNOW_API_KEY   API key from the web app (Settings → API keys); overrides
                   any key stored by \`jotnow key\`
  JOTNOW_API_URL   override the API endpoint (defaults to production)

A key stored by \`jotnow key\` lives in ~/.jotnow/config.json (or
JOTNOW_CONFIG_DIR if set) and is used automatically when JOTNOW_API_KEY is
unset.
`;

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`flag ${arg} needs a value`);
      }
      flags.set(arg.slice(2), value);
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Note titles/bodies are untrusted (often agent-written). Strip control
 * characters so a note can't smuggle ANSI escapes into the user's terminal
 * (cursor games, fake output, OSC sequences).
 */
export function terminalSafe(text: string): string {
  // C0 controls except \t, plus DEL and C1 controls (covers ESC/CSI/OSC).
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');
}

function printHit(hit: SearchHit): void {
  const tags = hit.tags.map(terminalSafe).join(', ') || 'none';
  console.log(`${hit.updated_at.slice(0, 10)}  ${terminalSafe(hit.title) || '(untitled)'}  [${tags}]  (${hit.id})`);
}

function printSearch({ notes, total }: SearchResult, query: string): void {
  if (total === 0) {
    console.log(`No jots matched "${query}".`);
    return;
  }
  notes.forEach(printHit);
  if (total > notes.length) {
    console.log(`Showing ${notes.length} of ${total} matches — refine the query for others.`);
  }
  console.log(`Read one with: jotnow get <id>`);
}

// Recall candidates lead with the cosine similarity so the reader can gauge how
// close a match is; title/gist are untrusted (agent-written) so both go through
// terminalSafe, same as printHit.
export function formatRecallHit(match: RecallMatch): string {
  const gist = match.gist ? ` — ${terminalSafe(match.gist)}` : '';
  return `[${match.similarity.toFixed(2)}]  ${terminalSafe(match.title) || '(untitled)'}  (${match.id})${gist}`;
}

function printRecall(matches: RecallMatch[], query: string): void {
  if (matches.length === 0) {
    console.log(`No jots matched "${query}" by meaning.`);
    return;
  }
  matches.forEach((match) => console.log(formatRecallHit(match)));
  console.log(`Read one with: jotnow get <id>`);
}

async function runInit(flags: Map<string, string>, env: NodeJS.ProcessEnv): Promise<void> {
  const key = flags.get('key') ?? env.JOTNOW_API_KEY ?? '';
  if (!API_KEY_PATTERN.test(key)) {
    throw new Error(
      key === ''
        ? 'pass your API key: npx jotnow init --key jn_live_... (create one in Settings → API keys)'
        : 'that key does not look like a jotnow key (expected jn_live_ + 43 characters)',
    );
  }
  const apiUrl = env.JOTNOW_API_URL?.trim() || DEFAULT_API_URL;
  const api = new NotesApi({ apiUrl, apiKey: key });

  process.stdout.write('Checking the key against the API… ');
  await api.listRecentNotes(1);
  console.log('ok ✔\n');

  const envBlock: Record<string, string> = { JOTNOW_API_KEY: key };
  if (apiUrl !== DEFAULT_API_URL) envBlock.JOTNOW_API_URL = apiUrl;
  const mcpConfig = {
    mcpServers: {
      jotnow: { command: 'npx', args: ['-y', 'jotnow'], env: envBlock },
    },
  };

  console.log('Add this to your MCP config (.mcp.json for Claude Code, Codex equivalent):\n');
  console.log(JSON.stringify(mcpConfig, null, 2));
  console.log('\nOr with the Claude Code CLI:\n');
  console.log(`claude mcp add jotnow -e JOTNOW_API_KEY=${key} -- npx -y jotnow`);
  console.log('\nThen tell your agent to "jot that down" — done.');
  console.log('\nTip: `jotnow key` stores the key once for all terminals and MCP configs — no env block needed.');
}

export interface RunKeyDeps {
  env?: NodeJS.ProcessEnv;
  // Bypasses the real prompt entirely — used by orchestration tests that
  // don't want to drive stream mechanics (those live in prompt.test.ts).
  readHidden?: () => Promise<string>;
  input?: ReadHiddenLineOptions['input'];
  output?: ReadHiddenLineOptions['output'];
  isTTY?: boolean;
  stdout?: { write: (chunk: string) => unknown };
  stderr?: { write: (chunk: string) => unknown };
}

export async function runKey(deps: RunKeyDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const readHidden =
    deps.readHidden ??
    (() => {
      const input = deps.input ?? (process.stdin as unknown as ReadHiddenLineOptions['input']);
      return readHiddenLine({
        input,
        output: deps.output ?? stdout,
        isTTY: deps.isTTY ?? Boolean((input as unknown as { isTTY?: boolean }).isTTY),
        prompt: 'Paste your jotnow API key (input hidden): ',
      });
    });

  const key = await readHidden();
  if (!API_KEY_PATTERN.test(key)) {
    throw new Error('that does not look like a jotnow key (expected jn_live_ + 43 characters) — nothing was saved.');
  }

  const apiUrl = env.JOTNOW_API_URL?.trim() || DEFAULT_API_URL;
  const api = new NotesApi({ apiUrl, apiKey: key });

  stdout.write('Checking the key against the API… ');
  await api.listRecentNotes(1);
  stdout.write('ok ✔\n\n');

  saveStoredKey(key, configDir(env));

  if (env.JOTNOW_API_KEY?.trim()) {
    stderr.write(
      'warning: JOTNOW_API_KEY is set in your environment; it will override the stored key until you unset it.\n',
    );
  }

  stdout.write('Saved — jotnow will use this key automatically from now on, no env var needed.\n\n');
  stdout.write('Add this to your MCP config (.mcp.json for Claude Code, Codex equivalent):\n\n');
  stdout.write(
    `${JSON.stringify({ mcpServers: { jotnow: { command: 'npx', args: ['-y', 'jotnow'] } } }, null, 2)}\n`,
  );
  stdout.write('\nOr with the Claude Code CLI:\n\n');
  stdout.write('claude mcp add jotnow -- npx -y jotnow\n');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  try {
    // No subcommand: an MCP host launching us pipes stdio; a human at a
    // terminal gets help.
    if (command === undefined) {
      if (process.stdin.isTTY) {
        console.log(HELP);
        return;
      }
      await serveStdio(new NotesApi(resolveConfig()), VERSION);
      return;
    }

    const { positional, flags } = parseFlags(rest);
    switch (command) {
      case 'init':
        await runInit(flags, process.env);
        return;
      case 'key':
        await runKey();
        return;
      case 'add': {
        const title = positional[0];
        if (!title) throw new Error('usage: jotnow add <title> [--body <text>] [--tags a,b] [--folder <name>]');
        const body = flags.get('body') ?? (process.stdin.isTTY ? '' : await readStdin());
        const api = new NotesApi(resolveConfig());
        const note = await api.saveNote({
          title,
          body,
          tags: flags
            .get('tags')
            ?.split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          folder: flags.get('folder'),
          source: 'cli',
        });
        console.log(`Jotted "${note.title}" (id ${note.id}).`);
        return;
      }
      case 'search': {
        const query = positional.join(' ').trim();
        if (!query) throw new Error('usage: jotnow search <query>');
        printSearch(await new NotesApi(resolveConfig()).searchNotes(query), query);
        return;
      }
      case 'recall': {
        const query = positional.join(' ').trim();
        if (!query) throw new Error('usage: jotnow recall <query>');
        printRecall(await new NotesApi(resolveConfig()).recallNotes(query), query);
        return;
      }
      case 'get': {
        const id = positional[0];
        if (!id) throw new Error('usage: jotnow get <id>');
        const note = await new NotesApi(resolveConfig()).getNote(id);
        const tags = note.tags.map(terminalSafe).join(', ') || 'none';
        console.log(`${terminalSafe(note.title) || '(untitled)'}  [${tags}]  (updated ${note.updated_at.slice(0, 10)})`);
        console.log('');
        console.log(terminalSafe(note.body));
        return;
      }
      case 'recent': {
        const limit = positional[0] ? Number.parseInt(positional[0], 10) : 10;
        if (Number.isNaN(limit)) throw new Error('usage: jotnow recent [n]');
        (await new NotesApi(resolveConfig()).listRecentNotes(limit)).forEach(printHit);
        return;
      }
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return;
      default:
        throw new Error(`unknown command "${command}" — run jotnow help`);
    }
  } catch (error) {
    const message = error instanceof ApiError || error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  }
}

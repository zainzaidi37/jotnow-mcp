# jotnow

Notes for AI coding agents. Every session ends with something worth keeping — a fix, a snippet, the reason the bug happened. Tell your agent to "jot that down" and it's saved to your account at [jotnow.dev](https://jotnow.dev): tagged, searchable, exportable. Works with Claude Code, Codex, and any other MCP client, plus a terminal CLI.

Signing up at [jotnow.dev](https://jotnow.dev) is free — you need an account to get the API key that connects this package to your notes.

This public repository is a mirror of the MCP package maintained in the
private Jotnow monorepo. Use this repository to inspect the source and report
issues; releases are synchronized from the monorepo.

## Setup

1. Sign up (free) or sign in at [jotnow.dev](https://jotnow.dev).
2. Open **Settings > API keys** and create a key.
3. Install and store the key once for this machine:

```bash
npm install --global jotnow
jotnow key
```

`jotnow key` prompts for the key (input hidden, never echoed), validates it against the API, and saves it to a config file so every later `jotnow` command and MCP config on this machine picks it up automatically — no `JOTNOW_API_KEY` env var required. It then prints the MCP configuration for your client, and for Claude Code, the equivalent `claude mcp add` command.

Once connected, ask your agent to "jot that down", find your jots, or list your recent jots.

Prefer not to install globally, or want to configure an MCP client without touching your terminal first? Use the env-var flow instead:

```bash
npx jotnow init --key jn_live_your_key
```

This validates the key and prints an MCP config block with the key embedded in its `env`, plus the equivalent `claude mcp add` command.

## MCP configuration

Once a key is stored via `jotnow key`, no `env` block is needed:

```json
{
  "mcpServers": {
    "jotnow": {
      "command": "npx",
      "args": ["-y", "jotnow"]
    }
  }
}
```

Or configure a key directly in the MCP config (what `jotnow init` prints):

```json
{
  "mcpServers": {
    "jotnow": {
      "command": "npx",
      "args": ["-y", "jotnow"],
      "env": {
        "JOTNOW_API_KEY": "jn_live_your_key"
      }
    }
  }
}
```

The server provides these tools:

- `jot`: save a note
- `find_jots`: search notes by keyword
- `recall_jots`: search notes by meaning (Pro)
- `get_jot`: read one note by ID or short ID prefix
- `list_recent_jots`: list recently updated notes

## CLI

After a global install, store your key once:

```bash
npm install --global jotnow
jotnow key
```

Then run commands directly:

```bash
jotnow add "Useful fix" --body "Restart the worker after changing its environment."
jotnow search "worker environment"
jotnow recall "why deployments use stale configuration"
jotnow get <id>
jotnow recent 10
```

You can also pipe a note body through standard input:

```bash
printf 'Use the pooled connection string in serverless jobs.\n' | jotnow add "Database connection"
```

Everything above also works without a global install by prefixing `npx`, e.g. `npx jotnow recent` — `npx jotnow key` stores the key the same way.

Scripting `jotnow key` (e.g. from a provisioning script): pipe the key in and it skips the interactive prompt entirely, reading one line from stdin instead —

```bash
echo "$JOTNOW_KEY" | jotnow key
```

## Environment variables

- `JOTNOW_API_KEY`: your user-scoped API key from Jotnow settings. If set, it is used instead of (and takes priority over) any key stored by `jotnow key` — useful for CI or containers where nothing should be written to disk. A malformed `JOTNOW_API_KEY` is an error rather than a silent fallback to the stored key, since that could otherwise write to the wrong account.
- `JOTNOW_API_URL`: optional API endpoint override for local development or self-hosting
- `JOTNOW_CONFIG_DIR`: optional override for where `jotnow key` stores its config file (default `~/.jotnow`)

`jotnow key` stores the key in `~/.jotnow/config.json` (or `$JOTNOW_CONFIG_DIR/config.json`), created with permissions that only your user can read.

The npm package contains no account credentials or service-role secret. Each installation uses the API key supplied by its user. Keep that key private and revoke it from Jotnow settings if it is exposed.

## Requirements

- Node.js 18 or newer

## License

MIT

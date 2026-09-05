# Jotnow
Tell your agent to "jot that down" and it's saved to your account at [jotnow.dev](https://jotnow.dev): tagged, searchable, exportable. Works with Claude Code, Codex, and any other MCP client, plus a terminal CLI.

Free to sign in, and use. Export all your notes in markdown anytime, no vendor-lockin.

[Documentation](https://jotnow.dev/docs) · [Claude Code setup](https://jotnow.dev/docs/claude-code) · [Codex setup](https://jotnow.dev/docs/codex) · [MCP tool reference](https://jotnow.dev/docs/mcp-tools)

Jotnow runs as a local stdio MCP server. Account mode connects to the Jotnow
API; desktop local mode supports capture only. Notes are saved when you ask
your agent to call the tool; this server does not automatically record chats.
The MCP server and CLI in this repository are MIT licensed.

## Setup

1. Sign up (free) at [jotnow.dev](https://jotnow.dev), then open the confirmation email; its link
   confirms your address and signs you in. Or sign in to an existing account.
2. Open **Settings > API keys** and create a key.
3. Install and store the key once for this machine:

```bash
npm install --global jotnow
jotnow key
```

`jotnow key` prompts for the key, validates it against the API, and saves it to a config file so every later `jotnow` command and MCP config on this machine picks it up automatically. It then prints the MCP configuration for your client, plus equivalent commands for Claude Code and Codex.

Once connected, ask your agent to "jot that down", find your jots, or list your recent jots.

Prefer not to install globally, or want to configure an MCP client without touching your terminal first? Use the env-var flow instead:

```bash
npx jotnow init --key jn_live_your_key
```

This validates the key and prints an MCP config block with the key embedded in its `env`, plus equivalent commands for Claude Code and Codex.

## MCP configuration


### Claude Code

For Claude Code or similar clients that use a JSON MCP configuration, once a key is stored via `jotnow key`, no `env` block is needed:

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

Otherwise, configure a key directly in the MCP config (what `jotnow init` prints):

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

### Codex

After storing your key with `jotnow key`, add Jotnow to Codex:

```bash
codex mcp add jotnow -- npx -y jotnow
```

Codex stores MCP configuration in `~/.codex/config.toml`. The Codex CLI, IDE extension, and desktop app share this configuration. To configure Jotnow manually instead of using `codex mcp add`, add:

```toml
[mcp_servers.jotnow]
command = "npx"
args = ["-y", "jotnow"]
```

The server provides these tools:

- `jot`: save a note
- `find_jots`: search notes by keyword
- `recall_jots`: search notes by meaning (account mode, Pro). Browser Recall with your own model key does not unlock this MCP tool.
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

Everything above also works without a global install by prefixing `npx`, e.g. `npx jotnow recent` — `npx jotnow key` stores the key the same way.

## Local mode

If you use the Jotnow desktop app, `jotnow` can write jots straight into its
local library instead of your account — no API key, no network:

```bash
jotnow use local      # write to the desktop app's local library
jotnow use account    # write to your jotnow account
jotnow where          # show which library jots go to, and why
```

Local mode requires the desktop app (it creates and owns the library — the CLI
never creates one). Only `jotnow add` and the MCP `jot` tool work locally;
search, recall, get and recent live in the app. If both a local library and an
API key are set up and no mode has been chosen, `jotnow` refuses with a hard
error rather than guessing where your jots belong — run `jotnow use` once to
choose (or set `JOTNOW_MODE` per command).


## Environment variables

- `JOTNOW_API_KEY`: your user-scoped API key from Jotnow settings. If set, it is used instead of (and takes priority over) any key stored by `jotnow key` — useful for CI or containers where nothing should be written to disk.
- `JOTNOW_API_URL`: optional API endpoint override for local development or self-hosting
- `JOTNOW_CONFIG_DIR`: optional override for where `jotnow key` stores its config file (default `~/.jotnow`). Note: the desktop app reads the same variable from *its own* environment, and an app launched from the Start menu or a shortcut does not inherit a variable you export in a shell — so setting it here usually points the CLI at a directory with no local-library pointer in it, and local mode won't be detected.
- `JOTNOW_MODE`: `local` or `account` for a single command; overrides the choice stored by `jotnow use`

`jotnow key` stores the key in `~/.jotnow/config.json` (or `$JOTNOW_CONFIG_DIR/config.json`), created with permissions that only your user can read.

The npm package contains no account credentials or service-role secret. Each installation uses the API key supplied by its user. Keep that key private and revoke it from Jotnow settings if it is exposed.

## Requirements

- Node.js 22.13 or newer (Node 23 needs 23.4+). The floor is local mode's (`node:sqlite`); account mode still runs on Node 18+.

## License

MIT

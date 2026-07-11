# jotnow

Save and find notes from Claude Code, Codex, other MCP clients, or your terminal. Notes sync to your account at [jotnow.dev](https://jotnow.dev).

## Setup

1. Sign in at [jotnow.dev](https://jotnow.dev).
2. Open **Settings > API keys** and create a key.
3. Run:

```bash
npx jotnow init --key jn_live_your_key
```

The command validates the key and prints the MCP configuration for your client. For Claude Code, it also prints the equivalent `claude mcp add` command.

Once connected, ask your agent to "jot that down", find your jots, or list your recent jots.

## MCP configuration

You can configure an MCP client directly:

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

Run commands without a global install:

```bash
npx jotnow add "Useful fix" --body "Restart the worker after changing its environment."
npx jotnow search "worker environment"
npx jotnow recall "why deployments use stale configuration"
npx jotnow get <id>
npx jotnow recent 10
```

You can also pipe a note body through standard input:

```bash
printf 'Use the pooled connection string in serverless jobs.\n' | npx jotnow add "Database connection"
```

After a global install, omit `npx`:

```bash
npm install --global jotnow
jotnow recent
```

## Environment variables

- `JOTNOW_API_KEY`: your user-scoped API key from Jotnow settings
- `JOTNOW_API_URL`: optional API endpoint override for local development or self-hosting

The npm package contains no account credentials or service-role secret. Each installation uses the API key supplied by its user. Keep that key private and revoke it from Jotnow settings if it is exposed.

## Requirements

- Node.js 18 or newer

## License

MIT

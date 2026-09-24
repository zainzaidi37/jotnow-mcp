// Mirrors the synchronous append_note input limit in mcp-api.
export const MCP_MAX_EDIT_CHARS = 100_000;

export function appendTextUsageError(text: string): string | null {
  if (text.trim() === '') return 'append text must be non-empty';
  if (text.includes('\u0000') || !(text as string & { isWellFormed(): boolean }).isWellFormed()) {
    return 'append text contains NUL or malformed Unicode';
  }
  if (text.length > MCP_MAX_EDIT_CHARS) {
    return `append text is longer than ${MCP_MAX_EDIT_CHARS} characters`;
  }
  return null;
}

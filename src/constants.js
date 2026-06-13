export const PROVIDERS = Object.freeze(['claude', 'codex']);

export const DEFAULT_LIMIT_WINDOW_MINUTES = 5 * 60;

export const DEFAULT_RESET_PADDING_MINUTES = 10;

export const CONFIG_FILE_NAME = 'config.json';

export const DEFAULT_PROMPT = [
  'Reply with exactly: ok',
  'Do not inspect files, do not run commands, do not modify anything, and do not use connectors or tools.',
].join('\n');

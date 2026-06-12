export const PROVIDERS = Object.freeze(['claude', 'codex']);

export const DEFAULT_LEAD_MINUTES = 30;

export const CONFIG_FILE_NAME = 'config.json';

export const DEFAULT_PROMPT = [
  'Reply with exactly: ok',
  'Do not inspect files, do not run commands, do not modify anything, and do not use connectors or tools.',
].join('\n');

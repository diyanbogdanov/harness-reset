#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: harness-reset <detect|plan|setup|status> [--provider claude|codex] [--time HH:MM] [--dry-run] [--yes]';

export async function runCli() {
  console.log(USAGE);
  return 0;
}

function isEntrypoint(metaUrl, argvPath) {
  if (!argvPath) return false;
  return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argvPath);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli();
}

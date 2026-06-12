import { spawnSync as nodeSpawnSync } from 'node:child_process';
import nodeFs from 'node:fs';

import { PROVIDERS } from './constants.js';
import { findExecutable, providerStateDir } from './platform.js';

function executableExtension(executable) {
  const extensionMatch = /(\.[^./\\]+)$/.exec(executable);

  return extensionMatch?.[1].toLowerCase() || '';
}

function versionCommandForExecutable(executable, platform) {
  if (platform === 'win32' && ['.bat', '.cmd'].includes(executableExtension(executable))) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${executable}" --version`],
    };
  }

  return {
    command: executable,
    args: ['--version'],
  };
}

function providerWarnings(provider, env) {
  const warnings = [];

  if (provider === 'claude') {
    if (env.ANTHROPIC_API_KEY) {
      warnings.push('ANTHROPIC_API_KEY is set; Claude Code subscription auth may be bypassed.');
    }

    if (env.ANTHROPIC_AUTH_TOKEN) {
      warnings.push('ANTHROPIC_AUTH_TOKEN is set; Claude Code subscription auth may be bypassed.');
    }
  }

  if (provider === 'codex') {
    if (env.CODEX_API_KEY) {
      warnings.push('CODEX_API_KEY is set; Codex subscription auth may be bypassed.');
    }

    if (env.OPENAI_API_KEY) {
      warnings.push('OPENAI_API_KEY is set; Codex subscription auth may be bypassed.');
    }
  }

  return warnings;
}

export function detectProvider(
  provider,
  { env = process.env, platform = process.platform, fs = nodeFs, spawnSync = nodeSpawnSync } = {},
) {
  const executable = findExecutable(provider, { env, platform, fs });
  const stateDir = providerStateDir(provider, { env, platform });
  const stateDirExists = fs.existsSync(stateDir);

  if (executable === null) {
    return {
      provider,
      executable: null,
      installed: false,
      version: null,
      stateDir,
      stateDirExists,
      warnings: [],
    };
  }

  const versionCommand = versionCommandForExecutable(executable, platform);
  const versionResult = spawnSync(versionCommand.command, versionCommand.args, {
    encoding: 'utf8',
    env,
  });
  const version = versionResult.status === 0 ? versionResult.stdout.trim() : null;

  return {
    provider,
    executable,
    installed: true,
    version,
    stateDir,
    stateDirExists,
    warnings: providerWarnings(provider, env),
  };
}

export function detectProviders(options = {}) {
  return PROVIDERS.map((provider) => detectProvider(provider, options));
}

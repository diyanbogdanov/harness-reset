import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_FILE_NAME } from './constants.js';

function pathForPlatform(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function envValue(env, key) {
  return env[key] || undefined;
}

function pathEnvValue(env, platform) {
  const pathValue = envValue(env, 'PATH');

  if (pathValue !== undefined || platform !== 'win32') {
    return pathValue;
  }

  const pathEntry = Object.entries(env).find(([key, value]) => {
    return key.toLowerCase() === 'path' && value;
  });

  return pathEntry?.[1];
}

export function homeDirectory({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') {
    return envValue(env, 'USERPROFILE') || os.homedir();
  }

  return envValue(env, 'HOME') || os.homedir();
}

export function findExecutable(
  name,
  { env = process.env, platform = process.platform, fs = nodeFs } = {},
) {
  const platformPath = pathForPlatform(platform);
  const pathEntries = (pathEnvValue(env, platform) || '')
    .split(platformPath.delimiter)
    .filter(Boolean);
  const extensions =
    platform === 'win32' ? (envValue(env, 'PATHEXT') || '.EXE;.CMD;.BAT;.COM').split(';') : [''];

  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate = platformPath.normalize(platformPath.join(pathEntry, `${name}${extension}`));

      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function providerStateDir(provider, { env = process.env, platform = process.platform } = {}) {
  const platformPath = pathForPlatform(platform);
  const stateDirs = {
    claude: '.claude',
    codex: '.codex',
  };
  const stateDir = stateDirs[provider];

  if (stateDir === undefined) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  return platformPath.normalize(platformPath.join(homeDirectory({ env, platform }), stateDir));
}

export function configFilePath({ env = process.env, platform = process.platform } = {}) {
  const platformPath = pathForPlatform(platform);
  const baseDir =
    platform === 'win32'
      ? (envValue(env, 'APPDATA') ||
        platformPath.join(homeDirectory({ env, platform }), 'AppData', 'Roaming'))
      : (envValue(env, 'XDG_CONFIG_HOME') ||
        platformPath.join(homeDirectory({ env, platform }), '.config'));

  return platformPath.normalize(platformPath.join(baseDir, 'agent-warmup', CONFIG_FILE_NAME));
}

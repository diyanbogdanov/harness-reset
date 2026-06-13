import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { PROVIDERS } from './constants.js';

const WARMUP_NAME = 'Agent Warmup';
const COMMON_METADATA_FIELDS = ['enabled', 'schedule', 'promptHash'];
const PROVIDER_METADATA_FIELDS = {
  claude: ['routineName'],
  codex: ['automationName'],
};

export function hashPrompt(prompt) {
  return `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`;
}

export function readConfig(filePath, { fs = nodeFs } = {}) {
  if (!fs.existsSync(filePath)) {
    return { version: 1, providers: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const providers = {};

  for (const provider of PROVIDERS) {
    const metadata = parsed.providers?.[provider];

    if (!metadata) {
      continue;
    }

    providers[provider] = {};

    for (const field of [...COMMON_METADATA_FIELDS, ...PROVIDER_METADATA_FIELDS[provider]]) {
      if (Object.hasOwn(metadata, field)) {
        providers[provider][field] = metadata[field];
      }
    }
  }

  return {
    version: parsed.version || 1,
    providers,
  };
}

export function writeConfig(filePath, config, { fs = nodeFs } = {}) {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function buildProviderMetadata(provider, { schedule, prompt }) {
  const metadata = {
    enabled: true,
    schedule,
    promptHash: hashPrompt(prompt),
  };

  if (provider === 'claude') {
    return {
      ...metadata,
      routineName: WARMUP_NAME,
    };
  }

  if (provider === 'codex') {
    return {
      ...metadata,
      automationName: WARMUP_NAME,
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

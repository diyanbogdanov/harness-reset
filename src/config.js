import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

const WARMUP_NAME = 'Harness Reset Warmup';

export function hashPrompt(prompt) {
  return `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`;
}

export function readConfig(filePath, { fs = nodeFs } = {}) {
  if (!fs.existsSync(filePath)) {
    return { version: 1, providers: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  return {
    version: parsed.version || 1,
    providers: parsed.providers || {},
  };
}

export function writeConfig(filePath, config, { fs = nodeFs } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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

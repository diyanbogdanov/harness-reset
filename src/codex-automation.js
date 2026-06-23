import nodeFs from 'node:fs';
import path from 'node:path';

import { providerStateDir } from './platform.js';

export const CODEX_WARMUP_AUTOMATION_ID = 'agent-warmup';

const CODEX_AUTOMATION_MODEL = 'gpt-5.3-codex-spark';
const CODEX_AUTOMATION_REASONING_EFFORT = 'minimal';
const DAILY_DAYS = 'MO,TU,WE,TH,FR,SA,SU';
const MAX_CODEX_WARMUP_AUTOMATIONS = 24;

function pathForPlatform(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function codexHomeDir({ env = process.env, platform = process.platform } = {}) {
  const platformPath = pathForPlatform(platform);
  return platformPath.normalize(env.CODEX_HOME || providerStateDir('codex', { env, platform }));
}

export function codexAutomationIdForIndex(index) {
  return index === 0 ? CODEX_WARMUP_AUTOMATION_ID : `${CODEX_WARMUP_AUTOMATION_ID}-${index + 1}`;
}

function automationDir({ env, platform, id = CODEX_WARMUP_AUTOMATION_ID }) {
  const platformPath = pathForPlatform(platform);
  return platformPath.join(
    codexHomeDir({ env, platform }),
    'automations',
    id,
  );
}

function automationFilePath({ env, platform, id = CODEX_WARMUP_AUTOMATION_ID }) {
  const platformPath = pathForPlatform(platform);
  return platformPath.join(automationDir({ env, platform, id }), 'automation.toml');
}

export function codexAutomationFilePath(options = {}) {
  return automationFilePath(options);
}

export function codexAutomationExists({
  env = process.env,
  fs = nodeFs,
  platform = process.platform,
} = {}) {
  return fs.existsSync(automationFilePath({ env, platform }));
}

function parseDailySchedule(schedule) {
  const match = /^daily at ([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule);

  if (!match) {
    throw new Error(`Unsupported Codex automation schedule: ${schedule}`);
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

export function dailyScheduleToRrule(schedule) {
  const parsed = parseDailySchedule(schedule);
  return `FREQ=WEEKLY;BYDAY=${DAILY_DAYS};BYHOUR=${parsed.hour};BYMINUTE=${parsed.minute}`;
}

export function dailySchedulesToRrule(schedules) {
  const parsedSchedules = schedules.map(parseDailySchedule);
  const minute = parsedSchedules[0]?.minute;

  if (minute === undefined || parsedSchedules.some((schedule) => schedule.minute !== minute)) {
    return null;
  }

  const hours = [...new Set(parsedSchedules.map((schedule) => schedule.hour))];
  return `FREQ=WEEKLY;BYDAY=${DAILY_DAYS};BYHOUR=${hours.join(',')};BYMINUTE=${minute}`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function readCreatedAt(filePath, { fs, fallback }) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  const match = /^created_at\s*=\s*(\d+)$/m.exec(fs.readFileSync(filePath, 'utf8'));
  return match ? Number(match[1]) : fallback;
}

export function writeCodexAutomation({
  cwd = process.cwd(),
  env = process.env,
  fs = nodeFs,
  id = CODEX_WARMUP_AUTOMATION_ID,
  name = 'Agent Warmup',
  now = Date.now,
  platform = process.platform,
  prompt,
  rrule,
  schedule,
} = {}) {
  const platformPath = pathForPlatform(platform);
  const dirPath = automationDir({ env, platform, id });
  const filePath = automationFilePath({ env, platform, id });
  const timestamp = now();
  const createdAt = readCreatedAt(filePath, { fs, fallback: timestamp });
  const automationRrule = rrule || dailyScheduleToRrule(schedule);
  const tempPath = platformPath.join(dirPath, `.automation.toml.${process.pid}.${timestamp}.tmp`);
  const contents = [
    'version = 1',
    `id = ${tomlString(id)}`,
    'kind = "cron"',
    `name = ${tomlString(name)}`,
    `prompt = ${tomlString(prompt)}`,
    'status = "ACTIVE"',
    `rrule = ${tomlString(automationRrule)}`,
    `model = ${tomlString(CODEX_AUTOMATION_MODEL)}`,
    `reasoning_effort = ${tomlString(CODEX_AUTOMATION_REASONING_EFFORT)}`,
    'execution_environment = "local"',
    `cwds = [${tomlString(cwd)}]`,
    `created_at = ${createdAt}`,
    `updated_at = ${timestamp}`,
    '',
  ].join('\n');

  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(tempPath, contents, 'utf8');
  fs.renameSync(tempPath, filePath);

  return { filePath, id, rrule: automationRrule };
}

export function removeCodexAutomation({
  env = process.env,
  fs = nodeFs,
  platform = process.platform,
} = {}) {
  let existed = false;

  for (let index = 0; index < MAX_CODEX_WARMUP_AUTOMATIONS; index += 1) {
    const id = codexAutomationIdForIndex(index);
    const dirPath = automationDir({ env, platform, id });
    const filePath = automationFilePath({ env, platform, id });
    existed = existed || fs.existsSync(filePath) || fs.existsSync(dirPath);
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  return existed;
}

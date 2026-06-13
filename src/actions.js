function singleLine(value) {
  return value.replace(/\s+/g, ' ').trim();
}

export function buildClaudeScheduleAction({ schedule, prompt }) {
  return {
    kind: 'spawn',
    command: 'claude',
    args: [`/schedule ${schedule} ${singleLine(prompt)}`],
  };
}

export function buildCodexAutomationAction({ schedule, prompt }) {
  const instruction = [
    'Create a standalone Codex Automation named "Agent Warmup".',
    `Run it ${schedule}.`,
    'Use this prompt:',
    prompt,
  ].join('\n');
  const fallback = [
    'Open a Codex thread and paste this request:',
    '',
    instruction,
    '',
    'If Codex asks for confirmation, approve only the native automation creation. Do not approve file edits or shell commands for this warmup.',
  ].join('\n');

  return {
    kind: 'codex-automation',
    instruction,
    fallback,
  };
}

export function usageWarning(provider) {
  if (provider === 'claude') {
    return 'This will create a Claude Code Routine. Routine runs consume normal plan usage and can be rejected when routine or subscription limits are exhausted.';
  }

  if (provider === 'codex') {
    return 'This will create or guide a Codex Automation. Automation runs consume normal Codex plan usage, and Codex usage can also count against weekly usage limits.';
  }

  return null;
}

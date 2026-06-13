# agent-warmup

NPX-friendly setup CLI for native Claude Code Routines and Codex Automations.

## What it does

- Detects `claude` and `codex`.
- Looks at local state file modification times without reading prompt or response contents.
- Suggests a daily warmup time, defaulting to 30 minutes before usual first activity.
- Creates a Claude Code Routine through the native `/schedule` flow.
- Creates a Codex Automation when the host environment exposes a native automation creator.
- Provides native Codex Automation instructions when direct creation is unavailable from a plain terminal.
- Records local metadata for created or manually confirmed warmup schedules.

## What it does not do

- Does not run its own scheduler.
- Does not create cron, launchd, systemd, Windows Task Scheduler, GitHub Actions, or Cloudflare Workers jobs.
- Does not store provider credentials.
- Does not guarantee a reset window starts or improves; it creates or guides native scheduled warmup runs only.

## Usage

```bash
npx agent-warmup detect
npx agent-warmup plan
npx agent-warmup status
npx agent-warmup setup --provider claude --dry-run
npx agent-warmup setup --provider codex --time 09:00 --dry-run
npx agent-warmup update --provider claude --time 09:00 --dry-run
npx agent-warmup remove --provider claude
```

To create a Claude Code Routine:

```bash
npx agent-warmup setup --provider claude --time 09:00
```

Type `create` when prompted to continue.

Use `update` to re-run setup for an existing provider. If no local metadata exists yet, `update` still behaves like setup.

Use `remove` to delete local agent-warmup metadata. It does not delete native Claude Code Routines or Codex Automations; it prints provider-specific instructions for removing or pausing those native schedules.

`status` prints provider availability first, then local metadata JSON.

For Codex in plain-terminal mode, the CLI prints native Codex Automation instructions instead of directly creating the automation. `--yes` does not mark Codex configured in this fallback mode because the CLI cannot prove the automation was created; type `create` after manually creating it to record local metadata.

Claude Code Routines consume normal Claude plan usage. Codex Automations consume normal Codex usage and can affect weekly usage limits.

## Metadata paths

- macOS/Linux: `$XDG_CONFIG_HOME/agent-warmup/config.json` when `XDG_CONFIG_HOME` is set, otherwise `~/.config/agent-warmup/config.json`
- Windows: `%APPDATA%\agent-warmup\config.json`

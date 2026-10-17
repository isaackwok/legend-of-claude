# Agent SDK spikes (Task 2)

These are throwaway experiments, not product code. The results are in `docs/superpowers/spikes/2026-10-16-results.md`.

Every script makes real Claude calls on the claude.ai subscription login, using `claude-haiku-5-5` and very short prompts. The scripts remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment they pass to the SDK. **Never point them at a real project.**

## Fixtures

```sh
BASE=$(bash spikes/setup-fixtures.sh)   # prints a fresh mktemp -d path
```

The script creates:

- `$BASE/repo`: a git repo with an initial commit, `CLAUDE.md`, `README.md`, and a project skill at `.claude/skills/proj-skill/SKILL.md` (`name: proj-skill`).
- `$BASE/spikeplug`: a local plugin with `.claude-plugin/plugin.json` (`name: "spikeplug"`) and the skills `skills/a/SKILL.md` (`name: a`) and `skills/b/SKILL.md` (`name: b`).

## Running

Prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&`.

| Command | What it checks | Model turns |
|---|---|---|
| `npx tsx spikes/connectors.ts $BASE/repo` | claude.ai connectors with `settingSources ['project','local']`, `mcpServerStatus()` before and after 8s, init `apiKeySource`, `mcp_servers` and `mcp__*` tools | 1 |
| `npx tsx spikes/connectors.ts $BASE/repo --no-prompt` | the same status calls, with no message sent | 0 |
| `npx tsx spikes/skills.ts $BASE/repo $BASE/spikeplug '--skills=["spikeplug:a"]'` | skill naming and filtering (the model lists the skills it can use) | 1 |
| `npx tsx spikes/skills.ts $BASE/repo $BASE/spikeplug '--skills=["a","proj-skill"]'` | whether a bare plugin skill name matches, and whether the filter keeps a project skill | 1 |
| `npx tsx spikes/skills.ts $BASE/repo $BASE/spikeplug '--skills=["spikeplug:a"]' --invoke=spikeplug:b` | whether the Skill tool rejects a skill the filter left out | 1–2 |
| `npx tsx spikes/autoMode.ts $BASE/repo` | auto mode with a benign `git status` and creating then deleting a temp file, logging every `canUseTool` call | a few |
| `npx tsx spikes/autoMode.ts $BASE/repo --risky` | `git push` to an invalid remote and `rm` of a sentinel file outside the repo | a few |
| `npx tsx spikes/autoMode.ts $BASE/repo --risky --indirect` | the same actions written only in `NOTES.md` (with `rm -rf` of the sentinel directory) | a few |
| `npx tsx spikes/autoMode.ts $BASE/repo --probe-models` | `supportsAutoMode` and `current_permission_mode` for each default model | 0 |
| `npx tsx spikes/sessionStore.ts $BASE/repo` | `InMemorySessionStore` with `resume` | 2 |
| `npx tsx spikes/sessionStore.ts $BASE/repo --deny` | whether deny rules remove a connector's tools | 1 |

Each script prints labelled sections to stdout.

**Safety notes:**

- `--risky` actions really run. In auto mode the classifier allowed them and `canUseTool` was never called. The script makes its own fresh `mktemp` directory (`$TMPDIR/loc-spike-sentinel-*`) and checks it before anything points at it, so that directory is the only thing at risk.
- The recorded risky runs used an older flag form, `--risky=<sentinel path>`.
- `--indirect` writes `NOTES.md` into the fixture repo.
- `sessionStore.ts` (without `--deny`) moves that session's local transcript from `~/.claude/projects/<key>/<id>.jsonl` to `$TMPDIR/loc-spike-parked-transcripts/`, so the resume can only use the store.

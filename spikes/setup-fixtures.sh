#!/usr/bin/env bash
# Builds the throwaway fixtures for the Task 2 SDK spikes in a fresh temp dir and prints its path.
#   <base>/repo       git repo: initial commit, CLAUDE.md, README.md, .claude/skills/proj-skill/SKILL.md
#   <base>/spikeplug  local plugin: .claude-plugin/plugin.json (name "spikeplug"), skills/a, skills/b
# Never point the spikes at a real project.
set -euo pipefail

BASE=$(mktemp -d)
R="$BASE/repo"
P="$BASE/spikeplug"

mkdir -p "$R/.claude/skills/proj-skill"
git -C "$R" init -q -b main
printf '# Spike Repo\n\nThrowaway repo for Legend of Claude SDK spikes. Keep answers very short.\n' > "$R/CLAUDE.md"
printf -- '---\nname: proj-skill\ndescription: Project-level spike skill. Use only when asked about proj-skill.\n---\n\nSay PROJ-SKILL-OK.\n' > "$R/.claude/skills/proj-skill/SKILL.md"
echo "hello" > "$R/README.md"
git -C "$R" add -A
git -C "$R" -c user.name=spike -c user.email=spike@example.invalid commit -qm init

mkdir -p "$P/.claude-plugin" "$P/skills/a" "$P/skills/b"
printf '{\n  "name": "spikeplug",\n  "version": "0.0.1",\n  "description": "spike plugin"\n}\n' > "$P/.claude-plugin/plugin.json"
printf -- '---\nname: a\ndescription: Spike skill A. Use only when asked about skill a.\n---\n\nSay SKILL-A-OK.\n' > "$P/skills/a/SKILL.md"
printf -- '---\nname: b\ndescription: Spike skill B. Use only when asked about skill b.\n---\n\nSay SKILL-B-OK.\n' > "$P/skills/b/SKILL.md"

echo "$BASE"

import { expect, test } from 'bun:test'
import { isReadOnly } from '../policy/readOnly'

const bash = (command: string) => isReadOnly('Bash', { command })

test('FR14: read tools and read-named MCP tools are read-only', () => {
  for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) expect(isReadOnly(t, {})).toBe(true)
  expect(isReadOnly('Write', {})).toBe(false)
  expect(isReadOnly('Edit', {})).toBe(false)
  expect(isReadOnly('mcp__x__getJiraIssue', {})).toBe(true)
  expect(isReadOnly('mcp__x__notion-search', {})).toBe(true)
  expect(isReadOnly('mcp__x__list_recent_files', {})).toBe(true)
  expect(isReadOnly('mcp__x__createJiraIssue', {})).toBe(false)
  expect(isReadOnly('mcp__x__update_file', {})).toBe(false)
})

test('FR14: Bash reads, including get / list / search / help subcommands', () => {
  for (const c of [
    'ls -la', 'cat a.txt | grep x | wc -l', 'git status', 'git log --oneline -5', 'git diff && git branch',
    'kubectl get pods', 'gh pr list', 'npm search react', 'brew info jq', 'aws s3 ls', 'aws dynamodb get-item --key x',
    'npm help', 'foo --help', 'gh pr view 12', 'cd src && rg TODO', 'FOO=1 git status', 'ls 2>/dev/null',
    'curl -s https://example.com', 'find . -name "*.ts"', 'git config --get user.name', 'docker ps',
  ]) expect([c, bash(c)]).toEqual([c, true])
})

test('FR14: Bash writes still ask', () => {
  for (const c of [
    'rm -rf list', 'npm install', 'git commit -m x', 'git push', 'git branch -D x', 'git stash', 'echo x > f',
    'ls; rm x', 'ls && touch y', 'cat $(rm x)', 'find . -delete', 'sed -i s/a/b/ f', 'curl -X POST https://x',
    'curl -o out https://x', 'python3 -c "import os" list', 'sudo ls', 'python3 x.py list', 'python3 -c "import os; os.remove(1)"', 'python3 -c "open(\'f\',\'w\')"', 'python3 -c "import sys; sys.modules[1]"', 'kubectl delete pod x', 'gh pr create', 'ls & rm x', 'git tag v1', 'xargs rm',
  ]) expect([c, bash(c)]).toEqual([c, false])
})

test('FR14: loops, variables and quoted pipes, as the agent writes them', () => {
  for (const c of [
    `T=~/.local/bin/tgcli; for p in @ruii_h @miryoe; do echo "== $p"; $T history $p --limit 5 2>&1; done; $T history --help 2>&1 | sed -n '1,15p'`,
    `for d in ~/go/bin ~/.local/bin /opt/homebrew/bin; do ls $d 2>/dev/null | grep -i tg | sed "s|^|$d/|"; done; ls -d ~/*tg* ~/.*tg* 2>/dev/null`,
    `if git diff --quiet; then echo clean; else git status; fi`,
    `/opt/homebrew/bin/gh pr list`,
  ]) expect([c, bash(c)]).toEqual([c, true])
  for (const c of [
    `T=rm; $T -rf x`, `$X history`, `T=rm; ~/$T list`, `for d in a; do $d/rm list; done`, `for f in *; do rm $f; done`, `echo "$(rm x)"`, 'echo "`rm x`"', 'echo $(ls; rm x)', `cat x 2>&1 >out`,
    `ls "unterminated`, `ls |& tee x`, `cat <<EOF\nx\nEOF`, `echo ';rm x' ; rm y`,
  ]) expect([c, bash(c)]).toEqual([c, false])
  expect(bash(`echo ';rm x'`)).toBe(true)
})

test('FR14: [ ] tests, read-only substitutions and inline Python that only reads', () => {
  for (const c of [
    `for d in ~/.local/bin ~/go/bin /opt/homebrew/bin; do [ -x $d/tgcli ] && echo $d/tgcli; done`,
    `~/.local/bin/tgcli chats list --limit 200 -o json 2>&1 | python3 -I -c '
import json,sys
d=json.load(sys.stdin)
items=d if isinstance(d,list) else d.get("chats") or d.get("dialogs") or d
print(json.dumps(items[0],indent=1)[:800]) if items else print("empty")
'`,
    'echo "today is $(date +%F)"', 'echo `whoami`',
    'for d in ~/.local/bin /opt/homebrew/bin ~/go/bin; do [ -x $d/wacli ] && $d/wacli --help 2>&1 | head -40 && $d/wacli chats --help 2>&1 | head -30; done; true',
  ]) expect([c, bash(c)]).toEqual([c, true])
})


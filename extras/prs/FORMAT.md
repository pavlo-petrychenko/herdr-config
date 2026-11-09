# herdr-prs: commands and data format

`herdr-prs` finds the pull requests of the agent in a Herdr terminal and writes one small data file per terminal.
The `prs` mod (step 3) runs it and draws the file. This page is the contract between them.

## Commands

```
herdr-prs refresh <terminal> [--discover] [--session <id>]... [--cwd <path>] [--print]
herdr-prs detail <owner/repo> <number> <body|checks|files|diff|threads> [--fresh]
```

Exit code: `0` also when parts failed (they are in `errors`). `2` is a usage error (message on stderr). `1` is a bug.

### refresh

Writes `<home>/data/prs/<terminal>.json`. `<home>` is `$HERDR_APP_HOME`, else `~/.config/herdr-app`.
The file is written to a temporary file and renamed, so a reader never sees half a file.
It prints nothing, except with `--print` (then the JSON, indented). It is safe to run for a terminal that does not exist.

- `--discover`: also search GitHub for PRs on the branches the agent pushed (see Discovery). Use it when the view opens and about every 5 minutes. Without it, the numbers found earlier are reused.
- `--session <id>` (repeatable): add a Claude Code session by id. For tests with a fake terminal.
- `--cwd <path>`: use this folder as the terminal's worktree. Default: the terminal's live folder.
- Run time: 1 to 2 s warm without `--discover`, 3 to 5 s with it. A run stops itself at 24 s (Herdr stops an `exec` at 30 s).
- Run one at a time per terminal: a run holds `<home>/data/prs/<terminal>.lock` (`{ pid, at }`). A run that finds a live lock (its process exists, under 60 s old) waits up to 15 s for it to go, then exits 0 without refreshing: the other run writes the file. A dead or older lock is taken over. (Writes are atomic anyway.)

### detail

Prints JSON for one part of the preview (see Detail). Every answer has `"part"`. A failure is `{ "part": ..., "error": "<text>" }` with exit code 0.
Cached in `<home>/data/prs/cache/detail/`, keyed by repo, number, head commit and update time (read from the newest data file that lists the PR). A cached answer has `"cached": true`. `--fresh` skips the cache.

## The data file

```json
{
  "version": 1,
  "at": "2026-11-09T10:28:07.394Z",
  "terminal": "t35",
  "stale": false,
  "worktree": { "path": "/Users/me/project/shop-x", "branch": "x", "repo": "owner/name" },
  "sessions": [{ "sessionId": "…", "transcriptPath": "/Users/me/.claude/projects/…/….jsonl", "from": "live" }],
  "repos": ["owner/name"],
  "prs": [ { "…": "see below" } ],
  "count": 2,
  "problems": 0,
  "branches": [{ "repo": "owner/name", "name": "feature-0" }],
  "discoveredAt": "2026-11-09T10:28:07.383Z",
  "errors": [{ "kind": "gh", "message": "gh is not signed in: run `gh auth login`" }]
}
```

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Format version. A reader ignores a file with another version. |
| `at` | ISO string | When this file was written. |
| `terminal` | string | The terminal id. |
| `stale` | bool | `true` when GitHub could not be reached (fully or partly) and some `prs` come from the last good file. |
| `worktree` | object or `null` | The terminal's worktree: `path` (`--cwd`, else the terminal's live folder, else the live session's folder, else the folder of the newest hook line), `branch` (checked-out branch, or `null` when detached), `repo` (`owner/name` of its `origin`, or `null`). `null` when no folder is known. |
| `sessions` | array | The Claude Code sessions that were read. `from` is `"live"` (runs now in the terminal), `"arg"` (`--session`), or `"hook"` (`data/agent-sessions/<terminal>.jsonl`). A session that has several sources shows the first that applies in that order. |
| `repos` | array | Every repo with a PR in the file, a pushed branch, or the worktree. Sorted. |
| `prs` | array | The rows, see below. |
| `count` | number | Open and draft PRs whose `by` holds a kind other than `"other"`. This is the number for the PRs icon. |
| `problems` | number | Of those same PRs, the ones with `checks.state == "fail"` or `conflicts`. This is the red badge. |
| `branches` | array | The branches that discovery searches for: pushed by the agent, its subagents and workflows; their worktrees' current branches; the terminal worktree's branch (its upstream branch name when it has one). Default branches (`main`, `master`, `develop`, `trunk`, the repo's `origin/HEAD`) and `worktree-agent-*` placeholders are left out. Sorted. A reader can compare this list between files to see that it changed. |
| `discoveredAt` | ISO or `null` | When discovery last finished without a GitHub failure. |
| `errors` | array | What went wrong. See Errors. |

### A row of `prs`

```json
{
  "repo": "acme/shop", "number": 57783,
  "title": "[Area J | Topic 5]: Change 20",
  "url": "https://github.com/acme/shop/pull/57783",
  "author": "pavlo-petrychenko",
  "state": "draft",
  "head": "feature-22", "base": "master",
  "headOid": "03ca51c8a5a5…",
  "createdAt": "2026-11-09T10:04:03Z", "updatedAt": "2026-11-09T10:18:47Z", "mergedAt": null, "closedAt": null,
  "additions": 645, "deletions": 90, "changedFiles": 39,
  "review": "approved",
  "mergeState": "CLEAN", "conflicts": false, "autoMerge": false,
  "checks": { "state": "pass", "pass": 17, "fail": 0, "pending": 0, "skip": 123 },
  "parent": null,
  "stack": null,
  "by": [{ "kind": "subagent", "name": "Subagent 4" }]
}
```

| Field | Values |
|---|---|
| `repo`, `number` | The PR's key. A number alone is not unique across repos. |
| `title`, `url`, `author` | `author` is a login, or `null` (a deleted user). |
| `state` | `"open"`, `"draft"`, `"merged"`, `"closed"`. |
| `head`, `base` | Branch names. |
| `headOid` | Head commit sha. Together with `updatedAt` it keys the `detail` cache. |
| `createdAt`, `updatedAt`, `mergedAt`, `closedAt` | ISO strings, `null` when not set. `updatedAt` does not move when checks finish. |
| `additions`, `deletions`, `changedFiles` | Numbers. |
| `review` | `"approved"`, `"changes"`, `"required"`, `"none"` (GitHub's `reviewDecision`). |
| `mergeState` | GitHub's `mergeStateStatus` as is (`CLEAN`, `UNSTABLE`, `BLOCKED`, `DIRTY`, `BEHIND`, `HAS_HOOKS`, `DRAFT`, `UNKNOWN`), or `null`. |
| `conflicts` | `true` when an open or draft PR has `mergeable` `CONFLICTING`. Always `false` for merged and closed PRs (GitHub keeps `CONFLICTING` on merged ones). |
| `autoMerge` | `true` when auto-merge is on. |
| `checks.state` | `"pass"`, `"fail"`, `"pending"`, `"none"`. GitHub's own rollup word for the head commit (it knows which checks are required). `none`: no checks. |
| `checks.pass/fail/pending/skip` | Counts of check runs and status contexts. They count every run in the rollup, so a re-run that left a cancelled run counts the cancelled one too. `fail` holds `FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE` and `ERROR`; `skip` holds `SKIPPED`, `NEUTRAL`, `STALE`. The same mapping as `detail … checks`, but there the latest run per check is used, so its counts can be lower. |
| `parent` | The number of the PR this one sits on (same repo), or `null`. |
| `stack` | `null` for a PR that is in no stack. Else `{ "id", "native", "position" }`, see Stacks. |
| `by` | Who made the PR. See `by`. Never empty. |

### Stacks

- **Native** (GitHub's stacked PRs): `id` is `"<repo>#<stack number>"`, `native` is `true`, `position` is GitHub's (1 is the bottom, nearest the base branch). `parent` is the member one position lower, or if that is not in the file, the nearest lower one; else the PR whose head is its base. A merged lower member stays in the stack at its position.
- **Base chain** (any tool): B sits on A when B's `base` is A's `head` (same repo; an open PR before a merged one with the same head; the newest among equals). For a chain of 2 or more, `id` is `"<repo>~<root pr number>"`, `native` is `false`, `position` is 1 at the root and counts along the path. Two PRs may share a parent. A loop is cut at its smallest number.
- A PR that sits on a native stack member but is not a member itself has `{ "id": "<repo>#<n>", "native": false, "position": null }`.
- The other members of a native stack are fetched too, up to 40 extra PRs per repo, and get `by: [{ "kind": "other" }]` unless something else says they are the agent's.
- If GitHub rejects the stack fields (a GitHub without stacked PRs), the query is asked again without them and stacks come from the base chain. The refusal is remembered for 1 hour.

Order of `prs`: stacks first (the stack with the newest change first, each from the bottom up), then single PRs (newest change first).

### `by`

A list of `{ "kind", "name"? }`, ordered `worktree`, `agent`, `subagent`, `workflow`, `other`. A PR can have several.

| kind | When |
|---|---|
| `agent` | The main transcript created the PR (`gitOperation` `created`), or has a `pr-link` for it and no subagent or workflow created it. |
| `subagent` | A subagent's transcript created it. `name` is the agent's `name`, else its `description`, else its `agentType`. |
| `workflow` | A workflow agent's transcript created it. `name` is the `workflowName`. |
| `worktree` | The PR's `head` is the terminal worktree's branch (local name, or upstream name when set). Added to the others. |
| `other` | The PR is in the file only because of a stack or a base chain. Always alone. |

A PR that was not created by a transcript but was found by searching for a pushed branch gets the `by` of whoever pushed that branch.

**A record must fit the PR's age.** A `gitOperation` "created" record or a `pr-link` counts only when its time is within [`createdAt` − 2 minutes, `createdAt` + 30 minutes]. Claude Code writes both kinds of record also when a tool result merely prints an old `gh pr create` or PR URL (a subagent that reads other transcripts), and those come long after the PR exists. Records that do not fit are ignored. A PR left with no `by` (no fitting record, not on a pushed branch, not on the worktree's branch) is not in the file at all, unless it is in the stack or base chain of a PR that has one (then it is `other`). Its number and stack are not fetched again; the rejection is kept per session and PR in `cache/discover/<terminal>.json` (`rejected`).

### Errors

`{ "kind", "message", "file"? }`, at most 30, no duplicates. The view can show the first one.

| kind | Meaning |
|---|---|
| `gh` | `gh` is missing, not signed in, offline, timed out or failed. The last good PRs are kept and `stale` is `true`. |
| `github` | GitHub answered with an error for part of the query (access, SAML, rate limit low). |
| `hc` | `hc get <terminal>` failed (no core, unknown terminal). The live session is not looked up. |
| `session` | A session id has no transcript on disk, or `--session` was malformed. |
| `scan` | A transcript could not be read. `file` is its path. |
| `transcript-format` | A transcript (at rest for 10 minutes) has `gh pr create` calls, but no result could be matched to them and no PR record exists: Claude Code's transcript format may have changed. `file` is the transcript. |
| `internal` | A bug: the run stopped. The last good file is kept (`stale`), with this error. |
| `transcript-parse` | Lines with a marker could not be parsed and were skipped (a count). |
| `cache` | A cache file could not be written. |

## Where the PRs come from

1. **Sessions**: `data/agent-sessions/<terminal>.jsonl` (written by the SessionStart hook), the session running now (`hc get` → the claude process below the foreground pid → `~/.claude/sessions/<pid>.json`), and `--session`. Older sessions are not guessed.
2. **Transcripts** of each session: the main file, `subagents/agent-*.jsonl`, `subagents/workflows/wf_*/agent-*.jsonl`, with their `.meta.json` and `workflows/wf_*.json`. Only lines with `"gitOperation"`, `"pr-link"` or `gh pr create` are parsed. Results are cached per file by size and modification time in `data/prs/cache/scan.json`; a file that only grew is read from its old end.
   - PRs: `gitOperation.pr` with `action: "created"`, and `pr-link` records, each with the time of its record (the first 8 distinct times are kept). Workflow agents' transcripts have no `toolUseResult`, so a successful `gh pr create` is also read from the text it printed: only a command that runs `gh pr create` itself (not one that names it in quotes), and only when the PR URL is the last line of the result.
   - Pushed branches: `gitOperation.push`. The repo comes from the record's folder (`git remote get-url origin`; a deleted agent worktree falls back to the repo it lived in).
   - Subagent and workflow worktrees: `worktreePath` in the meta file; the branch it has now, if the folder still exists.
3. **Discovery** (`--discover`, or when a branch has never been searched): one search per repo and chunk, `repo:<r> is:pr head:A head:B … sort:updated-desc` (each under 240 characters; state is not filtered). With the PRs found, PRs outside native stacks get their base chain completed: a search for the PR that holds their base branch, and for PRs based on their head branch (two levels at most). The numbers found are kept in `data/prs/cache/discover/<terminal>.json`.
4. **Refresh**: one `gh api graphql` call per repo, one alias per PR (at most 50 aliases per call). Merged and closed PRs are asked for again once an hour only: in between, their rows come from the last file (their check counts are the slow part of the query). Check counts only; no check nodes.

## Detail

| Part | Answer |
|---|---|
| `body` | `{ part, title, body, author, reviewers: [{ login, state }], requested: [login or team] }` |
| `checks` | `{ part, counts: { pass, fail, pending, skip }, checks: [{ name, workflow, result, url, runId, jobId, seconds }] }`. The latest run per check, skipped ones dropped, sorted fail, pending, pass, then by name. `result` is `pass`, `fail` or `pending`. `runId` and `jobId` come from the check's URL (strings or `null`). |
| `files` | `{ part, files: [{ path, additions, deletions, status, previousPath? }], total, truncated }`. REST, 100 per page, up to GitHub's 3000. |
| `diff` | `{ part, diff, bytes, truncated }`. The unified diff, cut at 900 KB at a line end (`truncated: true`); `bytes` is the full size. A diff that GitHub refuses (over 20,000 lines or 1 MB) is `{ part, error }`. |
| `threads` | `{ part, total, truncated, threads: [{ resolved, outdated, path, line, author, body, url, createdAt, replies: [{ author, body, createdAt }] }] }`. The first 100 review threads; the first comment is the thread's `author`/`body`, up to 5 replies. |

## Files under `<home>/data/prs/`

- `<terminal>.json`: the data file. Safe to delete; the next refresh makes it again.
- `<terminal>.lock`: held while a refresh runs (see Commands). Safe to delete.
- `cache/scan.json`: transcript scan results by file (plus folder → repo and repo → default branch lookups). Pruned after 45 days or above 6000 files.
- `cache/discover/<terminal>.json`: searched branches, discovered PR numbers, native stack members, and `rejected` (transcript records judged not real: `<session>|<repo>#<number>`).
- `cache/detail/*.json`: `detail` answers.
- `cache/gh.json`: when GitHub last refused the stack fields.

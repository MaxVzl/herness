# herness

herness orchestrates code agents on a ticket, from the request to the pull request: a Claude Code orchestrator, Cursor implementers and Claude reviewers. The run is driven by a state machine in code (the engine, sole writer of `state.json`), shown live in one herdr workspace per mission. Human decisions go through gates (spec, plan, amendments, arbitration, abandon, resuming a blocked mission, opening a PR when a check is also red on main). You approve or reject them from a terminal. There is no final gate before the PR: it is pushed and opened automatically after a green preflight.

## Requirements

- herdr running, with `HERDR_ENV` set (herness must run inside a herdr pane)
- `claude` (Claude Code) signed in
- `cursor-agent login` done
- `gh auth login` done
- docker
- node 24 and pnpm
- lazygit

`herness dev` checks the environment (git identity, docker, `cursor-agent`, reachable herdr server, `gh`, node/pnpm) and stops on any `KO`. `HERDR_ENV` and lazygit are not checked automatically: start herness from a herdr pane, and keep lazygit on `PATH`.

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/MaxVzl/herness/main/install.sh | sh
```

The script downloads the latest release archive (`herness-<version>.tar.gz`), installs it under `~/.local/share/herness/versions/<version>/` (preparation included: `pnpm install --prod`), points `~/.local/share/herness/current` at it and creates the link `~/.local/bin/herness` (`~/.local/bin` must be on `PATH`). The 3 latest versions stay on disk, and so does any version a process is still using. Variables: `HERNESS_INSTALL_DIR` (instead of `~/.local/share/herness`), `HERNESS_BIN_DIR` (instead of `~/.local/bin`).

The contract between the script and the releases does not depend on the language herness is written in: one archive per version, with a root folder that contains an executable `bin/herness` and, when needed, `bin/post-install`, run once after extraction. CI builds it (`git archive`) and attaches it to each release created by release-please.

### Update

```sh
herness update                         # latest version
herness update --version 0.5.0         # a specific version, including a rollback
```

The command runs the install script again, then lists running missions (not `pr-open`, not `closed`, not `blocked`) and offers to restart them (`herness resume <id> --restart`, on the new version). Otherwise the engine, the dashboard and the viewers of those missions keep running on the old version, intact in its folder. The orchestrator is not restarted; its MCP server keeps the old code until its session is started again.

Everything herness launches (engine, dashboard, viewers, MCP server, cockpit) starts on the version that is active at launch time, even from an older cockpit. The cockpit itself creates missions and records approvals: if it runs on a version other than the installed one, it says so in yellow under its title. Quit it (`q`) and start `herness` again.

### Upgrading from 0.8

Finish or close missions that are still running before you install this version. Do not restart a mission created by herness 0.8 or earlier: finish it on that version, or close it (`herness close <id>`). An engine already running on 0.8 keeps its old code until something restarts it, so the mission can still finish after the upgrade if you leave it alone.

Run that upgrade with `herness mise-a-jour` (the 0.8 command). Answer no when it offers to restart missions, or have no mission in progress: the offer runs `current/bin/herness` with a command this version does not know.

Add `language: 'fr'` to the config of francophone projects. A missing value means `'en'`.

To roll back: `herness update --version 0.8.1`. That install offers no restart. It cannot read missions created by this version, and it prints how to restart the missions that older version started.

### Developing herness

From a clone: `pnpm install`, then a link under another name than `herness`, for example `ln -s "$PWD/bin/herness" ~/.local/bin/herness-dev`. The install script replaces an existing `~/.local/bin/herness` link (and says so), but refuses to overwrite a real file. Outside an install (root not under `versions/`), the engine, panes, cockpit and detached restart start with the `node` on `PATH` and `bin/herness.js`.

## Commands

`dev`, `init` and `project` run from the project repository (or a subdirectory). The others run from anywhere.

| Command | Role |
| --- | --- |
| `herness` | Inside herdr: opens (or creates) the project's `herness` tab, which shows the cockpit (see "Cockpit"). Outside herdr: prints `outside herdr: run "herness cockpit" in a terminal` and does nothing else. |
| `herness init` | Creates the herness config of the current repository (see "Add a project"), then asks whether to refine it with Claude. On a repository that is already configured, it rewrites nothing and only asks that question. |
| `herness project` | Prints the config that applies to the current repository (name, file, repository) and checks that it is valid. |
| `herness cockpit` | Cockpit screen in the current terminal (project of the current directory). Outside an interactive terminal, prints one frame and returns. |
| `herness dev <request...> [--note <text>]` | Starts a mission: Wrike link, GitHub issue or free text. `--note` adds details that complement the request (written to `note.md`; they win if they contradict the request). Creates the herdr workspace, the worktree and the branch `herness/<id>`, and starts the engine, the dashboard and the orchestrator. |
| `herness resume <id> [--restart]` | Reopens a mission workspace and restarts whatever is no longer running (engine, dashboard, spec and plan viewers, orchestrator). A blocked mission opens a resume gate (`resume-blocked`): once approved, it continues from the blocked step with a fresh round budget. A mission at `pr-open` or `closed` prints its state and restarts nothing. `--restart` stops (double ctrl+c) then restarts the engine, dashboard and viewers even if they are running, and sends nothing to the agents. |
| `herness update [--version <x.y.z>]` | Installs the latest herness version (or the one requested), then offers to restart running missions on the new code (see "Update"). |
| `herness status [id]` | State of every mission, or the detail of one mission. |
| `herness tasks <id>` | Dashboard of one mission (the `tasks` pane): tasks, gates, log, with the cockpit gestures for that mission (`a`, `r`, `n`, `u`, `R`, `c`, `o`, `←/→` to pick the gate), `b` back to the cockpit, `q` quit. |
| `herness show <spec\|plan> <id>` | Viewer of the `spec` or `plan` pane on the `docs` tab: shows the document with `bat` (otherwise `less -R`) and reloads it as soon as it changes. A pending amendment proposal (`<spec\|plan>.proposed.md` in the mission folder) takes priority, marked by a header; otherwise the worktree file; otherwise a waiting message. `q` leaves the view, Enter opens it again. Read only: it never writes `state.json`. |
| `herness approve <id> [--gate <gateId>] [--note <text>]` | Approves a pending gate (by default the oldest one). |
| `herness reject <id> --note <text> [--gate <gateId>]` | Rejects a gate; `--note` (the reason) is required. |
| `herness close <id>` | Closes the mission: test database, engine, worktree and herdr workspace (confirmation if work remains). On the command line, it first offers to report the mission's herness errors. On a mission already `closed` (approved abandon), it cleans up what remains. The local branch is deleted only if all of its content is already on `origin` (never the remote branch, never the PR). |
| `herness report <id> [--yes]` | Preview of the issues and comments to publish on `MaxVzl/herness` (public repository), then a confirmation. `--yes` sends them without asking. |
| `herness delete <id> [--yes]` | Deletes the folder of a `closed` mission (state, spec, plan, logs) after confirmation (`--yes`: skip it). Refuses while a worktree, a herdr workspace or a database remains: run `herness close` first. |

`approve` and `reject` require a real interactive terminal (confirmation `y/N`): an agent cannot approve in your place. In the cockpit and the `tasks` pane, `a` (approve) and `r` (reject, note required) do the same thing after a two-key confirmation (see "Cockpit"). All of these commands stay available: the cockpit does not replace them.

## Mission steps

`env`, `prepare`, `classify`, `brainstorm`, `spec`, `plan`, `tasks`, `global-review`, `preflight`, `pr`, `pr-open`, `closed`, `blocked`.

1. `herness dev` creates the workspace and starts the orchestrator, which reads the request.
2. The orchestrator proposes a spec, then a plan; each one goes through a gate.
3. Implementers (Cursor) code in TDD, task by task; reviewers (Claude) review, with a bounded number of correction rounds.
4. The full local preflight runs in the worktree, on a dedicated test database.
5. Green preflight: the engine rebases on the main branch if needed (one automatic rebase at most, preflight replayed), pushes the branch and opens the pull request automatically, with no gate. Only a check that is also red on the main branch asks for a decision (gate `pr-despite-main`).
6. PR open (`pr-open`): the engine stops. On your explicit request, the orchestrator may then touch the mission branch: rebase on the main branch and resolve conflicts (adapting code if needed), make a targeted fix (review feedback), rerun tests and preflight, then push with `--force-with-lease` after summarizing the changes for you. Never `git stash`, never `--no-verify`, never a push to the main branch. These touch-ups go through neither an implementer nor a review: for a substantial change, start a new mission. This applies only to missions started after this rule (the orchestrator prompt is frozen at launch).
7. `herness close` cleans up.

## Gates

Each human decision is a gate, approved (`herness approve`) or rejected (`herness reject`) by the user alone.

| Gate | Opened when | Approved | Rejected |
| --- | --- | --- | --- |
| `spec`, `plan` | The orchestrator asks for approval | The document is committed, the next step starts | The orchestrator fixes it and asks again |
| `amendment` | The orchestrator proposes an amended plan | Applied as soon as no instruction is in progress with an agent (see below) | Nothing changes |
| `arbitration` | A review contradicts the plan, or the orchestrator asks for a decision | The note goes into the next fixes file; with no correction waiting, the gate has no effect (the orchestrator is told) | Same, with the rejection note |
| `agent-blocked` | An agent is waiting for help in its pane | The engine waits for the agent to finish, and does not send the instruction again | Mission blocked |
| `agent-stopped` | An implementer stopped without a commit and left a report (task, global review or preflight); the orchestrator explains it and proposes an amendment if the plan is at fault | A correction round (same rules as red tests: bounded rounds, strong model on the 3rd) with `User decision: <note or continue>` | Mission blocked |
| `resume-blocked` | `herness resume` on a blocked mission | Back to the blocked step, fresh round budget | The mission stays blocked |
| `pr-despite-main` | A preflight check is also red on the main branch | PR opened anyway | Mission blocked |
| `abandon` | The orchestrator asks to abandon | Test databases removed, mission `closed` | The mission continues |

An approved amendment applies as soon as no agent has an instruction in progress and no `agent-blocked` gate is pending. The current task's `agent-stopped` gate does not hold it back (that is the case the amendment is there to fix). If it changes the text of the current task, its brief is rewritten with a `## Resume` section (keep the work already in the tree, adapt it, test, commit) and the implementer is started again on the same round. The `agent-stopped` gate it was waiting on becomes `obsolete`: it is no longer pending, it holds no amendment, and a decision on it is ignored. An amendment approved while the mission is blocked inside the task loop is applied at once. It unblocks the mission (like an approved resume) only if the task at fault is itself what blocks the mission (a check, a stop without a commit, rounds exhausted…) and the amendment changes its text. Otherwise the mission stays blocked (`herness resume <id>`). The gate summary says so as soon as it opens: `(mission blocked: approving this amendment will restart task <n>)` or `(mission blocked: approving does not clear the block)`. An amendment that changes a task already approved stays refused.

A stop without a commit and without a report, or any other failure of the commit check (identity, author, dirty tree, forbidden file), blocks the mission.

## MCP tools

The orchestrator talks to the engine through the mission MCP server (`herness mcp <id>`). No tool decides a gate: only the user approves or rejects.

| Tool | Role |
| --- | --- |
| `status` | Mission summary: step, current task, rounds, pending gates, PR. |
| `mission_classified` | Declares the work type and the slug once the request is understood. |
| `request_approval` | Asks the user to approve the spec or the plan, once it is written in the worktree. |
| `propose_amendment` | Proposes an amendment: full amended plan in `plan.proposed.md` in the mission folder (and `spec.proposed.md` if the spec changes), never in the worktree. |
| `request_arbitration` | Asks the user to arbitrate a review that contradicts the plan, or any decision they must make. |
| `pause` | Pauses the engine. Does not block or unblock anything. |
| `end_pause` | Ends a pause requested with `pause`. Does not resume a blocked mission. |
| `abandon` | Asks to abandon the mission: opens a gate that only the user approves. |
| `report_anomaly` | Reports a herness anomaly seen without an error. Never for a normal mission failure. |

## Cockpit

`herness` (no arguments), started in a herdr pane from the project repository, opens the `herness` tab of the current workspace, or brings it to the front if it already exists. That tab runs `herness cockpit`: every mission of the project, one per line, with its status (pending gate in amber, blocked mission in red, active as normal, finished dimmed), and beside it the detail of the selected mission (below it if the terminal is narrower than 100 columns). The most urgent missions come first: pending gates, then blocked, active, finished; ties go to the most recent. The screen refreshes every second; the selection stays on the same mission even if the order changes.

Outside herdr, `herness` opens nothing and tells you to run `herness cockpit` in a terminal. `herness cockpit` works anywhere.

| Key | Effect |
| --- | --- |
| `↑` / `↓` | Select the mission |
| `←` / `→` (or `tab`) | Select the mission's pending gate (if it has several) |
| `a` | Approve the selected gate |
| `r` | Reject the selected gate: a note is required |
| `n` | Approve or reject with a note: type the note, then `a` or `r` |
| `u` | Resume the mission (`herness resume`); unavailable on a finished mission |
| `R` | Restart the engine, dashboard and viewers (`herness resume --restart`) |
| `c` | Close the mission (`herness close`); confirmation, and a second one if work remains |
| `o` | Open the mission's herdr workspace |
| `D` | Delete a closed mission (`herness delete`), after confirmation; absent from the `tasks` pane |
| `+` | New mission: type a Wrike link, a GitHub issue or text, then Enter; then an optional note (several lines, `ctrl+e` opens an editor), `ctrl+s` starts, Esc cancels |
| `f` | Show or hide finished missions that are hidden |
| `q` | Quit |

Keys that do nothing (no pending gate, finished mission…) are dimmed on the help line at the bottom. From the cockpit, `u` and `R` leave the cockpit on screen (`o` opens the mission workspace). During a close, the other gestures and `+` are refused (`action in progress`) until it finishes.

**Messages.** A success stays for 5 seconds; an error stays until the next key. A failure keeps its `KO` lines and the final error (8 lines at most).

**Two-key decisions.** `a` does not approve at once: a confirmation `Approve <gate> (<kind>) of <mission>?` is shown, Enter confirms, Esc cancels. `r` first asks for the rejection note (an empty note is refused), then the same confirmation. `n` asks for the note, then `a` (approve with the note) or `r` (reject; the note is then required), then the confirmation. A decision already sent for a gate is not sent again while the state still shows it pending.

**Typing a note.** Enter starts a new line, `ctrl+s` submits the note, `ctrl+e` opens it in the terminal editor (`$VISUAL`, otherwise `$EDITOR`, otherwise `nano` or `vi`) and reads it back on return, Esc cancels.

**`tasks` pane.** On the `master` tab, `tasks` is the same screen limited to the mission (`herness tasks <id>`), with the same keys except `↑`/`↓`, `+` and `f`, plus `b`, which returns to the project cockpit (`herness` tab, recreated if it was closed). Here `R` restarts in the background (detached process, output in `logs/restart-<timestamp>.log` in the mission folder): the restart survives the pane stopping, and the pane is started again.

**Hidden finished missions.** By default the cockpit hides: a `pr-open` mission whose PR is merged; a `closed` mission with a PR whose PR is merged; a `closed` mission with no PR, or whose PR was closed without a merge, seven days after it was closed (a `pr-open` mission whose PR is closed stays visible). A line `N finished missions hidden (f)` reminds you; `f` shows everything. PR state comes from `gh`, refreshed at most every 5 minutes per PR, and only for visible missions whose PR is neither merged nor closed on a hidden mission. A failing `gh` is not retried before 5 minutes.

## herdr layout

One workspace per mission, with these tabs (plus the cockpit `herness` tab, created in the workspace where you start `herness`):

- `master`: orchestrator on the left; on the right, `tasks` on top and `lazygit` (on the worktree) below
- `docs` (created just after `master`): `spec` on the left, `plan` on the right, each running `herness show`; `herness resume` recreates the tab if it is missing and restarts idle viewers
- `agents`: implementers and reviewers; an agent is stopped as soon as its work is done (task approved, round finished, PR open), and its pane stays open with its history
- `checks`: tests and preflight
- `process`: long-running processes (containers, test database, apps)

## Where missions live

`~/.local/state/herness/missions/<id>/` (`state.json`, `request.md`, `orchestrator.md`…). `HERNESS_HOME` replaces `~/.local/state/herness`.

herness errors are also written to `~/.local/state/herness/errors.log`. `herness report` (and `herness close` on the command line) files them as issues on `MaxVzl/herness`: one issue per distinct error, or a comment if an open issue already carries the same `herness-sig-…` signature. The home directory is replaced by `~` in what is published. `missions/<id>/issues.json` remembers what was sent.

## Add a project

Project configs live **outside the repository**, one per folder:

```
~/.config/herness/projects/<name>/config.ts    # or $XDG_CONFIG_HOME/herness/projects
~/.config/herness/projects/<name>/*.sh         # project scripts (preparation, test database…)
```

`HERNESS_PROJECTS_DIR` replaces that folder (useful for tests). herness also reads the repository's `projects/` folder, which contains only `projects/example/` — a commented template, never loaded, aimed at a fake path.

To add a project, run `herness init` from its repository. It writes `~/.config/herness/projects/<name>/` and infers from the repository:

- `name` (folder name), `repoPath` (git root) and `mainBranch` (`origin`'s default branch, otherwise `main` or `master`);
- the package manager (`packageManager` in `package.json`, otherwise the lockfile);
- `preflight`: the `typecheck`, `lint`, `format:check` and `test` scripts of `package.json` that exist;
- `commitFormat` from the last 50 commits (with or without a scope, with or without an `[{id}]` suffix);
- `language: 'en'` (language of this project's specs, plans, pull requests, and commit messages written by agents; the engine's own commits stay in English);
- a `prepare-worktree.sh` that copies `.env` and `.env.local` from the main checkout and installs dependencies.

The rest takes the default values of the `projects/example/` template. `init` then asks whether to refine the config with Claude: Claude opens in the terminal, at the repository root, explores CI, scripts and services, adjusts preflight, preparation, the test database and forbidden paths, asks its questions and modifies only the config folder. When it exits, herness validates the config again. Running `herness init` on a project that is already configured only offers that refinement again.

By hand, the same thing is:

1. `mkdir -p ~/.config/herness/projects/my-project && cp projects/example/* ~/.config/herness/projects/my-project/`
2. Adapt `config.ts` (at least `name` and `repoPath`) and the scripts.
3. Run `herness project` from the repository: it prints the chosen config (the one whose `repoPath` contains the current directory) or the error, with the folders it searched.

The file default-exports a plain object, with no import of herness sources: herness validates it against its schema on load. Script paths are computed from the config's location (`import.meta.url`).

| Field | Role |
| --- | --- |
| `name`, `repoPath`, `mainBranch` | Identity, repository path, main branch |
| `branchPrefixes` | Commit type to branch prefix |
| `commitFormat` | Commit format, e.g. `{type}({scope}): {description} [{id}]` |
| `language` | Language code (`'en'`, `'fr'`…) of specs, plans, pull requests, and commit messages written by agents. The engine's own commits stay in English. Default `'en'` |
| `forbiddenPaths`, `forbiddenCommands` | Files and commands forbidden to agents |
| `prepare` | Worktree preparation command (`{worktree}`) |
| `testDb` | Optional: `up` / `down` of the test database (`{id}`, `{worktree}`) |
| `preflight` | Ordered list of `{ label, command }` |
| `falsePositives` | Known failures: `pattern`, `action` (`retry`, `ignore`, `cleanup`), `cleanup` (command, for `cleanup`), optional `label`, `explanation` |
| `orchestratorPermissionMode` | Optional, `auto` by default: orchestrator permission mode |
| `models` | `orchestrator`, `reviewer`, `implementer`, `implementerStrong` |

## Publishing a version

Versions are managed by [release-please](https://github.com/googleapis/release-please), from PR titles in the conventional format (`feat:` bumps the minor version, `fix:` a patch; before 1.0, a breaking change only bumps the minor).

1. Merge `dev` into `main` with a PR, using a merge commit (no squash).
2. On every push to `main`, release-please opens or updates a PR `chore(main): release x.y.z` that bumps `package.json`, the manifest and `CHANGELOG.md`.
3. Merge that PR: release-please creates the tag `vx.y.z` and the GitHub release.
4. Bring `main` back into `dev` (`git checkout dev && git pull && git merge origin/main && git push`) so `dev` has the new version.

## Current limits

- herdr is required to run a mission: only the `herness cockpit` screen starts outside herdr.
- The first milestone (a real ticket through to the PR) has not been run yet.

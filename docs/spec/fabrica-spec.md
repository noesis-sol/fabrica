# Fabrica — Product and Technology Spec

Oct 21, 2026 · refined from a first technology spec (`stack.md`, first called `hivemind.md`) and its git-sync companion (`git-sync.md`), both of 2026-10-21, with @Michael Michailidis · revised Oct 22, 2026 with the lessons of building and running tutti (H50–H65), and Oct 29, 2026 with those of tutti 0.2.0 to 0.5.0 (H66–H92). Fabrica was first called Hivemind, then Agmen.

## 1. Purpose, scope and conventions

Fabrica is a port of **orchestra** (v0.9.1, `github.com/noesis-sol/orchestra`) to a desktop app with a headless engine. It works through a backlog of tickets with several Pi coding agents side by side, each in its own git worktree, and merges each finished ticket, checked, into the branch the run started on. The engine runs on the user's machine or on a remote server; the Electron app and a command line attach to it.

This spec fixes the product's behaviour, its architecture and its technology stack. Its reader is an AI agent that will turn it into an implementation plan. It stands alone: it carries every decision of the technology spec it was refined from (`stack.md`) and of that spec's git-sync companion (`git-sync.md`) that still holds, so neither is needed to build Fabrica. Appendix A carries the console's design handoff, Appendix B its theme tokens, and Appendix C says where the design's files are. §27 lists the options set aside and records any later change to a decision.

In scope: behaviour (as a port of orchestra), process boundaries, data stores, contracts, remote operation, packaging, security and the development toolchain. Out of scope: pricing and branding beyond the name.

**Markers**

- **MUST / SHOULD / MAY** follow RFC 2119.
- **\[DECISION\]** is settled. Change it only with a stated reason and a note in §27.
- **\[OPEN\]** is undecided. Propose options with trade-offs and a recommendation; §28 lists them.
- **\[VERIFY\]** is a fact read from docs on 2026-10-21. Check it against the current release or vendored source before building on it.

**Rules for the refining agent**

- Pin every dependency to an exact version. "latest" is never a valid value.
- Do not add a dependency that ships native binaries without an entry in the native inventory (§22.4).
- Every dependency of the **engine** MUST run on its four targets, and every dependency of the **app** on its five (§4). A gap on any target blocks adoption.
- Prefer the vendored source of Effect, Foldkit and Pi over web search when an API is in doubt.
- Where this spec says a behaviour is orchestra's, orchestra 0.9.1's documentation and code are the reference: `docs/running.md`, `docs/workers.md`, `docs/setup.md`, `docs/organs.md`, `docs/dashboard.md`, `docs/events.md`, `skills/orchestra/SKILL.md`, and the source under `internal/` and `cmd/orchestra/`. tutti (`github.com/noesis-sol/tutti`), a separate TypeScript/Effect port of orchestra that continues alongside, is a second reference: its spec (`.orchestra/specs/tutti-spec.md`), its parity matrix (`docs/parity.md`), its list of what it still lacks from orchestra (tutti-kkb) the tickets of its full scan (label `scan`, 2026-10-22), its two design reviews (tutti-axpo, 2026-10-23; tutti-rvzn, 2026-10-24), its three speed scans (tutti-ejkt, -gr4z, -0vbd, 2026-10-25 to 27) and its changelog from 0.2.0 to 0.5.0 record most traps a port meets. Fabrica is new code; nothing is copied from either.
- orchestra is the reference for **behaviour, never for implementation** (H54): design each behaviour around what Pi, the engine and Effect give (the model proxy, the extension's gate and tools, typed records), not around orchestra's terminal tabs and hook files. Where Fabrica's behaviour departs from orchestra's on purpose, say so where it is specified and add it to §26's list of departures; matching orchestra is the default, not a rule.

## 2. What Fabrica is

Fabrica keeps orchestra's concepts and changes four things:

1. **Any model.** Workers are Pi agents; Pi's provider layer (`pi-ai`) reaches Anthropic, OpenAI, Google, OpenRouter, local models and others. orchestra is bound to Claude Code and stays so.
2. **An engine that outlives its clients.** One long-lived engine per user per machine holds projects and runs them; runs go on with no client attached. It runs on a laptop or a server, headless.
3. **A desktop app and a CLI as clients.** The Electron app is the rich interface; the CLI does everything but windows. Both speak one typed protocol, locally or over SSH.
4. **Its own backlog.** Tickets live in Fabrica's own work graph (SQLite in the engine, synced through git), behind a tracker interface that other backends (JIRA, Linear, GitHub Issues) may implement later. Beads is not used.

The differentiator over side-by-side agent apps (Conductor, Superset, Nimbalyst, Maestro, Paseo, Codex desktop) is orchestra's: coordination. A dependency-aware backlog, footprints that keep conflicting tickets apart, a merge queue that checks every merge, hand-backs to the worker that wrote the code, questions that block only what they must, and runs that keep going overnight.

### 2.1 Glossary

Unchanged from orchestra unless marked.

| Term | Meaning |
|---|---|
| **Engine** | *New.* The long-lived Fabrica process on a machine (§7). It holds projects, the work graph, runs, workers and organs. |
| **Client** | *New.* The desktop app or the CLI, attached to one or more engines (§8). |
| **Project** | *New as a named concept.* A git repository registered with an engine, with its settings and backlog. |
| **Run** | One pass of the engine over a project's ready tickets, from its start checks to its end line. At most one per project at a time. |
| **Base** | The branch the project's checkout is on when the run starts. Finished tickets land here. |
| **Ticket** | An item in the work graph. Epics are never dispatched; their children are the work. Questions are tickets for the maintainer. |
| **Question** | A ticket of type `question`: a decision only the maintainer can make, with 2 to 4 options and one recommended (§15). It blocks the tickets that wait on it. |
| **Maintainer task** | *New.* A ticket of type `manual`: work only the maintainer can do (a demo driven by hand, an account to set up, a purchase). Never dispatched to a worker and never put to the answer talk; listed with the attention requests as the maintainer's own (§15.1, H52). |
| **Worker** | A Pi agent session working on one ticket in its own worktree (`fabrica/<id>` branch). |
| **Organ** | A one-shot adviser: triage, predictor, reviewer, scout, the spec breakdown. It answers; it never changes code or tickets itself (§16). |
| **Talk** | An interactive session with the maintainer: refining a spec, talking a feature through, answering questions, directing a run (§15). |
| **Footprint** | The files a ticket will change (its `files`, or what its text names when it gives none), the functions it names that the repository declares, its area labels, and the files its worktree changed. Overlapping tickets don't run side by side (§13.4). |
| **Shared file** | *New.* A file nearly every ticket edits (a features map, the spec): in footprints, but holding no tickets apart; its conflicts go to the resolve hand-back (§13.4). |
| **Merge queue** | Finished tickets merge one at a time: rebase, setup if needed, merge check, fast-forward (§13.7). |
| **Hand-back** | A rebase conflict or a failing merge check sent back to the ticket's own worker to fix. |
| **Solo** | A ticket labelled `solo` runs alone. |
| **Held back** | A ready ticket waiting for something other than a slot: an overlap, its subtickets, a blocker not merged, a solo ticket. The app says *waiting*, with the reason in words (H81). |
| **Set aside** | Deferred, or left for review (`CHECKS_FAILED`, `MERGE_CONFLICT`, `CLOSED_UNCOMMITTED`, …). |
| **Checks** | `check_own` (a worker's check of its change), `check_fast` (the merge check, on every merge), `check_full` (once at a run's end). |
| **Requirements** | The project's `requires` list: what the machine must have (§17). |
| **Hold** | A reason the run takes no new tickets: environment, usage limit, credentials, machine budget, a stop, a drain, a budget (§14). |
| **Time awake** | *New.* The time the engine's host was awake. Every time limit counts it, never wall time (§7.7). |
| **Attention request** | Something waiting on the maintainer right now: a question or a permission request (§15). |
| **Overnight run** | A run started after a pre-flight checklist and its questions answered (§15.6). |

## 3. Decisions

Settled with the maintainer on 2026-10-21, on top of the first technology spec's (carried in here); H50–H65 on 2026-10-22, from what building and running tutti taught (its demo beside orchestra, its first release, and a full scan that filed 62 tickets, 7 of them P1, after it counted as complete); H66–H92 on 2026-10-29, from tutti's next week (its releases 0.2.0 to 0.5.0, two design reviews, three speed scans and the runs between them, 380 tickets closed). Several of H66–H92 are choices the maintainer made in tutti (keeping awake by default, answering in place, the worker view, a spec from a URL, `--auto-answer`); the rest follow from its evidence. Each shapes the sections named.

| # | Decision | Chosen | Sections |
|---|---|---|---|
| H1 | Basis | A new product, **Fabrica**, in fresh code. orchestra 0.9.1 is the behavioural reference, tutti a second reference | §1, §26 |
| H2 | Agent harness | **Pi only**. Model agnosticism is Pi's provider layer | §12 |
| H3 | Choosing a model | A **provider and model per project**, overridable **per ticket**, and a **fallback list used only when a provider or model fails to start** (credentials, provider down) | §12.5 |
| H4 | Engine scope | **One long-lived engine per user per machine**, holding many projects and running several at once under one machine-wide worker budget. Clients attach and detach; runs go on without them | §7 |
| H5 | Engine runtime | **Node**: an engine distribution per target, holding a pinned Node runtime, the engine bundle and Pi, the same on a laptop and a server. No Bun | §6, §7, §22 |
| H6 | Client protocol | **Effect RPC, JSON on the wire**, over a local socket, an SSH stdio bridge, or a WebSocket over TLS | §8 |
| H7 | Remote access | **SSH by default** (the engine listens on its local socket only; H30); **TLS with a revocable pairing token** as an option | §9 |
| H8 | Users | **One person per engine, any number of clients at once.** The first answer to a question or permission request wins | §8.5 |
| H9 | Adding a project | **Register a checkout on the engine's host, or clone from a git URL** | §10 |
| H10 | Pushing | A per-project **`push`** setting: `never` (default for a registered checkout), `after_run` (default for a cloned one: Base is pushed once the run's full check passes), `after_merge`. Fetch and fast-forward Base before a run; never force | §10.3 |
| H11 | Ticket backend | A **tracker interface** (`WorkGraph`); the **local tracker** is the only one built. Each adapter defines its own sync | §11 |
| H12 | Local tracker | **SQLite is the engine's live store; a dedicated git ref is the synced record**, one JSON file per ticket, merged per field, continuously | §11 |
| H13 | Coordination | **orchestra's model** (the engine dispatches each ready ticket to a fresh worker; the merge queue is the gate), **plus typed hand-offs and supervision policies** | §13, §12.8 |
| H14 | Worker control channel | **The first-party Pi extension's tools** over a per-agent socket: the worker's ticket, filing tickets, questions (2–4 options enforced), notes, and the outcomes `finish`, `defer`, `wait_for`. A turn that ends with no outcome gets one nudge | §12.3 |
| H15 | Standing rules | **Injected by the extension into Pi's system prompt**; rules about an action live in that tool's description and schema | §12.4 |
| H16 | Isolation | **A worktree by default; a container per worker as a project option** | §12.7 |
| H17 | Permissions | **One neutral policy** (`workspace`, `ask`, `full`) enforced by the extension's gate; what it can't decide becomes an attention request; every decision is logged | §12.6 |
| H18 | Organs | Through **`pi-ai` calls**, or **short Pi sessions** where an organ needs tools; each organ may name its own model | §16 |
| H19 | Verifier | **The engine runs it**, as a separate read-only session, preferably with a different model from the worker's | §13.6 |
| H20 | Usage limits | **A usage limit holds the whole run** until it resets, within `usage_limit_wait` | §14.2 |
| H21 | Cost | **Tokens and cost recorded and shown** per ticket, run and model; **budgets optional, off by default** | §14.4 |
| H22 | Engine installation | **The app installs and updates engines over SSH**; a **versioned protocol**, checked at connect | §9.2, §8.4 |
| H23 | Headless | **A CLI in the engine distribution**, for everything but windows; no terminal dashboard | §19 |
| H24 | App, first release | **Runs and workers; backlog and review (read-only); questions, permissions and talks.** Editing the backlog in the app comes later (the CLI covers it) | §18 |
| H25 | Platforms | **Engine: macOS and Linux, x64 and arm64. App: macOS, Linux and Windows x64**; on Windows the app uses a remote engine or one in WSL2 | §4 |
| H26 | Credentials | **In the engine host's own secret store**, entered through the app, used only by the engine's model proxy (H29) | §20.3 |
| H27 | Scope | **orchestra 0.9.1's behaviour, minus what is about Herdr, tmux, cmux, screen reading or Claude Code itself**, delivered in milestones | §13–§17, §26 |
| H28 | UI stack | **Foldkit, `@foldkit/ui`, Tailwind**; Monaco, xterm.js and Cytoscape.js mounted | §18 |
| H29 | Agents' credentials | **A model proxy in the engine**: each agent's provider base URLs point at the engine with a per-agent token; the engine adds the real credential, refreshes OAuth tokens, grants permits and counts usage. No agent ever holds a credential | §12.9 |
| H30 | SSH transport | **An SSH stdio bridge**: `ssh <host> fabrica bridge`, the RPC (NDJSON) over ssh's stdin and stdout. No port opened, nothing forwarded | §8.2, §9.1 |
| H31 | WSL2 | **One more host**: the Windows app installs the Linux engine in a WSL2 distribution and connects with `wsl.exe -d <distro> -- fabrica bridge` | §7.6 |
| H32 | Ticket clocks | **A hybrid logical clock per field** | §11.3 |
| H33 | Sync cadence | **Commit within 2 s, push at once, fetch every 60 s during a run**, at its start and before each claim; every 15 min for a project with no run | §11.3, §11.4 |
| H34 | Two engines | **One engine runs a project at a time**, through a run lease on the tickets ref | §11.5 |
| H35 | Machine budget | **Half the cores, at least 2** | §7.3 |
| H36 | Containers | **Docker or Podman, whichever is present, rootless preferred**, through the Docker-compatible CLI, with limits per container | §12.7 |
| H37 | One worker's trouble | **Always set the ticket aside and go on**; nothing stops the whole run for one worker | §14.5 |
| H38 | Telemetry | **DuckDB embedded in the engine, always on and local**, feeding cost figures, reports and the app's Insights screen; SQLite stays the work graph; export (Parquet, OTLP) optional, metadata only. **Revised by H65:** typed rows recorded from M1, DuckDB the query layer from M6 | §21 |
| H39 | Builds | **Per-arch macOS**; no Windows arm64 or Linux armv7l yet; deb and rpm updated by hand | §4, §22.2 |
| H40 | Smaller choices | Cytoscape.js with dagre or ELK for the ticket graph; `tsgo` with `tsc` as fallback; Beads JSONL **import** in v1, export later; the run view written at most every 50 ms and token batches every 50 ms, in whole milliseconds (H55) | §18.1, §6, §11.6, §8.3 |
| H41 | Offline runs | **Refused unless `--offline`** when the remote can't be reached; on a lease clash after reconnecting, **the later run drains** | §11.5 |
| H42 | Design | **The Fabrica Console handoff** is the visual source: `themes.css` as the only tokens; **Lichen Bright** (default), **Classic** and **Neon Grid**; all dark, no light theme in v1; fonts bundled | §18.2 |
| H43 | Sidebar | **Projects and their runs**, across engines; "+ Add project" | §18.3 |
| H44 | The console's chat | **A run talk**: a Pi session that reads the run and acts through the engine's commands | §15.4, §18.3 |
| H45 | Progress | **Phase steps plus the worker's latest action**; no percentage | §18.3 |
| H46 | Window controls | **Native controls in the design's title bar** (traffic lights inset on macOS, the title bar overlay on Windows and Linux) | §18.3 |
| H47 | Pull requests | **After v1**: a later `push: pull_request` opens one PR per run; v1 merges into Base | §10.3 |
| H48 | Building it | **A new repository built by orchestra from this spec**, M0's spikes first | §23 |
| H49 | Licence | **Open source under MIT, public releases** on GitHub (`github.com/noesis-sol/fabrica`) | §20.5 |
| H50 | Review gates | **Each milestone ends with a review** of its code against this spec and orchestra's behaviour (bugs, edge cases, design), by area, its findings filed and the serious ones fixed before the next milestone starts. tutti counted as complete when a scan filed 62 tickets | §23, §25 |
| H51 | Releasing early | **A pre-release in M1** through the whole release path (CI, signatures, publishing, the install script from the public URL, `fabrica engine update`). tutti's pipeline had never run, and its first release failed three times | §22, §25 |
| H52 | Maintainer tasks | **A ticket type `manual`**, never dispatched and never put to the answer talk. In the development tracker (Beads, under orchestra), such tasks are not labelled `human`: orchestra takes that label for a question and stops runs to have it answered | §2.1, §11.2, §13.3, §15.1, §23 |
| H53 | Consequential answers | **A question whose options close, cancel, defer or freeze work, or change a decision, has no option preselected and is never answered in a batch**; any answer can be revised, undoing what the old one did where it can. tutti was marked frozen by a recommended option accepted in a batch | §15.2, §15.3 |
| H54 | orchestra as reference | **For behaviour, never for implementation**; each departure recorded (§26) | §1, §26 |
| H55 | Tests | **Files in parallel within the run's core share; no test reads facts about its host (cores, memory, load, clock, home); whole milliseconds under `TestClock`; generous per-test time limits; a timeout counts as a flaky test; a 2-core CI runner** | §24, §8.3, §22.3 |
| H56 | Cores | **The engine's own checks, setups and organ sessions get a core share too; the machine budget counts the slots the scheduler counts**, through one function | §7.3, §14.3 |
| H57 | init's checks | **No test runs twice in a check**: a full suite that covers the fast one replaces it; build steps found only in CI are offered unticked; init's first ticket repeats only `check_fast` | §16 |
| H58 | Run state | **One owner per piece of run state, changed by atomic transitions; the holds one state; one table of what each phase counts as** | §13, §14, §18.3 |
| H59 | Merging | **The commit checked is the commit merged**: the fast-forward takes the checked hash, and the gate refuses commits in a worktree whose ticket is in the merge queue; a git read that fails is "can't tell", retried, never taken as an answer | §13.7, §12.6 |
| H60 | Usage limits | **The hold lifts on evidence**: the model proxy's probe call at the reset; a reset at or before now is unknown; probes at least `usage_limit_retry` apart; a refusal ends with its turn | §14.2 |
| H61 | Bounded and typed | **Every wait has a limit** (an abort, a command's output after it exits, a worker's descendants); **every record from outside is decoded** (Pi's RPC records, unknown ones skipped), and reports read typed events, never log text | §12.1, §16 |
| H62 | Safety | **A permission request is shown whole, per tool, and answered only while shown; an agent's environment is an allowlist; files in a worktree are opened as hostile; `init` is atomic, and a project without a merge check doesn't merge** | §10.1, §13.7, §15.1, §18.3, §18.5, §20.2 |
| H63 | Contrast | **Each theme passes a contrast check, and colour is never the only signal** (focus, status) | §18.2, §24 |
| H64 | Release path | **Notes within GitHub's 125,000 characters; attestation needs the repository public (or a paid plan); the install script served from each release; `~/.local/bin` by default; arm64 under Rosetta; a CPU baseline per native component; a size budget for the engine distribution** | §22 |
| H65 | Telemetry, revised | **Typed rows recorded from M1** in the engine's own SQLite store, beside the event stream; **DuckDB the query layer from M6**, after its M0 spike, its storage version pinned; event fields named as orchestra's (`check`, `phases`, `tokens`, `organs`). Revises H38 | §21, §13.12, §25 |
| H66 | Time awake | **Every time limit counts the host's time awake**, not wall time: a sleep (a gap over 15 s in a 1 s heartbeat) puts off the limits it crossed and is recorded (`SLEPT`, with its cause where the OS logs one); usage-limit resets, leases and sync schedules stay wall-clock | §7.7, §13.12 |
| H67 | Keeping awake | **A run keeps its host awake by default**; the engine's `keep_awake: false` opts out; a closed lid still sleeps a laptop, which the run says; the battery is watched | §7.7, §15.6 |
| H68 | Settings scope | **Committed project settings hold only what everyone running the project shares**; a person's or a machine's choice is the engine's or the app's setting | §13.13 |
| H69 | Credentials refused | **A credential refused once a run has begun holds the run** for that provider (`HOLD: CREDENTIALS`) until a new sign-in or key makes the proxy's probe go through; no ticket is deferred, triaged or counted for it; the start checks refresh OAuth tokens and try keys first | §14.6, §12.9, §13.1 |
| H70 | Footprints, precise | **A ticket's `files` are its footprint**; its text is read for files only when it gives none; a function counts only where the repository declares it, and only in code; `shared_files` hold nothing apart; a ticket past its work holds on its branch's files | §13.4, §12.3 |
| H71 | Merge hygiene | **A refused fast-forward is diagnosed** (a lock retried, Base moved rebased again; only a branch that doesn't fast-forward stops); budgets count over a ticket's whole merge turn; a check that leaves changes sets its ticket aside; merged worktrees are deleted in the background | §13.7 |
| H72 | A dirty checkout | **Merges wait while Base's checkout has uncommitted changes, naming them, and go on once it is clean**; the run goes on | §13.7, §26 |
| H73 | CPU priority | **Workers and their commands run at nice 10**; the engine's merge check, organs and talks at its own; a priority raised back is set again and said once | §7.3 |
| H74 | Process trees | **Ending a command or an agent kills its whole tree**, every descendant's process group with it; commands get stdin from `/dev/null` | §12.1 |
| H75 | Session lifecycle | **One session at a time per ticket** (Starting, Open, Closing); its ID saved only once it has started; a send to a closing session fails | §12.1 |
| H76 | Resumes | **Every resume takes a free slot as a dispatch does** and is told what changed since its session began; an undeferred ticket comes back in the same run, resuming its kept session | §13.2, §13.5, §14.5 |
| H77 | A long-lived engine | **Everything held for a worker, a ticket or a run is released with its scope**; a soak test holds memory and handles flat | §7.1, §24 |
| H78 | Test layers | **A test layer replaces only the outermost boundary and runs the live code over it**; a fake that reimplements a service is refused | §24 |
| H79 | One source per rule | **Each rule in one module, each value read once per decision**; outcomes are tagged unions, IDs and hashes branded types; the review gate checks both | §6, §23 |
| H80 | Nothing silent | **Every engine step over a second is shown with its elapsed time**; layouts keep their size as workers come and go | §8.3, §13.1, §18.3 |
| H81 | Plain words | **Every waiting ticket shows why in words wherever its count does**; a ticket waiting on a question shows the question; usage windows are named as the provider names them | §13.4, §18.3 |
| H82 | Unattended answers | **`--auto-answer`, off by default**: a run's question with a recommended option, neither consequential nor the maintainer's own, is answered with that option, at once or after a wait, labelled and told to the worker; overnight runs turn it on | §15.2, §15.6, §26 |
| H83 | Spec runs | **A spec from an https URL**, fetched each run and committed as a copy; the breakdown's tree checked whole; a narrow tree warned of; a breakdown at the usage limit waits | §15.5 |
| H84 | Run files | **The event stream survives a torn or short write; a log line and its record go together; times carry their UTC offset; durations are monotonic; one atomic writer; a hard-linked file is replaced, never truncated** | §7.7, §13.12, §20.2 |
| H85 | Commands' environment | **Checks, setups and git get the workers' allowlisted environment, never git's local variables**; revisions after `--end-of-options`; rebases with `--no-update-refs`; git 2.38 or later | §13.1, §13.7, §20.2 |
| H86 | Organs' budgets | **The reviewer's input is capped per section, keeping each end; one ticket's organ failure loses only that ticket's answer** | §16 |
| H87 | Releases | **Tag only once main's check has passed on every engine target; never a skip marker in a commit message; changelog entries one file per ticket; the install script tries the new binary where it installs it** | §22.5, §23 |
| H88 | Tests, more | **Tests wait on events or the injected clock, time-counting guards included; failed tests rerun together per file; platform facts pinned per platform; CI uses every core** | §24 |
| H89 | Own check | **`check_own`'s pass is recorded with the tree it ran on**, so it stands for that tree, at `finish` and for the verifier | §12.3, §13.6 |
| H90 | Usage windows | **The model proxy reads the provider's usage windows from every response, and the console shows them** | §12.9, §18.3 |
| H91 | Worker view | **The ticket on top, figures live during a turn, no spending panel; a message to a finished worker can be filed as a ticket** | §18.4 |
| H92 | Answering in place | **Needs your attention answers questions inline**: the question's own title, the ticket waiting on it, its options with keys; an answer wakes the run at once | §15.2, §18.3 |

Also decided in the first technology spec, and kept: Electron; TypeScript, strict, ESM; Effect v4 at one exact version across every package; SQLite through `@effect/sql-sqlite-node` (`node:sqlite`) for the work graph; Effect's tracing and metrics (sent out only through an optional export, H38); pnpm workspaces and electron-vite; oxlint and oxfmt; electron-builder; testing against Effect test layers; the rules for developing with coding agents.

## 4. Platform targets

\[DECISION\] Each target is built, signed where applicable and smoke-tested in CI.

| Part | OS | Architectures | Formats | Notes |
|---|---|---|---|---|
| Engine | macOS | x64, arm64 | tar.gz (engine distribution) | Developer ID signed, notarised (its Node binary included). Minimum macOS follows the pinned Node's floor \[VERIFY\] |
| Engine | Linux (glibc) | x64, arm64 | tar.gz | Minimum glibc follows the pinned Node's floor \[VERIFY\]. musl (Alpine) out of scope |
| App | macOS | x64, arm64 | dmg, zip | Developer ID signed and notarised. A separate build per architecture (a universal one would carry two engine distributions). Minimum macOS follows the pinned Electron's floor \[VERIFY\] |
| App | Linux (glibc) | x64, arm64 | AppImage, deb, rpm | X11 and Wayland. The AppImage updates itself; deb and rpm are updated by hand (§22.2) |
| App | Windows | x64 | NSIS installer | Authenticode signed. Connects to a remote engine, or to one it runs in WSL2 (§7.6) |

- Code SHOULD stay portable: paths through Effect's `Path`, shell assumptions confined to the engine's process and agent layers.
- The engine is POSIX-only: process groups, `flock`, signals. A native Windows engine is out of scope.
- Windows arm64 and Linux armv7l are not built; they wait for demand (H39).

## 5. Architecture at a glance

```text
┌─────────────── machine A (laptop) ───────────────┐      ┌────────── machine B (server) ───────────┐
│  Fabrica app (Electron)                         │      │  fabrica engine (Node daemon)          │
│   ├─ Main ─ windows, lifecycle, updates          │ SSH  │   ├─ RPC server (socket, bridge, TLS)   │
│   ├─ Connection (utilityProcess) ─ transports ───┼──────┼──►├─ Projects, Runs, Supervisor         │
│   └─ Renderer (Foldkit) ◄─ MessagePort           │      │   ├─ WorkGraph (SQLite + git sync)      │
│                                                  │      │   ├─ Git, Worktrees, Checks, Organs     │
│                                                  │      │   ├─ Model proxy, Telemetry (DuckDB)    │
│  fabrica engine (local daemon) ◄─ local socket  │      │   └─ Pi agents (child processes, one    │
│   └─ Pi agents …                                 │      │      per worker, each in a worktree)    │
│  fabrica CLI ─ local socket / SSH bridge        │      └─────────────────────────────────────────┘
└──────────────────────────────────────────────────┘
```

| Process | Runs | Owns | MUST NOT |
|---|---|---|---|
| Engine | Node, the engine bundle, Effect runtime | Projects, runs, the work graph (sole writer), git and worktrees, workers' processes, organs, talks, the RPC server, the model proxy and the engine's secrets, telemetry (DuckDB) | Render UI |
| Agent (one per worker, organ session or talk) | Pi in RPC mode plus the first-party extension, on the engine's Node | One session in one worktree (or the project's checkout, read-only, for organs and talks) | Open the work-graph database; hold a model credential; talk to other agents |
| App main | Electron main | Windows, menus, app lifecycle, the app's own secrets (pairing tokens, known engines), updates, starting the local engine, spawning the connection process, brokering MessagePorts | Run orchestration logic; sit in the data path |
| App connection | Electron `utilityProcess` | Connections to engines: the local socket, the SSH and WSL2 bridges (`ssh` and `wsl.exe` as its child processes), TLS; relays RPC frames to the renderer | Render UI; touch a repository |
| App renderer | Foldkit app | UI state (the Foldkit Model) | Access Node, sockets, the file system or any database |
| CLI | The engine distribution's `fabrica` command | One command's work against an engine | Hold state between commands (except `follow` and talks while they run) |

## 6. Language, runtime and repository

\[DECISION\] One TypeScript monorepo, one exact Effect version everywhere; Foldkit's pinned Effect peer version sets that number. Foldkit is pre-1.0 and may break in a minor version; it pins its Effect peers exactly (`effect` and `@effect/platform-browser` 4.0.0 at Foldkit 0.169.0, 2026-10-29, while `effect` 4.1.0 was out), and the monorepo follows that pin and upgrades with Foldkit.

**Versions**

- Effect v4: every `effect` and `@effect/*` package on the same exact version, following Foldkit's pin \[VERIFY current pin\]. The SQL and RPC modules are marked unstable: pin exactly and keep them behind the project's own services.
- Electron: the latest stable major at project start, pinned.
- **Node (engine):** an LTS version pinned exactly and shipped inside the engine distribution. It MUST provide `node:sqlite`, `child_process` and Unix domain sockets \[VERIFY `node:sqlite` stability in the pinned version\]. The app's renderer and main use Electron's bundled Node, but no orchestration code runs there.
- Pi (`@earendil-works/pi-coding-agent`): exact version, upgraded deliberately with its contract tests (§24).
- Foldkit: exact version, pre-1.0; upgrade with the vendored subtree and `FOLDKIT.md` (§23).

**Toolchain**

- pnpm workspaces. electron-vite builds the app's main, preload, connection process and renderer (with `@foldkit/vite-plugin`) \[VERIFY utility-process entry support\]. The engine is bundled separately (a Node bundle plus Pi, §22).
- Type checking with `tsgo` (TypeScript's native port), which gates the build and runs after every agent's file write; `tsc` kept runnable for any check `tsgo` doesn't do yet; the Effect Language Service in editors through `@effect/tsgo`, TypeScript-Go with the Effect plugin (the tsserver plugin `@effect/language-service` doesn't load in `tsgo`), the type checks run through it (`effect-tsgo tsc`), so its errors and warnings gate them as type errors do, its suggestions shown in editors only (H40).
- oxlint with `@foldkit/oxlint-plugin`, and oxfmt.

**Layout**

```text
apps/desktop/            Electron main, preload, connection process, packaging config
apps/engine/             The engine's entry points: daemon (`fabrica serve`) and the CLI
packages/contracts/      Effect Schema: domain types, the client RPC protocol, extension tool payloads,
                         ticket files, settings, events (depends on effect only)
packages/engine/         Effect services: Engine, Projects, RunLoop, Supervisor, WorkGraph, GitSync,
                         Git, Worktrees, Checks, AgentPool, PiAgent, Organs, Talks, Attention,
                         UsageLimits, Telemetry, Secrets, RpcServer
packages/pi-extension/   First-party Pi package loaded into every agent: tools, gate, rules
packages/client/         The RPC client and connection management, shared by app and CLI
packages/ui/             Foldkit renderer app
repos/                   Vendored git subtrees (Foldkit, Effect, Pi), read-only reference
```

`contracts` is the shared vocabulary: every package imports it; it imports nothing but `effect`.

**Code rules** \[DECISION\] (H79): each rule lives in one module (how a git status is read, whether a process is alive, finding a command on the PATH it will run with, a command's environment, what a phase counts as, the keys a screen binds), and each value is read once per decision and passed on, with independent reads run side by side. Outcomes are tagged unions with constructors, matched exhaustively, never object literals told apart by their fields, and never sentinel values (`""` for a commit git couldn't give, `-1` for a count it couldn't make). Ticket IDs, commit hashes, session and message IDs are branded types, made only where they are read or drawn, and functions taking several of them take them by name. Services at process and I/O boundaries are named spans (`Effect.fn`). tutti's two design reviews (tutti-axpo, 2026-10-23; tutti-rvzn, 2026-10-24) traced most of their bugs to a rule restated in several places that had drifted, and found a third of a merge's git reads repeating one made a few lines before.

## 7. The engine

### 7.1 Lifecycle

- \[DECISION\] One engine per user per machine. A second `fabrica serve` finds the first through its socket and its lock (`<data>/engine.lock`, `flock`) and exits, saying so.
- Locally, the app starts the engine when it can't reach one, as a detached daemon from the engine distribution it bundles, or installs it as a login service (launchd agent, systemd user unit) when the user chooses. On a server it is a systemd user unit (with linger enabled, so it runs without a login session \[VERIFY per distribution\]) or a launchd agent.
- Closing every client leaves runs running. Stopping the engine (`fabrica engine stop`, the service manager, SIGTERM) winds its runs down as orchestra's SIGTERM does: no new tickets, running workers' sessions saved, a carry-over for the next start (§13.10).
- Everything with a lifetime is an Effect scoped resource. The engine's root scope ends its runs, then its agents, then its servers.
- **What a scope held goes with it** (H77): everything held for a worker, a ticket or a run (its transcript in memory, subscriptions, fibers, open files) is released when its ticket is done or its run ends, not when the engine stops; the soak test (§24) holds memory and handles flat over many runs. tutti kept every worker's last 200 messages, two open files and a fiber until its run ended (tutti-7y43), and its process lives one run; the engine lives for weeks.

### 7.2 Data folder

The engine's data folder (`<data>`): `~/Library/Application Support/fabrica/` on macOS, `$XDG_DATA_HOME/fabrica/` on Linux.

```text
<data>/engine.db            Engine state: projects, hosts it pushes to, tokens (hashed), settings
<data>/engine.sock          The local RPC socket (mode 0600), or under $XDG_RUNTIME_DIR on Linux
<data>/engine.lock          The single-instance lock
<data>/projects/<id>/sessions/<ticket>/  Pi's sessions for a ticket (§12.1), for every project
<data>/projects/<id>/repo/  A cloned project's checkout (§10.1)
<data>/projects/<id>/worktrees/  A cloned project's worktrees
<data>/secrets/             The encrypted-file secret store, where no keyring exists (§20.3)
<data>/telemetry.db         The telemetry rows, from M1 (§21, H65)
<data>/telemetry.duckdb     The telemetry query layer, from M6 (§21)
<data>/logs/engine.log      The engine's own log
```

A project's own files are under `<repo>/.fabrica/` (§10.2).

The app's own data (Chromium's storage, the theme its window opens in) is in Electron's userData, which a packaged app names after itself: `~/Library/Application Support/solutions.noesis.fabrica/` on macOS, after its ID, since `Fabrica` would be the engine's `fabrica` on a case-insensitive disk; `~/.config/Fabrica/` on Linux and `%APPDATA%\Fabrica\` on Windows. A development build keeps Electron's own, named after its package.

### 7.3 Projects and runs

- The engine holds any number of projects and runs any number of them at once, one run per project.
- **The machine-wide worker budget** \[DECISION\]: `machine_workers` (engine setting, default half the CPU cores, at least 2, H35: workers mostly wait on the model, but their checks are CPU-heavy, and orchestra's runs slowed sharply past about 4 checks at once on a 10-core laptop) caps the workers live across every run on the engine. A run with a free slot waits while the budget is reached (`HOLD: MACHINE`, §14.3). This replaces orchestra's machine-wide registry: one engine sees all its runs. The budget counts the slots the scheduler counts, through the same function (H56): a ticket past its work that holds no slot (§13.4) isn't a live worker. tutti counted tickets waiting to merge, held when it had a free slot and paused its merge train; orchestra fixed the same in 0.9.4.
- Workers share each machine's cores: each worker's environment carries its share (`FABRICA_CORES`, and `GOFLAGS=-p <n>` for Go projects), from the cores divided among the live workers (orchestra-nr1v.14). The engine's own checks (the merge check, the train's, the full check), setups and organ sessions get a share too, counted among the live workers (H56): in tutti a merge check ran with none, and its tests took every core beside the workers' own checks.
- **CPU priority** (H73): each worker's agent process starts at nice 10 (`worker_nice`, an engine setting), never raising one where the engine itself runs lower, so its commands and checks inherit it; the engine's merge check, the train's, the full check, the setups before them, organs and talks keep the engine's own priority. The priority is read back as it is set and again 100 ms later, and set again where something raised it back, which the engine's log says once: on GitHub's macOS runners a lowered process was back at nice -10 within 100 ms (tutti-djtt, 2026-10-29). In tutti the merge check, which holds the queue, took 79 s on an idle machine and a median 343 s with 4 workers and a second check beside it (tutti-ejkt.12); whether nice 10 shortens it is measured from 4-worker runs' check records (tutti-eqyr). Priority doesn't help where memory is short.

### 7.4 Load

The engine samples its host's load every few seconds for the console's system stats (§18.3): each worker's process tree and the merge check's memory, the kernel's memory pressure (macOS) or pressure-stall information (Linux), swapping, and the 1-minute load against the cores (orchestra-recj, -556h).

### 7.5 Logs

- `<repo>/.fabrica/fabrica.log`: the human log per project, orchestra's line formats (dispatching, footprint, settled, merged, hold lines, warnings).
- `<repo>/.fabrica/run/events.jsonl`: the event stream per project (§13.12).
- `<data>/logs/engine.log`: the engine's own log (connections, updates, errors outside projects).

### 7.6 Windows

\[DECISION\] (H31) The app on Windows connects to a remote engine, or runs one in WSL2, which it treats as one more host:

- It looks for a WSL2 distribution, offering to install Ubuntu (`wsl --install -d Ubuntu`) when there is none.
- It installs the Linux x64 engine distribution it embeds inside that distribution, with the steps it runs over SSH (§9.2) run through `wsl.exe -d <distro> --` instead.
- It connects with `wsl.exe -d <distro> -- fabrica bridge` (§8.2), which starts the engine when it isn't running.
- Projects live in the distribution's Linux file system, where git is fast and POSIX semantics hold; the app warns about a checkout under `/mnt/c`.
- WSL2's own lifetime applies: the distribution shuts down some time after its last process ends, so the engine runs as a systemd user unit inside it where the distribution has systemd enabled \[VERIFY WSL's systemd support and idle shutdown with a running service\].

### 7.7 Sleep and time awake

\[DECISION\] (H66, H67, H84)

- **Time awake.** Every time limit (a command's: checks, setup, git; a ticket's; an idle grace; a hand-back's; an organ's; a session's start and first turn; an abort's; the environment probe's; a question's wait) counts the time its host is awake, not wall time. The engine's wake service reads the wall clock every second; a gap of more than 15 s is a sleep, which puts off every limit it crossed and is recorded (`SLEPT: the host slept 34m (14:03–14:37); limits don't count it`, a `slept` event), with its cause where the OS logs one (`pmset -g log` on macOS: lid closed, battery low, idle, asked to sleep). Usage-limit resets, leases (§11.5) and sync schedules stay wall-clock. tutti's limits counted wall time, so a laptop that idle-slept 33 minutes across a merge check that had run a minute failed it at the wake (`did not finish within 30m`), setting its ticket aside, and its tracker calls failed too (tutti-dhyy).
- **Keeping awake.** While a run goes, the engine keeps its host from idle sleep (`caffeinate -i -w <pid>` on macOS, `systemd-inhibit` on Linux) unless the engine's `keep_awake` is false; an overnight run keeps it awake whatever the setting says (§15.6). The engine holds this, not the app, so a run on a remote engine keeps its server awake with no client attached; where there is no sleep to prevent, it does nothing. It prevents idle sleep only: a closed lid still sleeps a laptop on battery or without an external display, which the run's start says on a host with a battery, and which the `SLEPT` line names. tutti kept the machine awake only with a flag, and a run started without it slept mid-ticket; the maintainer made it the default (tutti-22jf).
- **Battery.** A run that starts on battery says so. While it goes, the engine reads the battery once a minute and warns at 20% and at 10% while discharging (an event, a banner, and a notification at 10%) (tutti-yhjt).
- **Clocks.** Durations are measured on a monotonic clock, never as the difference of two wall times, so a wall clock stepping back can't make one negative and drop its record (tutti-5mlh). Times recorded carry their UTC offset (§13.12), and clients show them in the viewer's time zone, with the day when it isn't today: an engine and its client may be in different zones.

## 8. Client–engine protocol

### 8.1 Protocol

\[DECISION\] Effect RPC (`effect/unstable/rpc`: `RpcServer`, `RpcClient`, `RpcSerialization`) with JSON serialisation, framed as NDJSON on byte streams (the local socket, the SSH and WSL2 bridges). Every request, stream and error is an Effect Schema in `packages/contracts`, decoded on arrival. The schemas are also exported as JSON Schema for clients in other languages.

**Groups**

| Group | Requests | Streams |
|---|---|---|
| Engine | `version`, `status`, `settings`, `stop`, `update` | engine status, load |
| Hosts and tokens | `tokens.create`, `tokens.list`, `tokens.revoke` | |
| Secrets | `credentials.set`, `credentials.list` (names only), `credentials.remove`, `credentials.login` (a subscription's OAuth sign-in, run by the engine, §20.3) | a login's progress (the sign-in URL or device code to show) |
| Projects | `projects.add` (path or URL), `folders` (a folder's subfolders on the engine's host, for browsing to a checkout), `list`, `remove`, `trust` (the maintainer's alone, §12.1), `settings.get`, `settings.set`, `init` | project status |
| Backlog | `tickets.list`, `show`, `create`, `update`, `close`, `dep.add`, `dep.remove`, `label`, `note`, `ready`, `why` (what holds a ticket back), `import` (Beads JSONL, §11.6) | backlog changes |
| Runs | `run.start` (mode, flags), `run.stop`, `run.drain`, `run.undrain`, `run.status`, `run.preflight` | the run view (§8.3), the run's events |
| Workers | `worker.message`, `worker.interrupt`, `worker.release` | a worker's transcript |
| Attention | `attention.list`, `attention.answer` | open requests |
| Talks | `talk.open` (mode, context), `talk.send`, `talk.close` | a talk's transcript |
| Review | `diff.ticket`, `diff.run`, `report.get`, `log.tail` | |
| Insights | `insights.summary`, `insights.query` (a named query with its parameters; no SQL from clients), `insights.export` (the recorded rows as Parquet files in a folder on the engine's host, §21) | |

### 8.2 Transports

| Where | Transport |
|---|---|
| Same machine | Unix domain socket `<data>/engine.sock` (or `$XDG_RUNTIME_DIR/fabrica/engine.sock`), mode 0600, through Effect's `Socket` (`RpcClient.makeProtocolSocket`) |
| Remote, default (H30) | **The SSH stdio bridge.** The client runs the system's `ssh <destination> fabrica bridge` (OpenSSH; the user's config, keys and agent), falling back to `~/.local/bin/fabrica` (§9.2) where the host's PATH for a non-interactive ssh command lacks it. On the host, `fabrica bridge` connects to the engine's local socket (starting the engine when it isn't running) and copies bytes both ways, so the RPC runs over ssh's stdin and stdout. No port opens on either machine and nothing is forwarded; it works the same with Windows' OpenSSH client. SSH keepalives (`ServerAliveInterval`) detect a dead link; the client reconnects and resumes its streams (§8.3) |
| WSL2 (H31) | The same bridge, run as `wsl.exe -d <distro> -- fabrica bridge` |
| Remote, option | WebSocket over TLS on a configured address (`RpcServer.makeProtocolWebsocket`), authenticated with a pairing token (§9.3) |

In the app, the connection process (a `utilityProcess`) owns every transport (it runs `ssh` and `wsl.exe` as its children) and relays frames to the renderer over a `MessageChannelMain` port that main brokers once; main then leaves the data path \[VERIFY M0: Effect RPC over a child process's stdio and over a MessagePort relay\]. The CLI uses the same client package directly.

### 8.3 Streams and the run view

- The engine keeps, per run, a **run view**: an immutable projection of what the console shows (§18.3) (totals, ticket rows, workers, the merge queue, holds, banners, open attention requests, the load). It is written by its own fiber, at most every 50 ms (`view_interval`, an engine setting; H40), with unchanged parts keeping their identity (tutti spec §3.5), and published only when a part changed: Effect's `SubscriptionRef` publishes every set, changed or not, so tutti's status writers published the same values many times a second, and its equality check took any two Maps for the same (tutti-rvzn.4). Every engine step that takes more than a second (the start's checks, a setup, the merge check, the full check and its setup, the report, an install, a breakdown) is in the view with its start time, so a client shows what the run is doing and for how long (H80). Every interval and rate is a whole number of milliseconds (H55): tutti's `1000 / 30` ms left its tests' `TestClock` at a fraction of a millisecond, and a count in its event schema failed to decode.
- A stream sends a full snapshot, then patches, each with a sequence number. A client that reconnects asks for patches after its last sequence number; one too far behind gets a new snapshot.
- High-frequency events (tokens, tool output) are batched before they cross, one flush per 50 ms (`stream_flush`, an engine setting; H40). Over SSH to a distant host both MAY be lowered per connection. The renderer applies updates at most once per animation frame.
- Transcripts are streamed per worker, only while a client shows that worker.

### 8.4 Versions

\[DECISION\] The protocol carries a version. At connect, client and engine exchange theirs; the engine supports the current version and the one before. A client too old for an engine, or the reverse, is told so and offered the update (§9.2). Persisted data (SQLite, ticket files, settings) is versioned through migrations.

### 8.5 Several clients

\[DECISION\] Any number of clients may attach to an engine at once (H8). They see the same state. A command is applied in the order the engine receives it; the first answer to a question or permission request wins, and the others see it answered, by whom (which client) and when.

## 9. Remote engines

### 9.1 Reaching an engine

- \[DECISION\] An engine listens only on its local socket unless TLS is configured. Clients reach remote engines through SSH: the app's "Add engine" takes an SSH destination (`user@host`, or a host from `~/.ssh/config`), and the connection process runs the SSH stdio bridge (§8.2), one `ssh` process per engine connection, every stream multiplexed over it (H30).
- Host keys are SSH's own (`known_hosts`): a first connection to an unknown host shows its fingerprint for the user to accept; a changed key refuses the connection, as `ssh` does. Interactive prompts (a key's passphrase, a password) are relayed to the app through `SSH_ASKPASS` \[VERIFY on Windows' OpenSSH\].
- The app keeps its known engines (name, SSH destination or TLS address, the engine's ID and protocol version) in its own state; pairing tokens in `safeStorage`.

### 9.2 Installing and updating

\[DECISION\] From "Add engine", the app checks the host over SSH (OS, architecture, an engine already there and its version), uploads or downloads the matching signed engine distribution, verifies its signature, unpacks it to `~/.local/share/fabrica/engine/<version>/`, links `~/.local/bin/fabrica`, installs the user service and starts it. Later versions update it the same way, with the user's consent; the engine finishes or winds down its runs before it restarts (`fabrica engine update` does the same by hand). The same steps install and update the engine in WSL2, run through `wsl.exe` (§7.6). The install script (`curl … | sh`) remains for hosts set up by hand.

### 9.3 TLS and tokens

- `fabrica serve --listen <addr>` (or the engine setting) adds a WebSocket listener over TLS, with a certificate the user provides or one the engine creates and pins (the app trusts it on first pairing, showing its fingerprint).
- `fabrica token create` prints a pairing token once; the engine stores only its hash. Tokens are listed and revoked by name. A token grants everything (H8: one person per engine).

## 10. Projects

### 10.1 Adding a project

\[DECISION\] Either:

- **Register a checkout** already on the engine's host (a path the engine can read; the app browses the host through the engine), or
- **Clone** from a git URL into `<data>/projects/<id>/repo/`, with the host's git credentials.

Either way the engine checks the project as `orchestra init` and a run's start do (§13.1), and offers `init` where `.fabrica/` is missing.

`init` is atomic (H62): it writes `settings.json` first, or stages its files and renames them in together, so a failure leaves the project as it was or set up, never half set up; a project counts as set up only once its settings exist, and on an error `init` lists what it had written. tutti wrote its worker prompt first and its settings last, and a failure between left a project that counted as set up with no merge check, whose next run merged unchecked.

### 10.2 The project's files

```text
<repo>/.fabrica/settings.json   Committed. The project's settings (§13.13)
<repo>/.fabrica/worker-rules.md Committed. The project's own worker rules, added to the standing rules (§12.4)
<repo>/.fabrica/specs/          Committed. Specs from outside the repository, copied in by spec runs
<repo>/.fabrica/work.db         Ignored. The work graph's SQLite store (§11.2)
<repo>/.fabrica/run/            Ignored. Per-run and per-ticket files, the event stream, check logs
<repo>/.fabrica/reports/        Ignored. Run reports
<repo>/.fabrica/fabrica.log    Ignored. The human log
```

Worktrees: `<repo>-worktrees/<ticket>` beside a registered checkout (orchestra's layout), `<data>/projects/<id>/worktrees/<ticket>` for a cloned one; branch `fabrica/<ticket>`. A worktree is kept for review when its ticket is set aside, removed with its branch when it merges \[DECISION\].

### 10.3 Base, fetching and pushing

- \[DECISION\] Before a run, when Base has an upstream, the engine fetches it and fast-forwards Base if the upstream moved and Base has no commits of its own; if they diverged, the run starts on Base as it is and says so (`BASE_DIVERGED`).
- `push` (project setting): `never` (default for a registered checkout, as orchestra), `after_run` (default for a cloned one: push Base once the run's full check passes), `after_merge`. A push that isn't a fast-forward is not made and is reported (`PUSH_REFUSED`); the engine never forces.
- The tickets ref syncs on its own schedule, independent of `push` (§11.4).
- \[DECISION\] (H47) Pull requests come after v1: a later `push: pull_request` pushes a run's Base as a branch once its full check passes and opens one pull request for the run, the run report as its body. v1 merges into Base as orchestra does.

## 11. The work graph

### 11.1 The tracker interface

\[DECISION\] Every ticket operation goes through the `WorkGraph` service, the only code that knows the backend. The local tracker (§11.2–11.5) is the only backend built. Adapters for JIRA, Linear or GitHub Issues MAY follow; each defines its own sync, and declares which capabilities it has (questions, typed results, area labels), the engine degrading where one lacks them.

**Interface:** `ready` (orchestra's rule, §13.3), `show`, `list`, `create`, `update`, `claim`, `release`, `close`, `reopen`, `defer`, `undefer`, `addDependency`, `removeDependency`, `label`, `unlabel`, `note`, `fileDiscovered`, `ask` (a question), `answer`, `delete` (a tombstone, §11.7), `history`, `changes` (a stream). `close` offers to close what the ticket blocks with it.

### 11.2 The local store (SQLite)

\[DECISION\] SQLite through `@effect/sql-sqlite-node` (`node:sqlite`), one database per project at `<repo>/.fabrica/work.db`, git-ignored, the engine its single writer, WAL, writes that must be atomic in `withTransaction`, forward-only migrations bundled with `fromRecord` or `fromGlob` (never `fromFileSystem`, whose paths break inside a bundle), a backup with `SqliteClient.backup` before each migration, and a database newer than the engine refused; one serialised connection, with a 5 s busy timeout. `node:sqlite` is synchronous, so a query blocks the engine's event loop while it runs: queries stay small and indexed, and anything long (a rebuild from the ref, an import) runs in batches that yield between them. `sql.reactive` streams the backlog and the ready set to the run view. Reads are in-process: each of tutti's Beads calls took 0.45–0.75 s and Beads' embedded database served them one at a time (three side by side took longer than in a row), so only fewer calls helped, and five of its speed tickets did nothing else (tutti-ejkt.5, -ejkt.6, -gr4z.6, -gr4z.7, -0vbd.5).

**Schema** (orchestra's ticket model):

```sql
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,                -- <prefix>-<short hash>, e.g. fa-a1b2; children <parent>.<n>
  type TEXT NOT NULL CHECK (type IN ('task','bug','feature','chore','epic','question','manual')),
  title TEXT NOT NULL,
  description TEXT, design TEXT, acceptance TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','deferred','closed')),
  resolution TEXT CHECK (resolution IN ('done','no_change','cancelled','superseded','answered')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  defer_until INTEGER,
  assignee TEXT,                      -- the worker's session id while in progress
  model TEXT,                         -- per-ticket provider/model override (H3)
  metadata TEXT NOT NULL DEFAULT '{}',-- JSON: files, spec, predicted_files, result_kind, …
  result TEXT,                        -- JSON hand-off from finish (§13.5)
  options TEXT, recommended INTEGER,  -- questions: 2–4 options, the recommended index
  answer TEXT,                        -- questions: the maintainer's answer
  merged_commit TEXT,                 -- set by the merge queue
  close_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  clocks TEXT NOT NULL                -- JSON: each field's hybrid logical clock (§11.3)
);
CREATE TABLE labels (ticket_id TEXT NOT NULL REFERENCES tickets(id), label TEXT NOT NULL,
  PRIMARY KEY (ticket_id, label));
CREATE TABLE edges (
  from_id TEXT NOT NULL REFERENCES tickets(id), to_id TEXT NOT NULL REFERENCES tickets(id),
  kind TEXT NOT NULL CHECK (kind IN ('blocks','parent','discovered_from','related')),
  PRIMARY KEY (from_id, to_id, kind));
CREATE TABLE notes (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  author TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE events (seq INTEGER PRIMARY KEY, ticket_id TEXT, type TEXT NOT NULL,
  actor TEXT, payload TEXT, at INTEGER NOT NULL);
CREATE TABLE leases (               -- engine-local; never synced
  ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), engine_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE TABLE check_own_passes (     -- engine-local; never synced; the last pass has the highest seq
  seq INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), tree TEXT NOT NULL,
  UNIQUE (ticket_id, tree));
```

**Rules**

- Reject cycles on insert of `blocks` and `parent` edges. Index `edges(to_id)`, `tickets(status, priority, created_at)`, `labels(label)`, `events(ticket_id)`.
- Every mutation appends an `events` row in the same transaction, with its actor (the maintainer through a client, a worker's session, an organ, the engine).
- Rows decode into Schema classes from `contracts`; the same types reach the UI unchanged.
- A lease renews from its worker's activity; an expired lease (the engine crashed) returns the ticket to the carry-over on the next start (§13.10), not straight to `ready`.
- `check_own`'s passes are kept by the tree each ran on (H89), so a carried-over ticket's passes, and its `FABRICA_CHECK_OWN_PASSED_AT`, outlast the engine's restart (§13.10); they are dropped in the transaction that closes the ticket (its merge closes it) or deletes it.

### 11.3 The tickets ref

\[DECISION\] The backlog's synced record is a git ref of its own, `refs/fabrica/tickets`, with no history shared with the code. Its tree holds one JSON file per ticket, `tickets/<id>.json` (fields as the schema above, labels and edges inside the file, notes as an array of `{id, author, body, at}`), plus `meta.json` (the ID prefix, the schema version) and `lease.json` (the run lease, §11.5).

- **Clocks** (H32): each field carries the hybrid logical clock of its last change, in a `clocks` object beside the values (`"clocks": {"title": "<hlc>", "status": "<hlc>", …}`). A clock is the wall time in milliseconds, a counter and the engine's ID; an engine's clock never runs behind any clock it has merged, so a host whose wall clock is behind still orders its changes after what it has seen. Two engines changing different fields of a ticket both keep their change; the same field goes to the later clock, ties broken by engine ID, so every engine merges to the same result.
- **Commits** (H33): the engine is the ref's only writer on its host. It batches changes for at most 2 s into one commit on the ref, and commits at once on a run's transitions (a claim, a close, a merge, a question asked or answered, the run lease), with the engine's ID as author.
- SQLite can always be rebuilt from the ref (`fabrica tickets rebuild`); the ref is what travels with the repository.
- Live-only state stays out of it: ticket leases (§11.2), attempt counts, transcripts. The run lease (§11.5) is the one lease on the ref.

### 11.4 Sync and merging

- **Cadence** (H33): when the repository has a remote, the engine pushes the ref after each commit it made (a failed push is retried with backoff; a non-fast-forward is fetched and merged first), and fetches it at a run's start, every 60 s during a run, before each claim, on demand (a client's refresh), and every 15 min for a project with no run.
- **Merging** \[DECISION\]: the engine merges the ref itself (not git's merge machinery), three-way per ticket file against the merge base:
  - a ticket changed on one side only: that side;
  - notes: the union, by note ID;
  - labels and edges: as sets, adds and removes reconciled against the base;
  - plain fields: the later hybrid logical clock wins, ties broken by engine ID;
  - `status`: a fixed precedence where both changed (`closed` over `in_progress` over `deferred` over `open`), a `reopen` after a close winning by its clock;
  - `assignee`: only the engine holding the run lease claims tickets (§11.5); a claim made under a lease that has since expired loses to the current holder's.
  
  The merged state is committed on the ref and applied to SQLite in one transaction. Merging is property-tested (§24).
- Ticket IDs carry a random part, so two engines never mint the same ID \[VERIFY collision rate for the chosen length\].

### 11.5 One engine runs a project at a time

\[DECISION\] (H34) Several engines MAY hold the same project (a laptop's checkout, a server's clone) and edit its backlog, but only one runs it at a time. The **run lease** is `lease.json` on the tickets ref: the engine's ID and name, its host, the run's ID, when it was last renewed, and its expiry.

- A run's start fetches the ref first. If another engine's lease hasn't expired, the run refuses to start (`PROJECT_LEASED`, exit 2), naming that engine, its host and when it last renewed. Otherwise the engine writes its own lease in a commit and pushes it at once; if the push loses to another engine's lease (the merge keeps the earlier lease), the start is refused the same way.
- The holder renews the lease every minute, with its regular sync, and removes it when the run ends. A lease not renewed for 5 minutes has expired (its engine crashed or lost the network); the next run may take it over and says so (`LEASE_TAKEN_OVER`); a holder that finds its lease taken over stops dispatching and drains.
- A claim is a field on the ticket (`assignee`: the engine's ID and the worker's session); only the lease's holder writes it.
- Edits from an engine not holding the lease (the maintainer filing tickets on the laptop while the server runs) sync as any change does; the holder sees them within a minute.
- The app shows, on every engine holding the project, which engine is running it.
- With no remote, the lease lives on the local ref and only guards engines sharing that checkout.
- **Without the remote** \[DECISION\] (H41): an engine that can't reach the remote at a run's start can't see a lease held elsewhere, so the run refuses to start (`REMOTE_UNREACHABLE`, exit 2, with the remote's error) unless `--offline` is given. An offline run's start line and the app say its lease is unchecked; the engine pushes the lease as soon as the remote answers.
- **A clash on reconnecting** (H41): if another engine's lease covers the same time, the lease with the earlier start wins. The later run stops dispatching, finishes and merges what it has running, and ends `DRAINED`, naming the other engine (`LEASE_CLASH`). A ticket both runs worked on is reconciled by the ref's merge rules (§11.4; a close wins), and the losing branch is kept for review.

### 11.6 Interop

- \[DECISION\] (H40) `fabrica tickets import --beads <file>` brings a Beads backlog (a `bd export` JSONL file, such as orchestra's and tutti's) into a project's work graph, mapping types, statuses, priorities, labels, dependencies (blocks, parent-child, discovered-from, related), notes, design, acceptance and metadata; a Beads ticket labelled `human` with options in its metadata (orchestra-tnei.1) becomes a `question` \[VERIFY Beads' JSONL fields at the version in use\]. IDs keep their prefix. An import into a project with tickets merges as §11.4 does. Export to Beads comes later, when someone needs it.
- Keep all SQL inside the local tracker's implementation and within SQLite's dialect, so a later engine (Turso Database, libSQL) is a Layer swap (§27.1).

### 11.7 The ref in git

\[DECISION\] How the engine keeps `refs/fabrica/tickets` (§11.3, §11.4), so that no checkout, index, `HEAD` or stash of the user's is ever touched:

- **Writing** with git's plumbing only: `git hash-object -w --stdin` for each changed file, `git mktree` for each folder and then the root (or a temporary index through `GIT_INDEX_FILE` with `read-tree`, `update-index` and `write-tree` \[OPEN which\]), `git commit-tree` with its parents, then `git update-ref refs/fabrica/tickets <new> <expected-old>`, which fails when another process moved the ref meanwhile, and the cycle runs again. A commit's author is the engine's ID (§11.3), its message `tickets: <n> changed (<engine>)`. Plumbing runs no git hooks \[VERIFY for each command used\].
- **Reading**: `git ls-tree -r <commit>` lists the files, `git cat-file --batch` reads them in one process, `git merge-base` finds the base of a three-way merge, and `git diff-tree --name-status` lists what changed, so an import reads only the files that changed.
- **Transport**: fetch and push name the ref explicitly \[VERIFY the refspecs for a ref outside `refs/heads/`\], with the host's own git configuration, keys and credential helpers; the engine stores no git credentials. Every git command runs with `GIT_TERMINAL_PROMPT=0`, no pager, `LC_ALL=C` and the environment of §20.2, so it never waits for input and its output parses the same everywhere.
- **Hosted remotes** (fab-mgi.2.10, 2026-10-30, from `ls-remote` and explicit-refspec fetches of public repositories and the hosts' docs and source, listed in §29; no test push, by the maintainer's choice in fab-mgi.83): GitHub, GitLab and Bitbucket all hold refs in namespaces of a repository's own (git-bug's `refs/bugs/*`, histories of their own, on GitHub; `refs/replace/*` on gitlab.com; `refs/remotes/*` on Bitbucket Cloud), list them in `ls-remote` and serve them to an explicit refspec. Housekeeping keeps them: a ref is a root for git's gc, and GitLab's own keep-around refs rely on it \[VERIFY a pushed ref's age on each host\]. Each reserves only its own namespaces: GitHub `refs/pull/`; GitLab `refs/merge-requests/`, `refs/pipelines/`, `refs/environments/` (read-only) and `refs/keep-around/`, `refs/remotes/`, `refs/tmp/` (hidden); Bitbucket its pull-request refs. A push there fails `deny updating a hidden ref`; `refs/fabrica/` is in none of them. Branch and tag protections (GitHub's branch and tag rulesets, GitLab's protected branches, Bitbucket Cloud's branch restrictions) don't reach the ref. What can still refuse its push: GitLab's commit push rules (signed commits, the author a GitLab user, the author's email, the message's pattern), which apply to commits on any ref; GitHub's push rulesets and secret-scanning push protection, which apply to every push \[VERIFY on the ref\]; Bitbucket Data Center's branch permissions, whose patterns match any ref's suffix; and a self-hosted server's pre-receive hooks, which see every ref. Such a refusal (`! [remote rejected] refs/fabrica/tickets (…)`) is shown in the app with the host's message and waits for the next scheduled sync, as a refused authentication does. Forks don't carry the ref (GitLab's fork is a bare clone of branches and tags), and GitLab's Geo might not sync it.
- **Canonical files**: UTF-8, LF line endings, two-space indent, a trailing newline; keys sorted by code point, every field present (`null` or `[]` when empty); lists of IDs sorted and de-duplicated, one to a line; times ISO 8601 in UTC with milliseconds; each file decoded with its Schema from `contracts`. The same state always serialises to the same bytes, so a sync with nothing changed makes no commit and writes nothing to SQLite, and importing a commit twice changes nothing.
- **Sync state** kept in SQLite: the last commit pushed, the last commit imported, the engine's ID and the last clock it issued.
- **Import** applies the files changed between the last commit imported and the new head in one transaction (tickets upserted, their labels and edges rebuilt, tombstoned tickets removed), then records the commit.
- **Deletion**: a ticket's file goes only through an explicit deletion, which writes a tombstone (`tombstones/<id>.json`, with its clock and engine, pruned after 90 days); a ticket missing from SQLite never removes its file, so a fresh or broken database can't wipe the backlog. A deletion against an edit on the other side loses to the edit, with a conflict recorded: work is never lost silently.
- **After a merge**: a merge can make a `blocks` cycle that neither side had; the edges are kept, the tickets marked blocked by the cycle, and the app says so. An edge to a missing or tombstoned ticket is dropped and logged. Each field both sides changed records a `merge_conflict` event with both values, which the app lists with "use the other value"; sync never stops for a conflict.
- **Failures** leave SQLite and the ref as they were: a crash between commit and push is harmless (the next sync pushes it); a crash during an import rolls its transaction back, the last commit imported unchanged; offline or a refused authentication shows in the app and waits for the next scheduled sync, never a retry storm; `git` missing or too old turns sync off with a clear message. The ref is never force-pushed: its history only grows.
- **Versions**: `meta.json` carries the layout's version, and each file a `v` for its record's shape. Readers take their version and every older one, upgrading records in memory through Schema transformations; writers write the newest they know, a new field with a default; a layout newer than the engine stops sync and asks for an update, and an engine never writes an older format over a newer one. A file that fails to decode is quarantined: skipped, its local copy kept, an event recorded and shown in the app.
- **Privacy**: what the ref holds goes to the project's remote, and titles, descriptions, notes and results can hold code, paths or business details. The app names the remote before the first push; a result over 64 KB stays local \[OPEN the cap\]; transcripts never sync; a secret-pattern check on what is exported blocks the commit and warns \[OPEN which detector\].
- **Tested** (§24): canonical files round-trip and encode stably (properties); the merge is symmetric and merging with the base changes nothing (properties); two simulated engines (two databases, two clones, one bare remote) converge after concurrent edits, deletions, offline periods and rejected pushes; failures injected between each step converge with no lost edit.

## 12. Workers

### 12.1 Process model

\[DECISION\] Each worker is a Pi process in RPC mode over stdio, owned by the engine as an Effect scoped resource behind a `PiAgent` service; Pi's Promise and RPC surface never leaks past it. `sjunepark/pi-effect` is a reference for that boundary (interruption mapped to the session's abort, event streams that lose nothing); Fabrica writes its own adapter and doesn't depend on it.

- Spawn: the engine distribution's Node running Pi's CLI as `pi --mode rpc --extension <the first-party extension> --session-dir <data>/projects/<id>/sessions/<ticket>/`, cwd the ticket's worktree, in a process group of its own. RPC mode takes JSONL commands on stdin and writes JSONL records on stdout, correlated by `id`; records are split on LF only. Every external command (git, checks, setup) is started in its own group the same way, so a terminal's or a service manager's signals reach the engine alone.
- Each agent's Pi gets a configuration folder of its own, holding only the model proxy's provider entries (§12.9); the user's own Pi configuration and credentials are never read \[VERIFY how Pi's configuration folder is set per process\].
- The engine drives an agent through RPC commands: `prompt` (the first prompt, a hand-back), `steer` (a maintainer's message), `abort`, `set_model`, `switch_session` (resume), `fork`, `get_session_stats`.
- Acquire = spawn + handshake. Release = `abort`, then terminate, then reap, each step within a time limit, so that no caller waits on an agent that doesn't answer (H61; tutti's interrupt had none, and a wedged worker held its hand-back and the merge queue). Effect interruption maps to `abort`.
- Every record Pi writes is decoded with an Effect Schema inside `PiAgent`; a record of an unknown kind, or one missing a field the engine doesn't need, is skipped and logged once, never fatal (H61; tutti's worker state trusted its SDK's types, and one missing field ended a worker).
- Every external command's output is read until the command exits and then for at most a short grace (2 s), so a detached descendant holding the pipes open can't outlive the command's time limit (H61; seen in tutti).
- **Whole trees** (H74): ending a command or an agent (its time limit, a release, a reaper) lists its process tree, then terminates its group and the groups of every descendant (test runners start workers in groups of their own, as `bun test --parallel` does, and Claude Code's shells are detached), and kills what is left after a grace. tutti signalled a check's group alone, and two test workers a killed check left behind spun at 100% CPU for 3 days 17 hours, slowing every merge check after them (tutti-gr4z.1, -6tc). On Linux an engine run as a systemd unit has its cgroup as a backstop \[VERIFY `KillMode=control-group` for a user unit\]. \[VERIFY whether Pi's bash tool starts commands in process groups of their own, as Claude Code's does.\]
- Commands an agent or the engine starts get stdin from `/dev/null`, so none waits on a terminal that isn't there: two of tutti's 237 tickets stalled 30 minutes so \[VERIFY Pi's bash tool\].
- A reaper per worker (as tutti's spec §3.2): if the engine dies without its finalizers (SIGKILL), each worker's group is terminated within seconds.
- A ticket's sessions live in its session folder; a worker's session is resumed with `switch_session` for its hand-backs, after a question is answered, and in the carry-over.
- **One session at a time** (H75): a ticket's agent has one lifecycle, Starting, Open or Closing. A start or resume waits for a closing session's process to exit: tutti resumed a session whose Claude Code was still exiting, and two processes shared one session file and worktree (tutti-j3w). A close during a start cancels the start, and reserving, spawning and closing on interruption are one uninterruptible step, so an interrupted start leaves nothing reserved (tutti-0k95). The session's ID is saved for the carry-over only once the agent has started; a start that fails or is interrupted before then saves nothing, and the next run starts the ticket afresh in the same worktree (tutti-y3d). A message sent to a closing session fails; it is never reported sent (tutti-763l).
- Only the first-party extension loads. It takes part in Pi's `project_trust` step, which runs before a project's own extensions load, and refuses a project's own `.pi/` settings and packages until the user trusts that project.

### 12.2 The first-party extension

| Integration | Pi API | Purpose |
|---|---|---|
| Tools | `pi.registerTool()` (TypeBox schemas) | The worker's control channel (§12.3) |
| Gate | `tool_call` event, which can block a call (`{block: true, reason}`) or change it; a handler that fails blocks the call | The permission policy (§12.6): path confinement, a command policy, blocking `git push`, approvals |
| Standing rules | `before_agent_start` event, editing `systemPromptOptions` | §12.4 |
| Settling | `agent_before_settle` (can ask for one more model call), then `agent_settled` | The nudge for a turn with no outcome (§12.3); tells the engine the agent has settled |
| Trust | `project_trust` | Refuses a project's own extensions until it is trusted (§12.1) |
| Metadata | `pi.appendEntry()` | Orchestration data in the session without spending context |
| Usage | message events | Tokens and model per response, a cross-check of the model proxy's count (§12.9) \[VERIFY the usage fields\] |

Model calls need no hook: they pass through the model proxy (§12.9), which grants permits and counts usage, so the extension doesn't use `before_provider_request` (which providers registered by extensions bypass, Pi issue #7368).

The extension's tools forward to the engine over a per-agent Unix domain socket whose path and token arrive in the agent's environment, speaking the Schema RPC protocol; the token scopes the session to its ticket \[DECISION\]. Tool schemas have one source in `contracts`: each tool's Effect Schema is turned into JSON Schema and handed to Pi wrapped as a TypeBox schema (TypeBox schemas are JSON Schema, `Type.Unsafe`); arguments are decoded again with the Effect Schema in the handler \[VERIFY Pi validates the wrapped schema as given\].

### 12.3 The control channel

\[DECISION\] Everything a worker tells the engine goes through these tools; nothing is read from its final message (it is never read).

| Tool | Does | Enforced by its schema and handler |
|---|---|---|
| `get_ticket` | The worker's ticket: description, design, acceptance, notes, labels, the results of the tickets it depends on (§13.5) | Only its own ticket and those linked to it |
| `file_ticket` | A follow-up or a discovered issue, linked (`blocks`, `discovered_from`, `related`) | A short title (≤ 60 characters); `files`, the files it will change (or `unknown`), which are its footprint (§13.4, H70); a description that opens with the detail, not a restatement of the title; a follow-up that builds on this ticket blocks on it |
| `ask_question` | A question for the maintainer, blocking this ticket or another one | 2 to 4 options, one recommended, each a label and a one-line trade-off (orchestra-tnei.1). A decision about another ticket blocks that ticket. `maintainer_only` for a question asking the maintainer to approve something done in their name, which `--auto-answer` never takes (§15.2) |
| `add_note` | A note on its ticket | |
| `finish` | Ends the work: commits are on the branch, checks passed | The worktree is clean (no uncommitted or untracked files; §13.7 names them otherwise), `check_own` passed on the tree being finished (its tree, commit and output file given; H89), or, where the project says `check_own: none` explicitly, `"none"` in the pass's place, the work finishing unchecked and its outcome saying so (H62; an unset `check_own` is refused, as nothing records a pass), a result payload valid for the ticket's kind (§13.5) |
| `defer` | Ends the turn without finishing: a reason, the work committed so far | |
| `wait_for` | Ends the turn: another ticket must merge first, with what this one needs from it | The ticket is linked as blocked; nothing uncommitted |
| `ask_and_wait` | `ask_question`, then holds the agent on a `Deferred` up to `question_wait` (default 15 min) for the answer; past it, ends the turn as asked | As `ask_question` |

- An invalid payload fails the tool call inside Pi's loop, so the agent retries with the decode error in its context.
- A turn about to end with no outcome tool gets one nudge, inside Pi: the extension's `agent_before_settle` handler asks for one more model call with the nudge ("call finish, defer, wait_for or ask_question"). A second settle with no outcome ends the session as unfinished: the ticket is set aside with a note (§14.5).
- The extension's own tools are always allowed by the gate.

### 12.4 Standing rules

\[DECISION\] The extension injects the standing rules into Pi's system prompt, so they survive compaction: orchestra's worker prompt, adapted (stay in the worktree, never push, run checks once in the foreground with their output kept, give a check its time, tests in new files named after the feature, changelog entries as new lines, throwaway files in a scratchpad, name a file in a ticket only where the ticket will change it, stop only through an outcome tool). The project's `.fabrica/worker-rules.md` is appended. Rules about an action live in that tool's description, not in the prompt. The template's version is recorded per project (`settings.templates`), and an older project's rules are flagged at a run's start (orchestra-nr1v.3). A resumed session is told in its resume message what changed since it began (the rules' version, the requirements list), not only through the system prompt: tutti's resumed workers kept the system prompt their session started with, and never heard of a requirements list a merge had changed (tutti-ca7y) \[VERIFY whether Pi runs `before_agent_start` again for a resumed session\].

### 12.5 Models

- \[DECISION\] `model` (project setting): a provider and model (`anthropic/claude-…`, `openai/…`, `openrouter/…`, `ollama/…`) and, where the provider takes one, a thinking or effort level; a ticket's `model` field overrides it.
- `model_fallbacks`: models tried in order when the chosen one fails to start (missing or rejected credentials, the provider unreachable). A usage limit is not a start failure (§14.2), nor is a credential refused once the run has begun (§14.6). A ticket's hand-backs and resumed sessions always use the model that wrote it.
- No credential reaches an agent: every model call goes through the engine's model proxy (§12.9), which holds the credentials from the secret store (§20.3).

### 12.6 Permissions

\[DECISION\] `permissions` (project setting) is enforced by the extension's `tool_call` gate:

| Level | Allowed | Asks the maintainer | Always refused |
|---|---|---|---|
| `workspace` (default) | Reads anywhere; writes and commands inside the worktree; network for package managers and the model | Writes outside the worktree, network-reaching commands not on the list, anything the command policy marks risky | `git push`, history rewrites of other branches, removals outside the worktree, `sudo` |
| `ask` | Reads | Every write and command | As above |
| `full` | Everything but the refusals | Nothing | `git push` |

A request the gate can't decide becomes an attention request (§15.1); every decision (allowed, asked and answered, refused) is logged and counted for the reviewer. `full` SHOULD be used only with containers (§12.7).

While a ticket waits to merge or merges, the gate refuses `git commit` and other writes to its branch in its worktree, saying why, and the engine holds the maintainer's messages to its worker until the merge is over (H59), so the commit checked is the commit merged (§13.7).

### 12.7 Isolation

\[DECISION\] A worktree per worker by default. A project MAY set `container` (an image, or a devcontainer file whose image and setup commands are read \[VERIFY which devcontainer properties to honour\]): each worker then runs in a container with its worktree mounted, Pi and the extension inside on the Linux engine distribution's Node (mounted read-only; a macOS engine fetches the Linux distribution for its architecture once), the network as configured. The engine, its model proxy and the extension's socket stay outside, the socket mounted \[VERIFY reaching the model proxy from inside a container on each runtime\].

- **Runtime** (H36): Docker or Podman, whichever is on the host, driven through the Docker-compatible CLI (`docker` or `podman`: run, exec, mounts, networks, the same flags for what the engine needs); `container.runtime` names one where both are present. Rootless is preferred: rootless Podman or rootless Docker on Linux, Docker Desktop or Podman Machine on macOS; a notice says when only a rootful daemon is found.
- **Limits:** every container gets memory and CPU limits (`container.memory`, `container.cpus`; default the worker's share of the machine, §7.3), so containers can't take the host as an unbounded VM can.
- Images are pulled before a run's first dispatch; a container is removed with its worker.

### 12.8 Supervision

\[DECISION\] Live state is held in Effect primitives inside the engine (`Queue`, `PubSub`, `SubscriptionRef`, `Deferred`), durable state in the work graph; agents never talk to each other. A `Supervisor` fiber per worker applies these policies:

| Failure (tagged error) | Policy |
|---|---|
| `RateLimited` (a provider's rate limit, no reset known) | Retry with exponential backoff (`Schedule`) |
| `UsageLimited` (a quota with a reset) | The usage-limit hold (§14.2) |
| `CredentialRefused` (a credential refused after the run began) | The credentials hold (§14.6) |
| `AgentStuck` (no events for `stuck_after`, default 10 min, not in a tool known to be long) | Interrupt; restart the session once with a summary; then defer |
| `ToolDefect` | Defer the ticket; file a follow-up about the tool |
| `StartFailed` | The model fallbacks (§12.5); then the environment hold's count (§14.1) |
| `BudgetExceeded` | Interrupt the ticket's scope; set it aside (§14.4) |
| `HumanRejected` | Return the ticket to the queue with the reviewer's note |

### 12.9 The model proxy

\[DECISION\] (H29) Agents never hold a model credential; OAuth tokens expire within hours, and a worker can run longer. The engine runs a **model proxy**, and each agent's Pi is configured at spawn with every provider's base URL pointing at it and a per-agent token in place of a key \[VERIFY Pi takes a base URL override for each built-in provider\].

- **Where:** a loopback HTTP listener on the engine's host (127.0.0.1, an ephemeral port). The per-agent token is the only way in; it dies with the agent's session.
- **Each call:** the proxy checks the token, takes a permit (the usage-limit hold, §14.2; per-provider concurrency caps; budgets, §14.4), swaps the token for the current credential from the secret store (§20.3), and streams the provider's response back unchanged.
- **OAuth:** the proxy refreshes a subscription's token itself before it expires, through `pi-ai`'s OAuth refresh, one refresh per account at a time, writing the new token to the secret store; a refresh that fails holds the run (§14.6). Where a provider's subscription requests differ from its API-key requests (Anthropic's, for one), the agent's Pi is given a placeholder token of the subscription kind, so it builds the subscription's request and the proxy swaps only the token \[VERIFY per OAuth provider\].
- **APIs:** the proxy passes through each provider API Pi uses (Anthropic Messages, OpenAI Responses and Chat Completions, Google), changing only authentication headers. Local models (Ollama, LM Studio) go through it too, with no credential, for the accounting.
- **What it reads:** each response's usage (tokens in, out and cached, from the API's final event), attributed by token to the agent's ticket, run and model (§14.4, §21); and refusals: a 429 with a reset time starts the usage-limit hold (§14.2), one without starts the `RateLimited` backoff (§12.8), a rejected credential is a `StartFailed` while no call to that provider has gone through in the run, and the credentials hold after (§14.6).
- Organs' calls from the engine itself (§16) take the same permits and accounting.
- **Usage windows** (H90): where a provider reports a subscription's windows on its responses (Anthropic's five-hour and seven-day utilisation, on responses it allowed too, not only near the limit), the proxy keeps each window's latest figure per account, records each change (`usage_window`, §13.12) and serves them to the console (§18.3). tutti first read the windows only when the provider warned or refused, so it saw the account's usage only near the limit (tutti-9k3t) \[VERIFY each provider's headers\].

## 13. The run

Behaviour is orchestra 0.9.1's unless this section says otherwise; the references are `docs/running.md` and `docs/workers.md`.

**State** \[DECISION\] (H58): each piece of run state (the merge queue, the hand-backs, the holds, each ticket's phase) has one owner and changes only through atomic transitions applied to its current value, never written back from a copy read before a wait. One table in `contracts` says what each phase counts as (working, waiting to merge, needs you, set aside, done), and the console, the report, the notifications and the end line all read it; a new phase doesn't compile until each of its facts is given (tutti-rvzn.7). tutti's merge queue lost updates by writing back stale copies across file writes, and its four separate lists of what counts as set aside or needing you disagreed.

### 13.1 Starting

- **Start checks**, all problems listed together, exit code 2 (`SETUP`) when any: git 2.38 or later (`merge-tree --write-tree`; Ubuntu 22.04's git 2.34 refused `worktree list -z`, which tutti read as not being in a repository, tutti-v1i); the project's checkout clean and on a branch; no other run of the project, on this engine or another (the run lease, §11.5; the remote reachable, or `--offline`); settings valid; the requirements list passing (§17); models' credentials present and usable (H69: an OAuth token refreshed when it expires within the hour, any other credential tried with the proxy's probe call, H60), as tutti's start read only that an account was there and its first worker found the token expired; the templates' versions (a notice). A defect inside a check is a problem line of its own (`Internal error in <check>: …`), never an exit with nothing said (tutti-kq5).
- **Getting ready** (H80): the start's steps (its checks, the backlog, the carry-over) are streamed as they run, so a client shows what the run is doing from its first moments; tutti showed nothing for several seconds before its first screen, and looked hung (tutti-t17u).
- **Modes:** the current tickets (`--tickets`, the default), one ticket and its descendants (`--ticket <id>`), a spec (`--spec <file> [--refine]`), a feature (`--feature "<text>"`), an overnight run (`--overnight`, §15.6).
- **No ticket limit by default**; `--limit N` caps a run's dispatches (orchestra-5ls7). `--concurrent N` caps its workers (also bounded by the machine budget).
- **Nothing ready but questions:** the run opens the answer talk instead of ending (§15.3); nothing ready at all: `READY_EMPTY after 0 tickets`.

### 13.2 Dispatch

- Free slots are filled at once and on every change: a worker settling, a merge, an answer, the ready set moving.
- A ticket is claimed (§11.5), given a worktree from Base (created, or reused and rebased), set up (§13.8), and handed to a fresh worker with its first prompt (the ticket's ID and that its rules are in the system prompt).
- Its first prompt adds what the run knows: an earlier attempt's notes, a spec's sections it cites, the hand-off results of the tickets it depends on.
- **Wakes carry their reasons**: each change that wakes the run records why, and a look reads only what its reasons can have changed, so an attention request opened or answered reads no git (tutti-rvzn.5, -gr4z.9).
- **Resumes take slots** (H76): a ticket resumed (carried over, answered, or set aside and undeferred) takes a slot only when one is free, the machine budget allows it and no solo ticket runs, as a dispatch does; the rest wait, and the run doesn't end while one does. tutti resumed six carried workers at once under `concurrent: 3`, and an answered ticket beside the running one under `concurrent: 1` (tutti-3ezp). Every path that starts or resumes a worker gives it the same supervision, its ticket limit among it: tutti's answered workers had none (tutti-1wvj).

### 13.3 Ready

orchestra's rule \[DECISION\]: open, not deferred (or past `defer_until`), not an epic, a question or a maintainer task (H52), every `blocks` blocker **closed and merged** (`merged_commit` set, or its branch on Base, as git says; a blocker closed but not merged holds it: `CLOSED_UNMERGED`, orchestra-lx4d.1), the ticket it was filed from merged, and not set aside in this run. An epic closes itself once its children are closed and merged.

### 13.4 Footprints, holds and solo tickets

orchestra 0.9.1's rules \[DECISION\], made precise by what tutti's runs measured (H70): of the 862 minutes tutti's tickets were held back for overlap in its runs of 2026-10-26 and 27, 824 were over files one side never changed.

- A footprint is the ticket's `files` (the files it will change: `file_ticket` asks for them, the breakdown gives them, `fabrica tickets create --files` takes them), its area labels and, while it runs, the files its worktree changed. Only a ticket that gives no `files` has its title, description, design and acceptance (never its notes) read for paths and functions, or the predictor's guess where its text names none (§16). tutti read every path a ticket's text named as one it would change, `left out`, `see X` and `as needed` included, so a ticket naming the check script in its acceptance held every other behind it: 744 of those 862 minutes.
- A path in a ticket's text is a tracked file's path, or a tracked file's bare name where it is capitalised or quoted (`Makefile`), as git lists the files (tutti-shrg). A function counts only where a tracked source file declares it (a function, type, constant, class, method or field), `Type.method` only when both parts are declared, and a file mentions it only in its code, its comments, strings and documents left out by its language's syntax. Library names (`JSON.stringify`, `Effect.fn`) held tutti's tickets apart 195 minutes in one run, and words in log strings placed functions in files that never called them (tutti-ejkt.3, -gr4z.2, -mfij).
- Two tickets overlap only on a file one of them is to change. Files git merges by union, the check commands' files and the files those commands run, and the project's `shared_files` (paths and globs of files nearly every ticket edits, as a features map or the spec: tutti held tickets 519 minutes over one, tutti-fg1e) never hold tickets apart; they stay in the footprint with a `LIKELY_CONFLICT` notice, and a rebase conflict in one goes to the resolve hand-back (orchestra-jocn, -kmcz; tutti-0vbd.1).
- A ready ticket overlapping a running one, a ticket merging, or one waiting to merge is held back; so are ready tickets while a `solo` ticket runs or waits first in line. Each held ticket's reason is kept in words, as the log says it, for the console (H81).
- Tickets past their work (waiting to merge, merging, resolving, fixing) hold on the files their branch changed, not on what their text named, until they merge, but not their slot: at most `concurrent` such tickets at once (orchestra-z8lr). Once the work is done, the branch is the truth: a departure from orchestra (§26).
- Footprints are bounded: a glob's runs of `**` collapse to one and its match remembers the ways that failed, and file contents are read only for pairs compared where one names a function. A glob of seven `**`s took tutti 3.6 s a fill on its one JavaScript thread (tutti-crj).

### 13.5 Outcomes and hand-offs

- `finish` → the verifier (§13.6), then the merge queue.
- `defer` → set aside, its worktree and session kept, its notes saying why; triage reads it (§16). Undeferred during the run, it comes back in that run and resumes its session (H76; tutti-j65z, -jml1).
- `wait_for` → back in the queue until that ticket merges (`WAITS_FOR_MERGE`), the slot freed and the dispatch number reused.
- `ask_question` (own ticket) → the ticket waits on the question; its session is resumed with the answer.
- **Typed hand-offs** \[DECISION\]: `finish` carries a result: a summary, plus fields per `result_kind` (metadata) defined in `contracts` (e.g. an API contract changed, a migration added, a decision recorded). Tickets depending on it get these results in their first prompt and through `get_ticket`.

### 13.6 The verifier

\[DECISION\] When a worker calls `finish`, the engine starts a verifier: a separate Pi session in the worktree, read-only (Read, Grep, Glob, Bash for reading and running tests), given the ticket and the diff but none of the worker's reasoning, using `verifier.model` (default: a different provider's model from the worker's where one is configured, else the same). It reuses the worker's passing `check_own` on the same tree rather than running it again, and checks the suites on what the change touches. A pass is recorded with the tree it ran on (HEAD's, with the uncommitted and untracked files), so committing what was checked keeps it (H89). In tutti a worker's own check was 37% of its time, and 131 of 212 sessions ran it again after a pass (tutti-gr4z.11); the engine passes the last pass's tree to the check command (`FABRICA_CHECK_OWN_PASSED_AT`), so a project's `check_own` that selects tests can leave out those that passed and that nothing since touches, as tutti's own does. It answers through its `verdict` tool (`PASS`, or `FAIL` with findings). A FAIL goes back to the worker, the earlier rounds' findings carried, for at most `verifier.rounds` (default 3); a later round that disagrees with an earlier one says so (`DISAGREES WITH ROUND <n>`), and the worker asks the maintainer rather than going round again (orchestra-nr1v.12). `verifier.enabled` per project (default on).

### 13.7 The merge queue

orchestra 0.9.1's path \[DECISION\]:

1. Take the queue (an Effect `Queue` with one consumer).
2. If the branch's commits change nothing: close the ticket as `no_change`.
3. Rebase onto Base when Base moved; on a conflict, hand it back (`RESOLVING`, up to `hand_backs.resolve`, default 2, each within `resolve_timeout`, default 20 min).
4. Run the setup if the rebase changed a `setup_files` file (§13.8).
5. Run `check_fast` on **every** merge, a branch already on top of Base included (orchestra-hm5e). A failure in the ticket's own code hands it back (`FIXING`, up to `hand_backs.fix`, default 2); a worker that commits nothing gets one more check (orchestra-2jwy); a failure outside the ticket's code sets it aside to be rechecked once Base moves (`CHECKS_FAILED`, `RECHECK`).
6. Fast-forward Base to the commit the merge check passed on, by its hash, never by the branch's name: a commit made after the check is checked first (H59). Record `merged_commit`, close the ticket, remove the worktree and branch, push when `push: after_merge`.

- **The merge train** (orchestra-8qk2): while one ticket's check runs, the next queued ticket is rebased onto the first's rebased head in its own worktree and checked beside it (`merge.train`, default 1; none while the machine budget holds); if the first merges as checked, the second merges with no further check. In tutti's runs a second ticket was rarely waiting (1 of 28 entries), and two checks side by side each slowed 1.1–2.3×, so the train stays at one, never deeper (tutti-0vbd).
- **Hand-backs** (orchestra-nr1v.1, .2, -cgko): one check per hand-back, after rebasing onto the current Base; the prompt asks for what failed and the tests of the change, not the whole check; the hand-back's clock stops during the usage-limit hold and while the machine is held for load; at the limit or the deadline a finished rebase or a fix commit is taken from git, and otherwise the worker is interrupted and told the hand-back is over before its branch is put back (its attempt kept).
- Only the step from the fast-forward to the end of its notes is uninterruptible, with each git command's time limit restored inside it (tutti spec §3.4). An interrupted rebase runs `git rebase --abort`; an interrupted check leaves the ticket waiting to merge; a stop never rebases a ticket that hasn't started its merge (orchestra-thcc).
- `CLOSED_UNCOMMITTED`: a ticket whose worktree has uncommitted or untracked files can't `finish`; were it to reach the queue so (a carry-over), it is set aside with the files named (orchestra-gsaa).
- **Git's answers** (H59): reads that steer a merge (the worktree's status, whether the branch is on Base, the merge base, a commit's hash) are retried on a short schedule; a read that still fails is "can't tell" (`GIT_FAILED`, for that ticket), never taken as clean, on its branch or Base unmoved. The rebase is onto the commit read as Base for that merge, not onto Base's name. tutti took an unreadable status as a clean worktree, so a check could pass with a fix that the merge then left behind. Every git command puts revisions after `--end-of-options` and pathspecs after `--` (a Base named like a folder made tutti's `git reset` ambiguous, tutti-nn2x), and a rebase passes `--no-update-refs` (a user's `rebase.updateRefs` moved other branches pointing into the rebased commits, tutti-2vtz) (H85).
- **No merge check, no merge** (H62): a project with no `check_fast` doesn't merge, unless its settings say `check_fast: none` explicitly; each such merge then says it was unchecked.
- **A refused fast-forward is diagnosed** (H71): Base is read again. Moved on, the ticket goes back to be rebased and checked; still fast-forwarding (another process's `index.lock`, an editor's `git status`), the fast-forward is tried again 3 s later, up to 3 times, then `GIT_FAILED`; only a branch that doesn't fast-forward stops merging (`MERGE_FAILED`). tutti stopped the run on every refusal (tutti-q8ey).
- **A merge turn's budgets** count over the ticket's whole turn: a branch or Base that moves on during every check has the ticket checked again at most 3 times, then blocked, as tutti's re-preparations restarted their counts and could loop without end (tutti-5mmd, -rvzn.16). A merge is a machine of named steps (enter, locate, rebase, check, confirm, fast-forward), one handler each.
- **What a check leaves**: a setup or check that leaves tracked files changed in the worktree (a rewritten lockfile, formatted files) sets its ticket aside, `DIRTY_WORKTREE`, as it passed on files that wouldn't merge (tutti-jq72); untracked files a setup or check wrote are recorded and removed with the merged worktree (tutti-ubv4); the record is the worktree's own (in its git folder, `fabrica-wrote`), kept however the setup or check ends, a ride's or one cut short by a stop too, so `enter` never takes those files for its worker's (`CLOSED_UNCOMMITTED` names the worker's alone), and a ticket set aside, or handed back, gets its worktree back without them, its ignored files kept (fab-mgi.34); a fix or a conflict resolution that leaves an untracked file is rejected, naming it, as `finish` refuses one (tutti-zcqb).
- **A conflict in documents alone** asks the worker for the resolution and the rebase only, the merge check following: tutti asked for the change's tests too, and a conflict in the spec took 170–209 s, mostly the worker's slow check (tutti-gr4z.4).
- **Cleanup out of the queue**: a merged worktree with no changes but those its setups and checks wrote is moved aside (a rename on the same disk), its branch deleted, and its files deleted in the background; deleting half a gigabyte of `node_modules` held every merge behind it for 12 and 15 minutes in tutti (tutti-ejkt.4). A run deletes what an earlier one left aside as it starts.
- **A dirty checkout** (H72): uncommitted changes in a registered checkout during a run don't stop merging for the run. The fast-forward waits, the console naming the files (`MERGES_WAIT: <checkout> has uncommitted changes to …`), and goes on once the checkout is clean, watched with a poll beside the file watch (a file watch alone goes silent on macOS when its folder is removed, tutti-rvzn.26). The start still refuses a dirty checkout (§13.1). In tutti and orchestra a dirty tree stopped every merge until the run ended (`DIRTY_TREE`), which the maintainer's own edits did more than once (tutti-et9p). A departure from orchestra (§26).

### 13.8 Setup

orchestra 0.8.2–0.9.0's rules \[DECISION\]: the project's `setup` runs in each new worktree before its worker starts, and again in a reused one whose rebase changed a setup file; within the check's time limit; its output kept. A failing setup puts the ticket back in the queue until a merge or a probe (`SETUP_FAILED`), counts toward the environment hold when it fails ticket after ticket, and names its tickets at the run's end (`SETUP_WAITS`). A setup cut short is run again: the setup files a worktree is set up for are recorded in its own git folder before the setup runs and dropped once it passes, so a setup that failed or was cut short, or a merge-train ride a stop put back without setting it up again (§13.10), is run at the ticket's next merge, at its rebase step, its branch on top of Base or not, with the files that rebase brings, or before its check where it rides the merge train. A conflict hand-back after a rebase that changed a setup file runs the setup first.

### 13.9 The full check and the run's end

- A run that ended by itself and merged something runs `check_full` once on Base, in a fresh worktree with setup; a failure files a ticket.
- The end line: `READY_EMPTY`, `LIMIT_REACHED`, `DRAINED`, or the stop's kind, then what is left (`SETUP_WAITS`, `SCOPE_OPEN`, the questions waiting).
- The reviewer writes the run report (§16) to `.fabrica/reports/`, shown in the app.
- `push: after_run` pushes Base once the full check passed.
- **The end, in order**: the loop's end stops every ticket's supervision before its other steps, and answers to requests are refused from then on: tutti ran an answered worker on into its end, which merged a ticket under a stopped run (tutti-5ko, -t7z7). Sessions are closed all at once, the end waiting for the slowest (tutti-dlt5).
- A full check that couldn't run (its command didn't start, its output couldn't be kept) is `FULL_CHECK_NOT_RUN` and files no ticket: it isn't a suite's failure (tutti-gc2b).
- The full check, its setup and the report are the run's phase in the view, with their elapsed time (H80): through a two-minute full check tutti's dashboard said `picking the next ticket…`, and the run was taken for stuck (tutti-yek1).

### 13.10 Stops, drains and carry-over

- **Drain** (`s` in the app, `fabrica run drain`): no new tickets; the running ones finish and merge; the run ends `DRAINED`.
- **Stop now** (`fabrica run stop`, the app's Stop): workers interrupted, their sessions saved; the run ends `INTERRUPTED`; a merge in its uninterruptible step finishes first.
- **Carry-over**: the workers and tickets a stopped or crashed run left, saved in `.fabrica/run/state.json` and the leases; the next run resumes their sessions (Pi's session resume) rather than starting over; a carried ticket already on Base is dropped with its worktree and branch removed (orchestra-nr1v.8).
- A ticket merged by hand during a run is noticed as Base moves: its label dropped, what it blocks freed, counted closed (orchestra-nr1v.9).
- A crashed run is known by its lock, not by what the state file names: a write to `state.json` before carry-over made tutti take a crashed run's tickets for its own, leaving them in progress with nothing to resume them (tutti-z3el).
- A rebase that a killed run's merge, train or hand-back left in progress is aborted and its branch put back, so the ticket merges rebased afresh (tutti-m31, -tejt, -b8hv).
- A stop during a merge-train ride puts the rider's branch back without waiting on a setup (only the fast-forward is uninterruptible, §13.7): its worktree records the setup files the ride set it up for, and the ticket's next merge sets it up before its check (§13.8).
- A stop during the start's carry-over cuts it short: no further worker is resumed, and the rest stay saved (tutti-5mp).

### 13.11 Exit codes and kinds

The CLI's exit codes and the event stream's stop kinds are orchestra's, minus the terminal's: 0 (done, drained, limit, nothing to run), 2 (setup problem, failed pre-flight, requirements missing, the project leased by another engine, the remote unreachable without `--offline`, a credential still refused past `credentials_wait`), 3 (not used: orchestra's stop for a stuck worker; Fabrica sets such a ticket aside, §14.5; the number stays reserved so the others match orchestra's), 4 (a git or tracker failure, an engine panic), 5 (the checkout off its branch during a run; uncommitted changes make merges wait instead, §13.7), 6 (a branch that doesn't fast-forward), 7 (the environment hold gave up), 8 (the usage limit outlasted `usage_limit_wait`), 130 (stopped). `fabrica run start --wait` waits for the end and exits with them; without `--wait` the CLI returns once the run starts.

### 13.12 The event stream

`.fabrica/run/events.jsonl` and the `run events` RPC stream: orchestra's record kinds (`start`, `dispatch`, `queue`, `settled`, `closed`, `deferred`, `asked`, `answered`, `hold`, `warn`, `done`, `end`, …) with orchestra's fields where they apply (`docs/events.md`), versioned, plus `model`, `tokens`, `cost` and `engine` fields. Defined in `contracts`. orchestra's analysis fields keep their names (H65): `check` records (suite, command, commit, seconds, result), `phases`, `hand_backs` and `carried` on `closed` and `deferred`, `tokens` per model, and the run's `tokens` and `organs` on `end`, so one set of queries reads orchestra's, tutti's and Fabrica's streams. Records added since: `slept` and `battery` (§7.7), `usage_window` (§12.9), the credentials hold's (§14.6), `turn` for each agent turn with its share of the session's totals, `check` for each check and setup, and `ticket_end` for every ticket whose part in the run ends, one left queued included (tutti-0xi5, -xpw0).

**Written safely** (H84): a stream whose last line an earlier crash cut short gets a newline before the first new record; each record's newline is written with it or, failing that, ahead of the next record, so a short write (a full disk) loses only its own record; a log line and its event are written together or not at all; every time is local with its UTC offset (`2026-10-29T10:15:00.000+02:00`), the run's ID included, so times compare as strings; durations are never negative (tutti-o0o9, -gd4w, -jskc, -jxyk, -5mlh).

### 13.13 Settings

`.fabrica/settings.json` (committed), with the engine's settings for machine-wide values:

| Setting | Default | |
|---|---|---|
| `concurrent` | 2 | Workers for this project's runs |
| `model`, `model_fallbacks` | none | §12.5 |
| `permissions` | `workspace` | §12.6 |
| `container` | none | §12.7 |
| `check_own`, `check_fast`, `check_full` | from `init` | §13.7 |
| `check_timeout` | 30m | |
| `setup`, `setup_files` | from `init`; orchestra's default list of manifests and lockfiles | §13.8 |
| `requires` | `[]` | §17 |
| `push` | `never` / `after_run` | §10.3 |
| `verifier` | `{enabled: true, rounds: 3}` | §13.6 |
| `hand_backs`, `resolve_timeout` | 2, 2, 20m | §13.7 |
| `merge.train` | 1 | |
| `ticket_limit` | none | A worker past it is interrupted and its ticket set aside (§14.5) |
| `usage_limit_wait` | 6h | §14.2 |
| `usage_limit_retry` | 15m | The least time between two lifts of the usage-limit hold, and between probes when its reset is unknown (§14.2) |
| `question_wait` | 15m | §12.3 |
| `budgets` | none | §14.4 |
| `organs` | per organ: `{enabled, model}` | §16 |
| `container.runtime`, `container.memory`, `container.cpus` | whichever is present; the worker's share | §12.7 |
| `shared_files` | `[]` | Paths and globs that stay in footprints but hold no tickets apart (§13.4) |
| `questions` | `auto` | §15.3 |
| `templates` | the versions `init` wrote | §12.4 |

**Scope** \[DECISION\] (H68): `.fabrica/settings.json` is committed, so it holds only what everyone running the project shares (its checks, setup, requirements, permissions, footprint rules). A person's or a machine's choice is the engine's setting or the app's: `keep_awake`, `worker_nice`, `machine_workers`, `auto_answer`, `credentials_wait`, notifications, the theme. tutti put keeping awake in its committed settings, so one person's choice for a night went to everyone who ran the project (tutti-v0tn), and then moved it to each person's own configuration (tutti-22jf).

Flags, then environment variables (`FABRICA_…`), then the project's settings, then the engine's, resolved once per run into one value; every problem listed (tutti spec §3.3 `AppConfig`).

## 14. Holds

The holds are one state (H58), changed only through the transitions of §13's state rule: lifting one never lifts another, and every banner and the run's stopping are derived from it. tutti's environment probe, on passing, cleared every stop raised while it waited, a blocked worker's among them, and a plain run then waited for an answer that no stop asked for. Whether the run may take work is one snapshot of plain values, read once per decision; a check with side effects (the requirements' install, the machine budget's hold) runs apart from the question (tutti-rvzn.17).

### 14.1 The environment hold

orchestra's: when several tickets in a row settle within minutes without claiming or changing anything, or their setups fail one after another, the run holds (`HOLD: ENVIRONMENT`), probes the machine with a minimal agent after `env_probe` (10 min), and goes on (`PROBE_OK`) or ends (exit 7). Sessions that don't start count (tutti-13bh). A ticket stopped by a closed-but-unmerged blocker doesn't count, nor one stopped by a refused credential (§14.6).

### 14.2 The usage-limit hold

\[DECISION\] A model call refused for a quota with a reset time (a subscription's session limit, a provider's quota), from a worker or an organ, holds the **whole run**: no new tickets; running workers wait (their hand-back clocks stopped) and are told to carry on at the reset, naming an open hand-back; the hold lifts on evidence (H60): at its reset the model proxy makes one small probe call for the provider and lifts the hold when it goes through (orchestra-8jw3's rule, that the hold lifts at the reset whether or not a worker sees it lift, met by the proxy rather than a worker). A reset time at or before now (a clock behind the provider's, a provider still refusing just after its reset) is taken as unknown. With no reset known, the proxy probes every `usage_limit_retry` (15 min), and any call that goes through lifts the hold. Two lifts are at least `usage_limit_retry` apart, so a misread reset can't send workers into the limit call after call. A worker's refusal ends with its turn: a later turn that fails for another reason is that failure. tutti lifted at once on a reset already past, in a loop, and held for the rest of the run on an unknown one. Reset times are shown with their day when it isn't today. Past `usage_limit_wait` the run ends (exit 8), its workers kept for the carry-over. The model proxy (§12.9) sees the refusal first-hand and grants no permit for that provider while the hold is on, so no other agent spends a call finding the limit.

### 14.3 The machine budget

`HOLD: MACHINE` while the engine's live workers reach `machine_workers` (§7.3); lifted when one ends. The console's system stats say when the machine itself is overloaded (§18.3).

### 14.4 Cost and budgets

\[DECISION\] Tokens and cost per model call (counted by the model proxy, §12.9, priced by `pi-ai`'s tables \[VERIFY\]; a subscription's calls are counted in tokens, with their API-price equivalent shown as such) are recorded per ticket, run, model and project in telemetry (§21), and shown in the app, the report and the event stream. `budgets` (per project, run or ticket, in tokens or money) are optional and off by default: a ticket over its budget is interrupted and set aside (`BudgetExceeded`); a run over its budget stops dispatching (`HOLD: BUDGET`).

### 14.5 One worker's trouble

\[DECISION\] (H37) Conditions that stop the whole run in orchestra (a worker gone twice, blocked on a dialog, its state unknown) can't happen to Pi workers owned by the engine. What remains is one ticket's trouble, in every run, overnight or not: a ticket past `ticket_limit`, or a worker that settles twice with no outcome (§12.3), is set aside (its worktree and session kept for review, a note saying why), triage reads it (§16), the app notifies, and the run goes on. Nothing stops the whole run for one worker; run-wide conditions (the environment hold, §14.1; the usage limit, §14.2; a refused credential, §14.6) still can. A set-aside ticket keeps its session and worktree; undeferred, it resumes them (H76).

### 14.6 The credentials hold

\[DECISION\] (H69) A model call refused for its credential once the run has begun (an OAuth refresh that fails, a key the provider now rejects, an account suspended), from a worker or an organ, holds the run for that provider as the usage limit does (§14.2). The model proxy grants no permit for that provider; its running workers wait, their hand-back clocks stopped; workers on other providers go on. No ticket is deferred, set aside, triaged or counted toward the environment hold for it, and no organ is called on that provider while it holds. The app and the CLI say so at once (`HOLD: CREDENTIALS: anthropic's sign-in for <account> was refused (OAuth session expired and could not be refreshed); sign in again`) and offer the sign-in (`credentials.login`, §20.3). The hold lifts once the proxy's probe call goes through after a new sign-in or key, and the waiting workers are told to carry on. Past `credentials_wait` (an engine setting, default 6h) the run ends (`CREDENTIALS`, exit 2), its workers kept for the carry-over. tutti read a resumed worker's turn refused for an expired login as the worker finishing with its ticket open: it deferred the ticket with a note saying so, failed triage and the run's review on the same error, and ended with exit 0, and the next start found nothing ready (tutti-8jb0, 2026-10-28).

## 15. Questions, permissions and talks

### 15.1 Attention requests

- **Questions:** tickets of type `question` with 2–4 options, one recommended, blocking the tickets that wait on them. Filed by workers (`ask_question`), organs, talks or the maintainer. One marked `maintainer_only` asks the maintainer to approve something done in their name; nothing answers it for them.
- **Permission requests:** from the gate (§12.6): the tool call, its arguments shown whole and rendered for the tool (a command as its lines, an edit as its diff, a write as its path and content), never cut off, and why it asks (H62); answered allow once, allow for this run (a run-scoped rule), or refuse with a note. An answer carries the request's ID, and a key answers a request only while it is shown with its buttons, and only 500 ms after it was first drawn, a guard that starts again when the request a key would answer changes (tutti-14o5) and counts on the injected clock (H88). tutti cut a request's input at the pane's edge, so the end of a multi-line command was nowhere on screen when Allow was pressed, and its keys could answer a request that wasn't drawn.
- **Maintainer tasks** (H52): tickets of type `manual`, listed with the attention requests as the maintainer's own work; done when the maintainer closes one, which frees what it blocks.
- Both are listed by `attention.list`, shown in every client, and answered in the app, in the CLI (`fabrica answer`), or by an agent through the CLI. The first answer wins (§8.5).

### 15.2 Answering a question

The app shows the question with its options, the recommended one first and marked, and a free-text line; "Talk it through" opens the answer talk for that question. The answer is recorded on the question (closing it as `answered`) and written into the blocked tickets' design, so their workers see it; the blocked tickets become ready, and a ticket whose own session asked is resumed with the answer. An answer wakes the run at once, which takes the ticket back then, not at its next poll (H92; tutti-07nj).

**Consequential questions** \[DECISION\] (H53): a question whose options would close, cancel, defer or freeze work, or change a decision this spec records, is marked so when it is asked (by the tool's schema, or by the engine from its options). It has no option preselected, the answer talk never answers it in a batch, and the maintainer picks one deliberately. Any answer can be revised: reopening a question records the new answer and undoes what the old one did where it can (reopening tickets it closed, undeferring ones it deferred), listing what it can't. tutti was marked frozen as a reference after a recommended option was accepted in a batch of questions, which took two sessions to notice and undo.

**Unattended answers** \[DECISION\] (H82): `--auto-answer` (or the engine's `auto_answer`; off by default) answers questions for a run left going while the maintainer is away. Bare, it answers at once; with a duration (`--auto-answer=10m`), it answers what has waited that long with the host awake and no answer from the maintainer, so one who is there answers first. It takes a question filed during the run, with options and one recommended, that is neither consequential (H53) nor `maintainer_only`, and answers it with its recommended option (`<label> (the recommended option, chosen by --auto-answer, not by the maintainer)`). It labels the question `auto-answered`, tells the resumed worker which option was chosen and by whom, and says so in History, the report and an `auto_answered` event; it sends no notification for a question it answers at once. A question open before the run, one without options, and every permission request are left to the maintainer. With a duration, a question it will answer keeps the run from ending. An overnight run turns it on unless it is set (§15.6). orchestra has no such option: a departure on purpose (§26; tutti-cmye).

### 15.3 The answer talk

\[DECISION\] A talk (§15.4) given the open questions in scope, each with its options (drafted by the talk, and marked so, for a question filed without them), the tickets it blocks, the ticket it was asked from and their notes; read-only tools plus the engine's question tools. It shows each question's options first, talks it through when asked, records the answer, and goes on to the next. With `questions: auto` (default), the app opens it by itself, without taking focus, as soon as a question in a watched run's scope is open; questions arriving meanwhile queue into the same talk; `questions: key` opens it only on the maintainer's action (orchestra-tnei.6). A run with nothing ready but questions opens it instead of ending, and takes up the freed tickets as they are answered; deferred tickets are mentioned, never released by it (orchestra-tnei.5).

### 15.4 Talks

Talks are Pi sessions the engine runs, in the project's checkout, with the maintainer, streamed to a client's chat pane (or the CLI's terminal), with the engine's ticket tools available to file what they decide. Modes \[DECISION\] (orchestra's one talk with modes, orchestra-lx4d.16):

- **refine** a spec before its breakdown (§15.5);
- **feature**: talk a feature through, filing an epic and its tickets, then run it;
- **answer**: §15.3;
- **run** (H44): the console's conversation with the orchestrator (§18.3), one per project, its Pi session kept across the app's restarts. Its read tools: the run's view and events, tickets (`show`, `why`, `ready`), a worker's recent transcript, the log. Its engine commands, as tools: message (steer) a worker; start, drain or undrain a run; hold a ticket until another merges (a `blocks` link); file, update, defer or label tickets; answer a question in the maintainer's words; open the answer talk. It acts on the maintainer's instructions, confirming in one line before it stops a run, closes or cancels a ticket, or allows a permission request. Every action it takes is an event (actor `run_talk`), shown in History. It edits no code and runs no git or shell command.

A talk's model is the project's, overridable per talk.

### 15.5 Spec runs

orchestra's (`docs/running.md`, A whole app from a spec) with its later lessons \[DECISION\]:

- The spec is committed under `.fabrica/specs/` when it comes from outside the repository; a run carries on from its last version by its SHA-256, in update mode for a changed spec.
- The headless breakdown (an organ session with read tools and the ticket tools) files the root epic and, when the spec needs a tool the machine lacks or the repository has no code, the **environment ticket** first (labelled `solo`, priority 0, every other ticket blocked on it); the run starts on the environment ticket while the breakdown goes on (orchestra-ldp7). The rest of the tree comes back in the breakdown's structured answer, filed by the engine in order (orchestra-aehg).
- The environment ticket writes the project's `requires` list (§17) and its pins, scaffolds, installs dependencies with `setup`; it doesn't install machine tools as ticket work (orchestra-coyp.2).
- `--refine` runs the refine talk first; the talk files the tree itself.
- **A spec at a URL** (H83; the maintainer's choice in tutti, 2026-10-26: a web URL only): `--spec https://…` is fetched with the start checks, https only, redirects up to 5 and only over https, within 30 s and 5 MB, with no credentials or cookies; a GitHub file or one-file gist page is fetched as its raw file, and a private GitHub file through the host's own `gh` login; an HTML answer is refused. It is committed as a copy under `.fabrica/specs/`, named after the URL's last path segment, its commits recording `Spec-Source: <url>` without the query and frfabricat, which may hold a token. Each run fetches it again: the same text is kept, and a changed one is an update. A fetch that fails is a setup problem saying why (tutti-kkb.53).
- **The tree is checked whole**: its keys, parents, the issues each waits on, and cycles among parents and `blocks` links together; a refused tree goes back to the breakdown with every reason at once.
- **A narrow tree is warned of**: a tree whose longest chain of `blocks` links is over 3, or which lets fewer tickets run at a time on average than the run's concurrency, keeps workers waiting on one another. The run warns, naming the chain and the hubs (the tickets three or more others wait on directly), and goes on (tutti-kkb.55, as orchestra 0.9.5 does).
- **A breakdown at the usage limit waits** for the reset, its time limit paused (§14.2), rather than give up what it has thought through; past `usage_limit_wait` it ends as the run would (tutti-kkb.56). The breakdown's cost, turns and session are logged as it ends (tutti-kkb.57).

### 15.6 Overnight runs

orchestra's `--overnight` (orchestra-aq0o) \[DECISION\]: the current tickets, after a pre-flight checklist and the open questions answered.

- **Refuses to start** until fixed or overridden: a ticket limit set; `concurrent` under 2; Base failing `check_fast`; `permissions: ask` (workers would wait on the maintainer); a model's credentials missing or rejected (a cheap probe call); free disk on the engine's host under `overnight.min_free_disk` (default 20 GB).
- **Warns**, offering the fix: `usage_limit_wait` under 5h; no `ticket_limit`; another heavy run on the engine or heavy load on its host; older worker rules; the host on battery; how many tickets are ready and how many wait only on questions.
- **Then the questions**, one by one in the answer talk, until none is open (or the maintainer leaves some, which the checklist names with what they hold).
- **The fixes** offered are made together once every answer is in, so cancelling the checklist changes nothing.
- **During the night:** the engine keeps its host awake whatever `keep_awake` says (§7.7), and `--auto-answer` is on unless set (§15.2). A ticket the night sets aside keeps its session and worktree, saved with why; undeferred in the morning, it resumes them (tutti-jml1). A worker handed a conflict or a failed check that waits on a request nobody answers ends its hand-back, its request denied in nobody's name, and its ticket is set aside as a hand-back not done in time (tutti-bqr0). A small `overnight` tag in the information colour (`c5`) marks the run in the console (§18.3).

## 16. Organs

\[DECISION\] Organs call a model through `pi-ai`, which has tool calling but no JSON-schema output mode: each organ answers through one forced `answer` tool whose arguments are decoded with the organ's Effect Schema, and an answer that fails to decode is retried once with the error. An organ that needs tools (the scout, the breakdown) is a short Pi session ending in the same `answer` tool. Each has `organs.<name>.model` (default the project's model) and can be turned off.

| Organ | When | Given | Answers | Its answer changes |
|---|---|---|---|---|
| Triage | A ticket set aside (deferred, unfinished) | The ticket, its notes, the session's last turns, git state | A cause (ticket, environment, instructions, …), a confidence, a note | A note on the ticket; two high-confidence `environment` verdicts start the environment hold |
| Predictor | A ready ticket naming no files, with more than one slot | The ticket and the repository's file list (tests left out unless the ticket mentions tests) | The files it will likely change | Its footprint (`predicted_files`) |
| Reviewer | A run's end | The run's events, filtered; commits; set-aside tickets; checks' failures; cost | The run report | Nothing; shown and saved |
| Scout | `init` | Read-only tools on the repository | The project's check suites, setup, stack, requirements | `init`'s proposals |
| Breakdown | A spec run | The spec, read tools, the ticket tools | The tree (§15.5) | The backlog |

Organ calls take the model proxy's permits, so the usage-limit hold and per-provider caps apply, and their cost is recorded (§12.9, §14.4).

- The reviewer reads the typed event stream, never log text (H61): tutti's report picked facts out of formatted lines, which a ticket title could fake and any rewording broke.
- **Within budgets** (H86): the reviewer's input is capped per section (the log, the attention lines, each list), each keeping its end after a line saying how much was cut, and a set-aside ticket's notes their last 1,500 characters: an overnight run of a few hundred tickets overflowed tutti's reviewer, which then wrote no report (tutti-0st8, -c712, -601). A defect while triaging or predicting one ticket loses that ticket's verdict or guess, logged, never the organ's queue (tutti-mwd). An organ refused for its credential holds as a worker does (§14.6); it doesn't fail ticket after ticket.
- The predictor skips a ticket with commits on its branch, whose footprint is what its branch changes (tutti-sp8).
- **init's checks** \[DECISION\] (H57): the scout's proposal never runs a test twice. A full-tier suite that already runs everything the fast tier does (a slow mode of the same runner) is `check_full` alone, without `check_fast` first; a project's own full runner is kept unless the maintainer replaces it; build and packaging steps found only in CI are offered unticked, with what they cost. init's first ticket, getting the checks to pass, runs `check_fast` three times in all to catch flaky tests, and `check_full` once. tutti's init made its full check run the fast check, then every test again, then a 340 MB build (from about 4 minutes to 6.5–8.5), and its first ticket spent 40 of its 44 minutes re-running checks.
- **init run again** keeps what the maintainer chose: a check set to `none` stays none, the settings file's own formatting is kept where a key changes, a closed test-work ticket isn't filed again unless init wrote a new runner, and a project's own verifier rules stay its own (tutti-cglz, -lx3f, -ibti, -u9in). init says what the scout cost (up to $2 a run, spent unsaid in tutti, tutti-ktn). A proposed command holding a newline or a control character is left out, saying why: `npm test # see CONTRIBUTING\ncurl … | sh` read as a comment on one line of tutti's checklist, while its merge check would have run the curl line (tutti-spz).

## 17. Requirements

orchestra-coyp's list \[DECISION\]: `requires` in the project's settings, each entry a name, a `check` command (exit 0 when met), and either an `install` command (never `sudo`; refused at load otherwise) or a `manual` instruction, optionally per platform.

- Checked at every run's start, on `init`, and after a merge that changed the list; a failing check with an install runs it and checks again; anything still missing stops the run before its first ticket (`REQUIREMENTS_MISSING`, exit 2) with one list, each with its instruction.
- On the engine's host: for a remote engine, the requirements are the server's.
- Workers that need a machine tool add an entry (check, install or manual) and install it through that entry's command, never by hand outside the list.
- The engine runs only the commands of Base's list, as they are there; an entry a branch adds or changes is the worker's to run, through the gate, where the command is shown whole (§12.6). tutti ran a worker-edited list's commands behind a permission request that showed only their names (tutti-3fhp).
- `fabrica requires --markdown` prints the list for the README; `init` keeps that section between markers.

## 18. The app

### 18.1 Stack

\[DECISION\] The renderer is a Foldkit program: one Schema-defined Model, Messages, a pure `update`, side effects as Commands. Behaviour from `@foldkit/ui`, appearance from Tailwind over the design handoff's tokens (§18.2). Mounted: Monaco for diffs and code, xterm.js for agents' command output (read-only), Cytoscape.js for the ticket graph with a layered layout through its dagre or ELK extension, styled from the tokens (H40). Split panels and trees come from `@foldkit/ui` where it has them, otherwise they are built as Foldkit submodels in `packages/ui`; no React component library \[VERIFY `@foldkit/ui`'s components: dialog, menu, tabs, listbox, disclosure and virtual list were listed on 2026-10-21\]. Foldkit's slow-update warnings are on in development builds; Foldkit DevTools and its MCP server are in development builds only \[VERIFY how they are left out of a production build\].

| Concern | Foldkit construct |
|---|---|
| A connection to an engine (through the connection process) | ManagedResource |
| The run view, transcripts, attention, the backlog, the host's load | Subscriptions that emit Messages |
| Requests (start, drain, answer, message a worker) | Commands |
| Per-worker panes, the talk panel, dialogs | Submodels with OutMessages to the parent |

### 18.2 The design handoff and themes

\[DECISION\] (H42) The **Fabrica Console handoff** (`design_handoff_hivemind_console`, named for Fabrica's first name, 2026-10-21: a README, `themes.css`, and two HTML references, the three themes side by side and Lichen Bright alone) is the app's visual source, kept in the repository under `design/console/`: its README, `themes.css`, the two HTML references, and both references rendered at their size (`reference.png`, `kits.png`). The design tool's runtime the HTML needs to open (`support.js`, `_ds/`) has no licence of ours and stays out of the public repository; the PNGs are what tests compare against. It is high fidelity: colours, type, spacing and radii are final, at a 1280 × 800 reference window. Its HTML is a reference recreated in Foldkit (its README's suggestion of React doesn't apply); only `themes.css` is used as it is. The handoff's measurements are carried in Appendix A, `themes.css` in Appendix B, and where each of its files is in Appendix C.

- **Tokens:** `themes.css` is copied into `packages/ui` unchanged, as the only source of colours, fonts, radii and glows. Tailwind's theme maps onto its variables (`--bg`, `--side`, `--panel`, `--line`, `--fg`, `--muted`, `--ink`, `--c1` to `--c5`, `--r`, `--rb`, `--rw`, `--glow1`, `--glow2`, `--font`, `--mono`); components use only those, and a lint rule refuses colour literals anywhere else. Spacing keeps to the handoff's steps (4, 6, 8, 10, 12, 16, 18, 20 and 24 px).
- **Themes:** **Lichen Bright** (the default), **Classic** and **Neon Grid**: one layout, chosen by `data-theme` on the root. The theme is a setting of each app install, not the engine's, switched in Settings and the command palette, and applied at once. All three are dark; there is no light theme in v1.
- **Roles:** `c1` working, `c2` needs you, `c3` failed or set aside, `c4` merged or done, `c5` information (the orchestrator, organs, an overnight run's badge). Every status mark, the system stats' warnings (`c2`) and alarms (`c3`), and History's dots use them; nothing else carries status colour.
- **Fonts:** Archivo (Lichen Bright), Inter (Classic) and JetBrains Mono (Neon Grid, for everything) ship inside the app as WOFF2 files (SIL Open Font License), since the Content Security Policy loads nothing remote (§20.1).
- **Icons:** the handoff has none beyond Unicode glyphs (›, ⏎, ⌘); Lucide where icons are added.
- **Contrast** (H63): each theme's text and status colours pass WCAG AA against the backgrounds they're drawn on, checked in the UI look tests (§24); focus and status never rely on colour alone (an outline, a mark or a weight beside it). In tutti the maintainer found orchestra's faint greys too dim on a dark background, and under `NO_COLOR` a focused button looked like any other.
- **Hover and focus** as the handoff says: rows and cards lighten slightly, buttons `brightness(1.08)`, focus a 2px outline in `--c1` with a 2px offset.
- **Screens the handoff doesn't draw** (§18.4) are derived from its tokens and its panel, card and list language until a second handoff covers them (§28).
- **Checked:** the console's scene with fixture data at 1280 × 800 is captured in each theme and compared with the handoff's references (§24).

### 18.3 The console

\[DECISION\] The handoff's screen, adapted to Fabrica's model (H43 to H46). Layout as the handoff: a 38px title bar; under it a 260px sidebar beside the main area (padding 20 × 24 px, a column with 16px gaps), holding the stats row, then the run talk (1fr) beside History (320px), 156px high, then the two ticket columns side by side, which take the remaining height and scroll each on its own.

- **Title bar** (H46): native window controls in the design's bar. On macOS the traffic lights sit inset on its left (`titleBarStyle: 'hiddenInset'`, centred on its 38px); on Windows and Linux the system's minimise, maximise and close sit on its right (`titleBarOverlay`, coloured from `--side` and `--fg`) \[VERIFY `titleBarOverlay` on Linux at the pinned Electron\]. The design's three squares are dropped; the rest stays: "Fabrica", the system stats, the selected project's usage windows, and the search field (⌘K, the command palette). The bar is a drag region; its controls aren't.
- **System stats** describe the selected project's engine host (§7.4), sent over the connection, never the app's own machine (the handoff's README reads Electron's process; that would be wrong for a remote engine). `MEM`: used and total, its bar `c2` while memory pressure warns and `c3` when critical. `CPU`: the 1-minute load as a share of the cores, its bar `c2` past 1.5× the cores and `c3` past 3× for a minute (orchestra-recj). `CORES`: one block per core, busy ones in `c1`. Refreshed about every second; hovering shows swapping, the merge check's memory and each worker's (orchestra-556h, -u6pv).
- **Usage windows** (H90), for the selected project's provider account, from the model proxy (§12.9): `Current usage ━━━─────  41% · This week 12%`, named as the provider's own apps name them (tutti's `5h ▰▰▱▱` and `week` read as cryptic, tutti-5170), the bar in box-drawing lines, which every font has (tutti's `▰▱` fell back to another font, off-colour at both ends, tutti-1l30), a narrow bar keeping the tighter window; near a limit the usage banner takes their place.
- **Sidebar: projects and their runs** (H43). Header "Projects" and the count; an "All projects" row first, then one row per project on every known engine: a chip in its colour (the five role colours in turn, by the project's index) holding its two-digit index; the project's name; its Base and, where more than one engine is known, the engine's name (`main · server-1`); and its run's state on the right: Running (`c1`), Waiting (`c2`: something needs you), Idle (no run). Selecting a project scopes the main area to it; with All, the columns and History show every project, each card marked with its project's chip. The pinned button is "+ Add project" (§10.1), adding an engine on the way when the project's host isn't known yet (§9.2).
- **Stats row**, for the scope: live workers against the slots (`c1`, "4 of 4"), done today (`c4`: the project's tickets merged or closed with no change since the engine host's local midnight, whichever run closed them, so a run that crosses midnight or a second run the same day still counts the day's; the run view's totals carry it, redrawn as the host's day changes), set aside (`c3`), needs you (`c2`), in queue (`c5`), with how many wait and, on hover, each with its reason in words (H81), tokens (`c5`). At its right end, the selected project's run controls: Start run (its modes: the current tickets, one ticket, a spec, a feature, overnight) while it is idle; Drain and Stop while it runs. An overnight run carries a small `c5` "overnight" tag here and on its project's row. Holds and banners (§14) take a strip above the row: `c2` for a hold, `c3` for a stop, with the reason and, where known, when it lifts (a time, with its day when it isn't today).
- **The run talk** (H44) fills the conversation panel: the scope's run talk (§15.4), its header giving the talk's model and its context use ("claude-opus-5-5 · 14k ctx"), its composer sending to it. When questions arrive, the answer talk takes the panel (`questions: auto`, §15.3), and the run talk comes back once they are answered. With All projects, it acts on the project a message names, or asks which.
- **History:** the scope's events from the event stream (§13.12), newest first, each a time, a dot and one line: dispatched (`c1`), merged (`c4`), asked or waiting on you (`c2`), failed, set aside or held (`c3`), organs and the run talk's actions (`c5`).
- **In progress:** the run's Current (working, verifying, waiting to merge, merging, a hand-back), as the handoff's card: the ID and the title; the **phase bar** (H45), segments for working, verifying, waiting to merge and merging, those passed filled, the current one in the card's colour (its project's), a hand-back marked on the merging segment; and the step, the worker's latest action from its Pi events (the tool and its main argument: "Running scripts/check-own.sh", "Editing src/auth/refresh.ts") or its place in the queue ("2nd to merge", "in the train"), with the elapsed time on the right. No percentage: Fabrica has no honest one. Clicking a card opens its worker view.
- **Needs your attention:** attention requests and tickets set aside, as the handoff's card with its kind tag. **Approval** (`c2`): a permission request, its input shown whole (§15.1); Approve allows it once, its menu allows it for this run or refuses it with a note. **Question** (`c5`) (H92): the question's own title, not its ticket's; the ticket waiting on it; as much of its description as fits; Answer opens its options inline, the recommended one first and marked, a free-text line and "Talk it through", and keys 1–9 pick an option once the guard has passed (§15.1). tutti showed an asked ticket as `? for you` with its ticket's title, the question only in its log, until it put the question, its options and answers beside the tickets table (tutti-h2o9, -07nj, -fdv1). A blocked ticket's card says what clears it. **Review** (`c4`): a ticket set aside (`CHECKS_FAILED`, `MERGE_CONFLICT`, a verifier that disagrees with itself, a ticket past its limit); Review opens its diff and notes. **Your task** (`c2`): a maintainer task (§15.1), done when the maintainer closes it. The waiting time on the right in `c2`; "Open session" opens the worker view. A resolved card leaves the column, its ticket back in progress where it goes on.
- **Up next**: while nothing needs the maintainer, the column shows the queue instead, the ready tickets first, then each waiting one with why, in words as the log says them (`waits for fa-12 to merge`, `touches src/auth/refresh.ts, like running fa-7`, `waits for the solo ticket fa-9`), then `+N more` (H81). tutti's `4 held back` was a count whose reasons were only in its log, and the maintainer asked twice what it meant (2026-10-27).
- **Nothing silent** (H80): every engine step of more than a second (the start, a setup, the merge check, the full check and its setup, the report, an install) shows in its card or the stats strip with its elapsed time. Cards keep one height whether or not their worker has an action yet, so the columns don't jump as workers come and go (tutti-pgl6).

### 18.4 Other screens

\[DECISION\] (H24) Reached from the console (a card, a project, the command palette), in the handoff's tokens and language:

| Screen | Holds |
|---|---|
| Worker view | The ticket on top (H91): its ID, type and priority, its title and the start of its description, the whole ticket (design, acceptance, notes, links, the tickets it blocks) a key or a click away. Beside it, figures that move during a turn, not only at its end (its time, its context use against the model's window, its share of the provider's usage window, marked an estimate). The transcript as it happens (messages, thinking collapsed, tool calls and their output in xterm.js, diffs in Monaco, bare URLs as links). A composer to message or interrupt the worker (it is then steered: the engine sends it nothing until released), which, once the worker has finished, keeps its text and offers to file it as a ticket. No spending panel: cost is in Insights, as the maintainer chose in tutti (tutti-cxgo.1 to .6, -g0wd) |
| Talks | The refine and feature talks, full height; the run and answer talks open here too from the console |
| Backlog | Epics and tickets, their dependencies (the graph), what is ready and why the rest isn't (`tickets.why`), questions, deferred tickets, the tickets a run finished; read-only (editing in the app comes later; the CLI and the run talk cover it) |
| Review | A ticket's branch diff, a run's merged diff, run reports, the log |
| Insights | From the engine's telemetry (§21): tokens and cost per model, ticket, run and project; time per phase (working, checks, the merge queue, hand-backs, holds); check durations and failures; hand-back and set-aside rates; models compared on similar tickets |
| Engines and projects | Known engines (local, SSH, WSL2, TLS), their versions and status; Add engine (§9.2); projects per engine, each trusted or not (§12.1); credentials and sign-ins (§20.3) |
| Settings | The project's, the engine's and the app's settings (the theme among them), with their sources |

### 18.5 Desktop rules

Density over whitespace, monospace for agent output; keyboard first (a command palette, keys for approve, refuse, interrupt, drain, the answer talk; approve and refuse act only on the request shown, H62); one status mark per ticket, in the role colours (working, waiting on you, blocked, failed, done); notifications for questions, permission requests, a run's end and a hold; never push each token through `update` (buffer, once per animation frame); virtualise long lists; lazy views for inactive workers. The handoff first; for what it doesn't cover, Linear, Codex desktop, Claude desktop and VS Code's workbench.

Each screen's keys are one list of commands, from which its bindings, its hints, the key help and the command palette are drawn: tutti wrote each screen's keys three times, and they drifted (a bound key missing from its help, tutti-rvzn.8). A component subscribes to the part of the run view it draws, not the whole view, which tutti redrew everywhere at each change, up to 30 times a second (tutti-rvzn.1). Streamed text is drawn at most every 33 ms, and a tool call's streamed input not until it is whole (tutti-ejkt.8).

## 19. The CLI

\[DECISION\] The engine distribution's `fabrica` command. It talks to the local engine, or to `--engine <name>` (a known engine, reached as the app reaches it).

| Command | Does |
|---|---|
| `fabrica serve` | Runs the engine in the foreground (what the service runs) |
| `fabrica bridge` | Connects stdin and stdout to the local engine's socket, starting the engine when it isn't running; what SSH and WSL2 clients run (§8.2) |
| `fabrica service install\|uninstall\|status` | The login service |
| `fabrica engine status\|stop\|update\|version` | The engine |
| `fabrica token create\|list\|revoke` | Pairing tokens |
| `fabrica credentials set\|list\|remove\|login` | Model credentials in the engine's secret store |
| `fabrica project add <path\|url>\|list\|remove\|trust\|untrust` | Projects; `trust` lets a project's own Pi settings and packages load in its agents (§12.1) |
| `fabrica init` | Sets a project up (scout, checks, setup, requirements, rules) |
| `fabrica run [--tickets\|--ticket <id>\|--spec <file\|url> [--refine]\|--feature "<text>"\|--overnight] [--limit N] [--concurrent N] [--model …] [--auto-answer[=<duration>]] [--offline] [--wait]` | Starts a run |
| `fabrica run status\|drain\|undrain\|stop` | A run |
| `fabrica follow` | The run's events as plain lines, orchestra's plain mode |
| `fabrica answer [<id>]` | Questions and permission requests, asked on the terminal with their options; the answer talk on the terminal |
| `fabrica talk refine\|feature\|answer\|run` | A talk on the terminal |
| `fabrica tickets list\|show\|create\|update\|close\|reopen\|defer\|dep\|label\|note\|ready\|why\|rebuild` | The backlog |
| `fabrica tickets import --beads <file>` | A Beads backlog into the project (§11.6) |
| `fabrica requires [--markdown]` | The requirements' state |
| `fabrica report [<run>]` | A run's report |
| `fabrica insights [<query>]` | Telemetry summaries and the named queries (§21) |
| `fabrica insights export <folder>` | The recorded rows, metadata only, as Parquet files on the engine's host (§21) |

Every command has `--json` for scripts and agents. Flags take two dashes; one-letter shorthands one (orchestra-6rdu). What the CLI prints is sanitised for the terminal, `--json` included: escape and control sequences, C1 controls, bidi overrides and isolates and line separators are shown as escapes, since ticket titles, IDs and tool inputs come from agents (tutti-rq4j, -4zs).

## 20. Security

\[DECISION\] The renderer is treated as an untrusted web page; agents as code running with the engine user's permissions, confined by the gate (and a container where configured); a remote engine as a server holding credentials. Pi doesn't sandbox its tool calls, so the gate (§12.6) is the main control over what an agent does.

### 20.1 App

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`; no `<webview>`; a strict Content Security Policy (bundled assets only, no remote scripts, no `eval`); navigation and `window.open` to external URLs blocked, links opened in the system browser.
- Electron fuses: cookie encryption, only-load-app-from-asar, embedded asar integrity validation, **RunAsNode disabled** (agents run on the engine's own Node, never through Electron) \[VERIFY per platform\].
- The preload exposes a minimal API (window controls, the folder picker, the app's version, update status, the MessagePort), each method validated with Schema.

### 20.2 Engine

- The local socket is mode 0600 in a folder only the user can enter. TLS listeners only when configured, with tokens hashed at rest and revocable.
- Each agent gets a minimal environment: its worktree, the model proxy's address and its per-agent token (§12.9), the extension's socket and token, nothing else; never a model credential. It is built from an allowlist, never by copying the engine's own environment, so a parent agent session's variables (Claude Code's, Pi's, a terminal pane's) never reach it (H62; tutti copied its environment, and handed workers a parent Claude Code session's messaging socket and token).
- Files in a worktree are hostile (H62): the engine opens run files, check logs and answer files there without following links, non-blocking, and only when they are regular files (a named pipe at a check log's path froze tutti's whole process).
- The extension's per-agent token scopes its tools to its own ticket and those linked to it.
- A project's own Pi settings and packages load only after the user trusts the project.
- Every command the engine starts (checks, setups, requirements, git) gets the workers' allowlisted environment, so a check passes or fails for the engine as for its worker (tutti ran them in its whole environment, tutti-axpo.6), and none gets git's local variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the rest that `git rev-parse --local-env-vars` lists): tutti started from a git hook, or a shell exporting `GIT_DIR`, acted on that repository instead, and a rebase in a worktree rebased main (tutti-m6hh) (H85).
- Git's network commands (clone, fetch, push) alone also get the host's transport, where the engine has it (§11.7): the ssh-agent (`SSH_AUTH_SOCK`), the host's own ssh command (`GIT_SSH_COMMAND`, with its kind, `GIT_SSH_VARIANT`, only beside it), curl's proxies (`http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`, and the upper-case forms but `HTTP_PROXY`, which curl ignores) and CA certificates (`GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR`). ssh runs in batch mode (`-c core.sshCommand=ssh -o BatchMode=yes`) unless the host names its own ssh command, in `core.sshCommand` or `GIT_SSH_COMMAND`. Nothing that would ask is passed (`SSH_ASKPASS`, `GIT_ASKPASS`, `DISPLAY`), nor `GIT_SSH`, which git ranks under the engine's batch-mode configuration (fab-mgi.22).
- Files the engine writes in a checkout's `.fabrica/` are opened as worktree files are (H62), since a merged ticket can commit a link at `.fabrica/fabrica.log` or `.fabrica/run/`, which tutti then wrote through (tutti-oqb2). A truncating open of a file with more than one link unlinks the name and creates the file afresh, never truncating the linked file: a worker that linked `.git/config` to a check log's name had tutti overwrite it (tutti-vy3y). Every file written whole goes through one writer: a temporary file of its own name, synced, renamed, and the folder synced (tutti-q8fy) (H84).
- The gate's path confinement checks every brace alternative of a glob (`{..,src}/*` passed tutti's scout, tutti-n142), and refuses a pattern whose braces don't close or expand past 256 alternatives.
- Output read from a command past its size cap fails as cut, never parsed: a tail of JSON can read as a whole answer (tutti-bkko).

### 20.3 Credentials

\[DECISION\] Model credentials live in the engine host's secret store: the macOS Keychain; on Linux libsecret or KWallet; on a Linux host with no keyring, an encrypted file under `<data>/secrets/` with a passphrase given at the engine's start (or from a file only the user can read, for a service), which the engine warns about. They are entered through the app (sent once over the authenticated connection) or the CLI, never stored by the app for a remote engine, and never written to the work graph, the tickets ref, telemetry, logs or a worktree. Only the model proxy reads them (§12.9).

- **API keys** are set by name; a key MAY instead be a command whose output is the key (a password manager's CLI), run by the engine when the key is needed, as Pi's own `auth.json` allows.
- **Subscriptions:** `credentials.login` runs `pi-ai`'s OAuth sign-in in the engine (`models.login(provider, 'oauth', …)`) with the engine's secret store as its `CredentialStore`, and relays the sign-in URL or device code to the client that asked, so a remote engine signs in from the laptop's browser. Providers with OAuth in `pi-ai` today: Anthropic (Claude Pro and Max), OpenAI (sign in with ChatGPT), GitHub Copilot, OpenRouter \[VERIFY at the pinned version\]. Whether a provider's terms allow its subscription in a third-party agent is the user's to check; the app says so at sign-in.

### 20.4 Supply chain

Exact pins and a committed lockfile; CI verifies the checksums of every downloaded artifact; the engine distribution and its checksums are signed, and the app and `fabrica engine update` verify the signature before installing (orchestra's `checksums.txt.sig` scheme); third-party Pi packages disabled by default.

### 20.5 Licence and distribution

\[DECISION\] (H49) Fabrica is open source under the MIT licence, in a public repository, `github.com/noesis-sol/fabrica`. Releases are public GitHub Releases: the engine distributions, the app's installers, their signed checksums, and the install script's downloads. The app's updates and `fabrica engine update` read them. Signing uses the maintainer's Apple Developer ID and a Windows code-signing certificate, kept in CI's secrets. `THIRD_PARTY_NOTICES.md` lists every bundled component's licence (Node, Pi, Effect, Foldkit, DuckDB, Monaco, xterm.js, Cytoscape.js, the three fonts under the SIL Open Font License).

## 21. Telemetry

\[DECISION\] (H38) Telemetry is the engine's own, kept on its host and always on; nothing leaves the host unless the user configures an export.

- **Store** (H65, revising H38): from M1 the engine records typed rows in its own SQLite store, `<data>/telemetry.db`, one per engine across its projects, beside each project's event stream. From M6, after its M0 spike, DuckDB (`@duckdb/node-api`) is the query layer over them, at `<data>/telemetry.duckdb`. Only the engine opens either (DuckDB allows one writing process per file); clients query through the RPC's Insights group, by named queries. The work graph's database (§11.2) is never written by telemetry. DuckDB's storage version is pinned (`storage_compatibility_version`), so an upgrade can't leave the file unreadable to the engine's previous version: DuckDB 2.0 (2026-10-21) writes a format 1.x can't read. Measured on 2026-10-22: its native library is 63 MB per platform, and npm had only a release candidate of 2.0.
- **Instrumentation:** spans (`Effect.withSpan`) around each agent turn, tool call, work-graph operation, git command and RPC request; counters and histograms; structured logs.
- **What is recorded:** model calls (from the model proxy: provider, model, tokens in, out and cached, cost, latency, time to first token, refusals and errors), tool calls (name, duration, the gate's decision), checks (kind, duration, result), merges, hand-backs, holds, worker sessions (ticket, model, duration, outcome), organ calls, and the host's load samples (§7.4), each tied to its project, run and ticket.
- **Writes** go from one fiber, in batches; a crash loses at most the open batch.
- **Reads in place:** the event stream (`events.jsonl`) and Pi's session files are queried where they lie, and the work graph is attached read-only for joins with tickets \[VERIFY that the `json` and `sqlite` extensions can be bundled with the engine rather than downloaded at run time, and that DuckDB reads the work graph safely while the engine writes it\].
- **Retention:** raw rows for 90 days, daily aggregates kept (engine settings).
- **Uses:** the cost figures (§14.4), the run report (§16), the app's Insights screen (§18.4), `fabrica insights`. The named queries include where a ticket's time goes (phases, waiting by reason, the merge queue, checks by suite, hand-backs, waiting on the maintainer), the waits of questions and permission requests, check durations and flaky tests by test, and cost per merged ticket by run. tutti's queries over its event stream (`docs/analytics.md`) drove three speed scans that took a ticket from ready to merged from a median 90 minutes to 21 (2026-10-25 to 27).
- **Export**, optional and off by default: Parquet files on demand (`fabrica insights export <folder>`, one file per recorded table, written on the engine's host), or OTLP/HTTP to the endpoint the engine's `telemetry.otlp_endpoint` names (an OpenTelemetry Collector, ClickHouse or another store behind it; read as the engine starts), carrying Effect's spans and metrics (`effect/observability`'s OTLP exporters, @effect/opentelemetry's as Effect 4 ships them) and the recorded rows, one log record each. Exports carry metadata only (counts, durations, model IDs, token totals, cost, error tags), never prompts, code, file contents, secrets or absolute paths: one module decides it for both, keeping numbers and flags, and text only where its name isn't content's and it is short and names no place; a span's status message and an exception's message and stack never leave. Content capture, were it ever offered, would be a separate explicit setting, with a redaction step before anything is written. No Fabrica-hosted telemetry service in v1.

## 22. Packaging, signing and distribution

### 22.1 The engine distribution

\[DECISION\] Per engine target (§4): a tar.gz holding a pinned Node runtime, the engine bundle (`apps/engine` and `packages/engine` bundled), Pi and the first-party extension at exact versions, and migrations bundled (no runtime reads of source folders). `fabrica` is a small launcher running the bundled Node on the bundle. Signed checksums per release; macOS binaries signed and notarised.

### 22.2 The app

\[DECISION\] electron-builder, in CI, for the app's five targets (§4): dmg and zip per architecture (macOS, Developer ID, hardened runtime, notarised, every Mach-O signed), AppImage, deb and rpm (Linux), NSIS (Windows, Authenticode). Updates through electron-updater for macOS (from the zip), Windows (NSIS) and the AppImage; deb and rpm are downloads updated by hand until a package repository is worth running (H39). The macOS and Linux apps embed the engine distribution for their own architecture, for the local engine; the Windows app embeds the Linux x64 distribution and installs it in WSL2 (§7.6).

The handoff has no mark (§18.2), so the app's icon is drawn from its blocks: the title bar's CORES meter in Lichen Bright, a 3 × 3 grid whose busy blocks (`--c1`) make an F among idle ones (`--line`), on `--bg`; macOS's on Apple's icon grid, with rounded corners, the other platforms' filling its square.

### 22.3 CI

- Engine: build and test on macOS x64, macOS arm64, Linux x64, Linux arm64.
- App: build and package on the five targets; smoke-test every artifact: launch; start or reach an engine; open a fixture repository; run one ticket with a stub model to its merge; close cleanly with no orphan processes.
- Remote: an end-to-end test with an engine in a container reached through the SSH bridge.
- Windows: the app installing and reaching an engine in WSL2, where a CI runner offers WSL2 \[VERIFY; otherwise on a dedicated Windows machine before each release\].
- A runner with 2 cores among the engine's test runners (H55): a test that read the machine's cores passed on tutti's 10-core Mac and failed on CI's 2-core runners.

### 22.4 Native inventory

Anything with native code MUST appear here, with its CPU baseline: whether its x64 build needs AVX2, and its arm64 minimum (H64) \[VERIFY for Node, Pi and DuckDB\]. A component that needs what the install script's host lacks is refused there with the reason, never left to crash with "illegal instruction".

| Component | Native code | Status |
|---|---|---|
| Electron | Yes | In (the app) |
| Node runtime (engine distribution) | Yes, per engine target | In (new) |
| SQLite | None; built into Node (`node:sqlite`) | In |
| Pi coding agent | Unknown | \[VERIFY\] all four engine targets |
| DuckDB (`@duckdb/node-api`) | Yes, prebuilt per platform (at 1.5.6, unpacked: 64 MB Linux arm64, 72 MB Linux x64, 118 MB macOS) | In, engine only, from M6 (H65): prebuilt for macOS and Linux, x64 and arm64 \[VERIFY each and glibc's floor\]; its `json` and `sqlite` extensions bundled, never downloaded at run time; signed with the engine distribution on macOS |
| Monaco, xterm.js, Cytoscape.js (with dagre or ELK) | None | In |
| OpenSSH client | System's, not bundled | Required on clients for remote engines; the bridge runs over it (§8.2) |
| WSL2 | System's, not bundled | Optional on Windows, for a local engine (§7.6) |
| Docker or Podman | System's, not bundled | Optional, for containers (§12.7) |
| `node-pty` (interactive shells) | Yes | Out of v1 |
| Beads `bd` | Yes | Out (not used; its JSONL is imported, §11.6) |
| Turso, libSQL, chDB | Yes | Out (§27.1) |

### 22.5 Releases

\[DECISION\] (H51, H64) What tutti's first release taught, before Fabrica's:

- A **pre-release in M1** goes through the whole path (CI, signatures, attestation, publishing, the install script from the public URL, `fabrica engine update`), and every release after it the same way.
- **Release notes** are the version's changelog section, cut after the last whole entry within 120,000 characters with a line linking to the rest: GitHub refuses a Release's notes over 125,000 characters, as it refused tutti's first (253,019).
- **Build provenance** (`actions/attest`) needs a public repository or a paid plan; the repository is public before the first release (H49).
- **The install script** is attached to each release and fetched from `releases/latest/download/`, so it matches the archives it downloads. It installs into `~/.local/bin` by default, saying how to put it on the PATH; installs the arm64 build under Rosetta (`sysctl.proc_translated`); and checks the host's CPU against the native inventory's baselines (§22.4).
- **Size:** the engine distribution has a size budget, checked in CI \[OPEN the number; Node, Pi and DuckDB make most of it: at Fabrica 0.0.0 with DuckDB 1.5.6, 87–99 MB as archives, 279–333 MB unpacked, of which DuckDB 64–118 MB\].
- **Tag after every target's check** (H87): a release is tagged only once main's check has passed on each engine target in CI; a job the CI provider couldn't place is rerun first (GitHub had no macOS runner for one, 2026-10-28), as the release workflow's own check may run on one platform only.
- A release commit pushed alone skips CI's duplicate check through the workflow's own gate (its subject, and that it changes only the changelog and the version), never through GitHub's skip marker, which a commit message must never contain, even to name it: GitHub skips every push workflow for that commit (tutti-ac2x).
- **Changelog entries are one file per ticket** (`changes/<ticket>.md`), gathered into `CHANGELOG.md` at release: tutti's union-merged `CHANGELOG.md` kept both versions of an entry a later commit reworded, and its releases each had duplicates to drop by hand.
- The install script runs the new binary's `--version` in the folder it installs into, reading stdout only, never in `/tmp`, which hardened hosts mount `noexec` (tutti-3akw).

## 23. Developing with coding agents

\[DECISION\] (H48) Fabrica is built by orchestra 0.9 from this spec: a spec run in a new repository, whose breakdown files the environment ticket first and then each milestone's tickets, M0's spikes first (one per `[VERIFY]` that a later decision rests on; a spike that disproves a fact files a question on the decision it affects). orchestra's Beads backlog in that repository is the development tracker only; the product doesn't use Beads (H11). In it, work only the maintainer can do is filed with a `manual` label and deferred, never labelled `human`, which orchestra takes for a question (H52).

**Review gates** \[DECISION\] (H50): each milestone ends with a review of its code against this spec and orchestra's behaviour, split by area (the run loop, merging, holds, the agent layer, the UI, the services, init and the scripts), each finding checked against orchestra and filed as a ticket; the serious ones are fixed before the next milestone starts. tutti's scan, run only after it counted as complete, found a merge-queue race, commits merged unchecked and a permission prompt hiding the end of a command. Each gate also checks that each rule lives in one place, each value is read once, and every test layer wraps the live code (H78, H79).

**Lessons from building tutti** \[DECISION\] (H70, H87): ticket text names a file only where the ticket will change it, since footprints read every path a ticket names (§13.4); a description opens with the detail, not a restatement of the title, which the worker view shows above it; the maintainer's checkout stays clean while orchestra's run goes (a stray edit held tutti's merges until the run ended). Fabrica's own `check_own` selects the tests a change touches by its import graph, leaving out type-only imports, and keeps its passes by tree, as tutti's `scripts/check-own.ts` does: the median source module went from 365 test files to 212, and type-only imports took 12% more off. An agent's write tools turn `\u` escapes of printable controls into the raw characters, so such escapes are written by a script, and a lint refuses raw bidi controls, C1 controls and line separators in the source (tutti-hgdi).

**Agents' context and checks** \[DECISION\]:

- **Vendored source**: Foldkit, Effect v4 and Pi are git subtrees under `repos/`, each pinned to the exact version installed and refreshed on every upgrade; they are read-only references, and code imports from `node_modules`. Foldkit's tags are `foldkit@<version>`; `FOLDKIT.md` is replaced whole from that tag on every upgrade, and the project's own rules live in `AGENTS.md`.
- **Skills and docs**: Foldkit's official agent skills; for Effect, source-first skills (`joelhooks/pi-effect`, or `pi-effect-harness` inside Pi). Foldkit's docs are also served as Markdown (a `.md` suffix, `llms-full.txt`) for an agent without the subtree.
- **Checks after every write**: a type check and oxlint (with `@foldkit/oxlint-plugin`) on the changed files, their errors returned to the agent in-band: a Claude Code `PostToolUse` hook, and a `tool_result` handler in a development-only Pi package. Hooks, not prompts.
- **Feedback**: Foldkit DevTools MCP is connected in development, so agents can inspect the Model and replay or dispatch Messages against the running app.
- **Order of work**: for the UI, the Model and Message changes first, reviewed by a person, then story tests, then `update`, then `view`, the agent pointed at a named Foldkit example; for the engine, Schema contracts in `contracts` first, then the service interface, then tests against in-memory layers, then the implementation.

## 24. Testing and quality gates

\[DECISION\] Every layer is tested against Effect Layers swapped for test implementations, so no unit test needs a real model, a real network or a browser.

| Layer | Approach | Tools |
|---|---|---|
| Work graph | Real migrations against in-memory SQLite; leases and timeouts with `TestClock` | `@effect/vitest` |
| Tickets ref and merging | Property tests of the per-field merge (commutativity where it should hold, no lost notes, claims), against real git in temp folders | `@effect/vitest`, `fast-check` |
| Run loop | Whole-run scenarios with the live `PiAgent` over a scripted Pi RPC stream (its records, tool calls and the answers to aborts; H78), an in-memory git, `TestClock`; orchestra's scenarios as the checklist (dispatch, footprints, holds, merge queue, train, hand-backs, carry-over, usage limit, environment hold) | `@effect/vitest` |
| Git-subject behaviour | Real git in temp folders | `@effect/vitest` |
| Protocol | Client and engine over an in-memory transport, a real socket and a stdio pipe (the bridge); reconnect and resume; version mismatch | `@effect/vitest` |
| Model proxy | Against recorded provider streams per API: usage counted, a 429 with and without a reset, a rejected key, an OAuth token refreshed mid-session, two agents sharing one refresh | `@effect/vitest` |
| Telemetry | An in-memory DuckDB: batched writes, retention, the named queries over fixture events and sessions | `@effect/vitest` |
| Run lease | Two engines on one remote in temp folders: a refused start, renewal, expiry and takeover | `@effect/vitest` |
| Sleep | The wake service under `TestClock`: a gap taken for a sleep, the limits it crossed put off, resets left on the wall clock (H66) | `@effect/vitest` |
| Soak | One engine through many runs and tickets with scripted agents: memory, file handles, fibers and subscriptions flat at the end (H77) | `@effect/vitest` |
| Pi contract | Real pinned Pi in RPC mode with the extension, against a stub model provider, on every Pi upgrade \[VERIFY stub-provider support\] | Vitest |
| UI state | Foldkit story tests on `update`, Commands resolved inline | `foldkit/story` |
| UI behaviour | Foldkit scene tests with accessible locators | `foldkit/scene` |
| UI look | The console with fixture data at 1280 × 800, captured in each theme and compared with the handoff's rendered references (`design/console/*.png`); colour-literal lint | The packaged-app test tool's screenshots |
| Packaged app | Smoke tests per target (§22.3), driving the packaged app | Playwright's Electron support \[VERIFY it attaches to a packaged, fused build on each target\] |
| Remote | An engine in a container over SSH, end to end | CI |

**Lessons from orchestra's tests** \[DECISION\]: a test's environment is airtight (a PATH holding only its fakes and the real tools it names; no inherited terminal variables; a lint against reading the process environment in tests), and tests assert on typed events, not log wording (orchestra-nqbn, -163s, -lx4d.12, -lx4d.21).

**Lessons from tutti's tests** \[DECISION\] (H55):

- Test files run in parallel, in as many workers as the run's share of the cores (`FABRICA_CORES`), or half the machine's without one; tutti's suite ran one file at a time on one of ten cores (224 s), and in parallel took 51–70 s. At every core, timing-sensitive tests failed.
- No test reads facts about its host: its cores, memory, load, clock or home folder are injected, as its PATH and environment are.
- Whole-run tests use `TestClock` with whole-millisecond durations and no real-time sleeps; a test's default time limit allows for a loaded machine (15 s), and a test that times out is rerun like any failure, reported as flaky if it then passes.
- A template is filled without interpreting its values: a lint refuses `String.replace` with a replacement string built from text a model, worker or project wrote (tutti's init corrupted commands holding `$$`).

**Lessons from tutti's tests, since** \[DECISION\] (H78, H88):

- **Test layers wrap the live code**: a test layer replaces only the outermost boundary (Pi's RPC stream, a child process, the network, the clock, the file system) and runs the live service over it. tutti's scripted agent host had a lifecycle of its own, and its scenarios passed on code no run ran (tutti-rvzn.31); its Checks, Git, Organs and other test layers each restated a live rule and drifted from it (tutti-axpo.7 to .14).
- **No real sleeps**: tests wait on events, frames or the injected clock, and so does every guard that counts time, the answer guard among them. tutti's nine slowest test files went from 60.8 s to 22.4 s that way (tutti-gr4z.5), and its panel test failed on a slow CI runner whose first key came after the 500 ms guard had run out in real time (2026-10-29).
- **Reruns**: a file's failed tests are rerun together in one process, the files side by side; an error between tests whose stack is in a timed-out test's file goes with that test's rerun (tutti-0vbd.4, -06a).
- **Platform facts are pinned per platform**: on Linux a test runner's workers die with it (Bun sets `PR_SET_PDEATHSIG`) while on macOS they outlive it; macOS `ps -E` shows no environment for platform binaries; macOS scans a newly written executable for 0.2–0.8 s the first time it runs, so stub scripts are made once per file; CI's macOS runners start processes at nice -10 and may raise a lowered one back (tutti-6ns2, -djtt). Commands are found on the PATH they will run with, not the one the process started with (tutti-xj3t).
- CI's test jobs use every core of their runner, and local runs half (tutti-ejkt.10).

**Gates on every pull request:** type check, lint, format check; unit, story and scene tests; migrations up from empty and from the previous release's fixtures; the ticket-file schema's previous version readable; no new native-inventory entry without review.

## 25. Milestones

| Milestone | Delivers |
|---|---|
| M0 Spikes | Pi in RPC mode on the bundled Node with the extension (tools with wrapped schemas, the gate, `agent_before_settle`, `project_trust`, the system prompt, a per-process configuration folder) \[the VERIFYs of §12\]; the model proxy in front of Pi with a base URL override, for an API key and an Anthropic subscription; Effect RPC over a socket, a stdio pipe, a WebSocket and a MessagePort relay; the SSH bridge from macOS, Linux and Windows clients, and through `wsl.exe`; `node:sqlite` and DuckDB in the engine's Node on all four engine targets, with each native component's CPU baseline; whether Pi's bash tool detaches its commands; Foldkit in Electron with the connection process |
| M1 Engine core | The daemon, projects, the work graph in SQLite, the CLI's ticket commands (Beads import included), the RPC server, the model proxy for API keys; a run with dispatch to Pi, `finish`, and the merge queue's basic path (rebase, `check_fast`, fast-forward); `follow`; time awake and the event stream's writing rules (H66, H84); telemetry rows recorded (H65); a pre-release through the whole release path (§22.5, H51) |
| M2 The run loop | Footprints (H70) and holds, solo tickets, the verifier, hand-backs, setup, `check_own` and `check_full`, rechecks, carry-over and resumes into slots (H76), the merge queue's diagnoses (H71, H72), the environment, usage-limit and credentials holds (H69), the event stream, reports, the train |
| M3 The app | The design tokens and the three themes; the console (the projects sidebar, the system stats, the stats row, History, In progress with the phase bar, Needs your attention with questions and permissions inline); engines and projects; the worker view; the local engine's lifecycle; notifications |
| M4 Remote | Installing and updating engines over SSH and in WSL2, the bridge, TLS and tokens, credentials on the host and subscription sign-ins, pushing and fetching, the tickets ref, its sync and the run lease |
| M5 Organs and talks | Triage, predictor, reviewer, scout; `init`; requirements; the talks (refine, feature, answer, run); spec runs |
| M6 Overnight and 1.0 | Overnight runs, the machine budget and the system stats, budgets, DuckDB over the recorded telemetry and the Insights screen, containers, packaging and signing for every target, updates; the soak test (H77); a parity audit against orchestra 0.9.1 (§26) |

Each milestone ends with its review gate (§23, H50).

## 26. Parity with orchestra 0.9.1

The parity audit (M6) checks each orchestra feature against Fabrica. Its starting matrix:

| orchestra | Fabrica |
|---|---|
| Beads backlog (`bd`) | The work graph (§11); `fabrica tickets` for people; the extension's tools for workers |
| Workers in Herdr, tmux or cmux tabs; hooks; screen reading | Pi processes owned by the engine; state from Pi's events and the control channel (§12) |
| `orchestra hook`, the Stop hook, settle heuristics, nudges | `finish`/`defer`/`wait_for`/`ask_question`; one nudge for a turn without an outcome (§12.3) |
| Claude Code's permission modes, the auto classifier | The neutral policy enforced by the gate (§12.6) |
| The verifier subagent | The engine's verifier session (§13.6) |
| `claude -p` organs | `pi-ai` calls or short Pi sessions (§16) |
| The worker prompt appended to Claude Code's system prompt | Standing rules injected by the extension (§12.4) |
| The dashboard (Bubble Tea) and plain mode | The app (§18) and `fabrica follow` (§19) |
| `orchestra update` | App and CLI updates; engines updated over SSH (§9.2) |
| Runs registry and `--machine-workers` across runs | One engine per machine and its budget (§7.3) |
| Everything in §13–§17 | Same behaviour, as specified |
| Herdr/tmux/cmux, lost agent names, tabs left open, adoption of live workers, `●`/`⏺` bullets, hook input types, Claude's usage-limit screens, `--chrome`, MCP server choice for Claude | Not applicable |

**Departures from orchestra** (H54), on purpose, each specified where it applies:

| orchestra | Fabrica | Why |
|---|---|---|
| A worker gone, blocked or unknown stops the whole run (exit 3) | Its ticket is set aside and the run goes on; exit 3 unused (§14.5) | Pi workers are owned by the engine (H37) |
| The usage-limit hold lifts at the reset, retried every 15 min with no reset known | Lifts when the model proxy's probe goes through; a past reset taken as unknown (§14.2) | The proxy sees the provider first-hand (H60) |
| `human`-labelled tickets are questions | Questions are typed tickets with options; maintainer tasks are their own type (§2.1, §15.1) | A task by hand isn't a decision (H52) |
| The recommended option is preselected | Not for a question that closes, cancels, defers or freezes work (§15.2) | Such answers are hard to undo (H53) |
| A ticket's worker may commit while its ticket merges | The gate refuses commits in a worktree in the merge queue (§12.6) | The commit checked is the commit merged (H59) |
| A project with no merge check merges unchecked | It doesn't merge unless `check_fast: none` is explicit (§13.7) | A half-set-up project mustn't merge silently (H62) |
| Paths and functions in a ticket's text count wherever they are named | A ticket's `files` first, its text only without them; a function only where the repository declares it (§13.4) | 824 of 862 hold-minutes in tutti's runs were false (H70) |
| A ticket waiting to merge holds on its whole footprint | On the files its branch changed (§13.4) | Once the work is done, the branch is the truth (H70) |
| A dirty checkout stops merging until the run ends (`DIRTY_TREE`) | Merges wait, naming the files, and go on once it is clean (§13.7) | A stray edit shouldn't cost a run its merges (H72) |
| Questions wait for the maintainer | `--auto-answer` takes a run's questions that aren't consequential with their recommended option (§15.2) | Unattended runs; tutti's, the maintainer's choice (H82) |

## 27. Deferred options and changes

### 27.1 Set aside

Each option below was weighed and set aside. Don't bring one back without meeting its condition.

| Option | Status | Why | Revisit when |
|---|---|---|---|
| Beads (`bd`) | Not used; its JSONL is imported (§11.6) | A Go binary with an embedded database to bundle and sign; with one writer, the engine's own work graph is cheap | Only an export to Beads is wanted |
| Turso Database | The preferred later engine for the work graph | Concurrent writes, change data capture and local-first sync fit; pre-1.0, no darwin-x64 build, no Effect driver | It reaches 1.0 with every engine target built and its sync settled: then an Effect driver and a Layer swap (§11.6) |
| libSQL | Deferred | Maintained, but new work goes to Turso Database; a native addon | Turso stalls and sync is needed |
| LiveStore | Deferred | Beta; Effect SQL's reactive queries cover the live UI | Multi-device state beyond the tickets ref is needed |
| DoltLite | Deferred | Commits, branches, diffs and merges inside the database itself | Field history beyond the ref's commits and events is needed |
| PGlite or Postgres | Deferred | Useful only for a server-backed team version | A team or cloud mode is planned |
| A shared live claim service | Not built | The run lease lets one engine run a project at a time (§11.5) | Several engines must run one project at once |
| Hosted telemetry (ClickHouse) | Deferred | Telemetry stays on the engine's host (§21); OTLP export reaches a collector the user runs | A Fabrica-hosted service is planned |
| chDB or clickhouse-local | Not used | Native binaries on every target | Never, for the engine's own telemetry |
| React, React Flow, shadcn/ui, Web Awesome | Not used | Foldkit and the design handoff chosen (H28, H42) | Foldkit is replaced |
| Interactive shells (`node-pty`) | Deferred | A native addon | Users need to type into agents' shells |
| A Windows engine, Windows arm64, Linux armv7l, musl | Not built | §4 (H25, H39) | Demand |

### 27.2 Changes to decisions

A \[DECISION\] changed after 2026-10-29 is recorded here: what it was, what it is now, and why. None yet.

## 28. Open questions

Settled with the maintainer on 2026-10-21 (H29–H49), except where marked; the `[VERIFY]`s they leave are M0's work (§25).

- [x] **Pi's APIs** (§12, §16, §20.3): `pi --mode rpc` (JSONL, correlated by `id`); `before_agent_start` for the standing rules; `agent_before_settle` for the nudge; `tool_call` blocking; `project_trust`; `--session-dir` and `switch_session`; organs through a forced `answer` tool (`pi-ai` has no JSON-schema mode); subscription sign-ins through `pi-ai`'s `models.login`. `before_provider_request` is no longer needed (the model proxy, H29). Still to verify in M0: base URL overrides, a per-process configuration folder, usage fields, a stub provider for tests, native code.
- [x] **Agents' credentials** (§12.9): a model proxy in the engine (H29).
- [x] **Effect RPC transports** (§8): `effect/unstable/rpc`, NDJSON over Effect's `Socket`, `RpcServer.makeProtocolWebsocket`. M0 verifies the stdio pipe and the MessagePort relay; the fallback stays a thin tagged protocol with Schema-encoded frames.
- [x] **SSH** (§8.2, §9.1): a stdio bridge, no forwarding (H30).
- [x] **WSL2** (§7.6, §22.2): automated, through the same bridge (H31).
- [x] **Ticket-file clocks** (§11.3): a hybrid logical clock per field (H32).
- [x] **Sync intervals** (§11.3, §11.4): commit within 2 s, push at once, fetch every 60 s in a run, 15 min idle (H33).
- [x] **Two engines on one project** (§11.5): forbidden, through the run lease (H34).
- [x] **A run's start without the remote** (§11.5): refused unless `--offline`; on a clash, the later run drains (H41).
- [x] **`machine_workers` default** (§7.3): half the cores, at least 2 (H35).
- [x] **Containers** (§12.7): Docker or Podman, rootless preferred, with limits (H36).
- [x] **Stops that remain** (§14.5): always set aside (H37).
- [x] **Stream intervals** (§8.3): the run view at most every 50 ms and token batches every 50 ms, whole milliseconds, as settings (H40, H55).
- [x] **Telemetry** (§21): DuckDB, local and always on; export optional; no hosted service in v1 (H38).
- [x] **Builds** (§4, §22.2): per-arch macOS; no Windows arm64 or armv7l; deb and rpm by hand (H39).
- [x] **UI gaps** (§18): Cytoscape.js with dagre or ELK (H40); split panels and trees from `@foldkit/ui` or as Foldkit submodels; Playwright's Electron support for the packaged app (set without a separate question; both carry a `[VERIFY]`).
- [x] **Type checker** (§6): `tsgo`, `tsc` as fallback (H40).
- [x] **Beads JSONL interop** (§11.6): import in v1, export later (H40).
- [x] **The console's design** (§18.2, §18.3): the handoff, its sidebar, chat, progress and window controls adapted (H42 to H46).
- [x] **What tutti 0.2.0 to 0.5.0 taught** (H66–H92, 2026-10-29): carried over from tutti's evidence and the maintainer's choices there; any of them may be revisited before M0.
- [ ] **A second design handoff** (§18.4): the screens the console handoff doesn't draw (the worker view, the backlog and its graph, review, Insights, the talks, engines and projects, settings) and its flows (adding a project, starting a run, the command palette). Derived from the console's language until then.
- [ ] **The engine distribution's size budget** (§22.5): a number to check in CI.
- [ ] **The merge check while the verifier runs** (§13.6, §13.7): starting a ticket's merge check as its verifier starts, on the tree the verifier reads, would take about 75 s off 88% of tutti's merges (a median 96 s from the last verifier's start to the worker settling, with no commit after it in 26 of 26 tickets), and shorten the wait of a ticket held behind it. It must never run beside another check (pairs slowed 1.1–2.3×), and a commit after it means checking again. tutti deferred it, to design with the maintainer (tutti-gr4z.12).

## 29. References

- orchestra 0.9.1: `github.com/noesis-sol/orchestra` (docs: running, workers, setup, organs, dashboard, events; `skills/orchestra/SKILL.md`).
- tutti: `github.com/noesis-sol/tutti` (spec `.orchestra/specs/tutti-spec.md`, `docs/parity.md`, the carry-over epic tutti-kkb; its changelog from 0.2.0 to 0.5.0, 2026-10-23 to 29; its design reviews tutti-axpo and tutti-rvzn; its speed scans tutti-ejkt, tutti-gr4z and tutti-0vbd; `docs/analytics.md`).
- Pi: [extensions](https://pi.dev/docs/latest/extensions), [packages](https://pi.dev/docs/latest/packages), [earendil-works/pi](https://github.com/earendil-works/pi); for the Effect boundary, [sjunepark/pi-effect](https://github.com/sjunepark/pi-effect), [pi-effect-harness](https://pi.dev/packages/pi-effect-harness), [joelhooks/pi-effect](https://github.com/joelhooks/pi-effect).
- Effect v4: [API reference](https://effect.website/docs/v4/api), [SqlClient](https://effect.website/docs/v4/api/effect/sql/SqlClient), [SqlModel](https://effect.website/docs/v4/api/effect/sql/SqlModel), [Migrator](https://effect.website/docs/v4/api/effect/sql/Migrator), [SqliteClient for Node](https://effect.website/docs/v4/api/sql-sqlite-node/SqliteClient), [SqliteMigrator for Node](https://effect.website/docs/v4/api/sql-sqlite-node/SqliteMigrator); source at [Effect-TS/effect](https://github.com/Effect-TS/effect).
- Foldkit: [foldkit.dev](https://foldkit.dev/), [Get started](https://foldkit.dev/get-started), [AI-assisted development](https://foldkit.dev/ai/overview), [foldkit/foldkit](https://github.com/foldkit/foldkit).
- Work-graph designs: [Beads](https://github.com/gastownhall/beads/) and [its architecture](https://beads.gascity.com/architecture), [taskgraph](https://github.com/BudEcosystem/taskgraph), [clu](https://github.com/Arjia-Labs/clu), [OpenTasks](https://github.com/alexngai/opentasks).
- Deferred engines: [Turso Database](https://github.com/tursodatabase/turso/), [its TypeScript reference](https://docs.turso.tech/sdk/ts/reference), [libSQL](https://docs.turso.tech/libsql), [LiveStore](https://github.com/livestorejs/livestore).
- The Electron landscape: [a 2026 audit of Electron apps](https://codenote.net/en/posts/famous-electron-apps-2026-research/), [agent orchestrator desktop apps](https://rywalker.com/research/t/electron).
- Hosted remotes and `refs/fabrica/tickets` (§11.7, fab-mgi.2.10, read 2026-10-30):
  - GitHub: [`refs/pull/` read-only](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/checking-out-pull-requests-locally), [rulesets target branches or tags](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) and [push rulesets every push](https://docs.github.com/en/rest/repos/rules), [push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection), [pre-receive hooks on GHES 3.17](https://docs.github.com/en/enterprise-server@3.17/admin/enforcing-policies/enforcing-policy-with-pre-receive-hooks/creating-a-pre-receive-hook-script), [limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits).
  - GitLab: Gitaly's reserved prefixes, `InternalRefPrefixes` in [`internal/git/reference.go`](https://gitlab.com/gitlab-org/gitaly/-/blob/master/internal/git/reference.go) and [MR 3426](https://gitlab.com/gitlab-org/gitaly/-/merge_requests/3426); a push to them refused, [issue 215432](https://gitlab.com/gitlab-org/gitlab/-/issues/215432); commit push rules on `refs/notes/commits`, [issue 209901](https://gitlab.com/gitlab-org/gitlab/-/issues/209901); [push rules](https://docs.gitlab.com/user/project/repository/push_rules/); Geo and custom refs, [issue 5721](https://gitlab.com/gitlab-org/gitlab-ee/issues/5721).
  - Bitbucket: Cloud's [branch permissions](https://support.atlassian.com/bitbucket-cloud/docs/use-branch-permissions/) and [repository limits](https://support.atlassian.com/bitbucket-cloud/docs/reduce-repository-size/); Data Center's [permission patterns](https://confluence.atlassian.com/bitbucketserver103/branch-permission-patterns-1822721201.html) and [reserved pull-request refs](https://support.atlassian.com/bitbucket-data-center/kb/pullrequestrefguardhook-vetoed-the-push-request-message-seen-in-bitbucket-server-logs/).
  - Probed with `git ls-remote` and fetches: `github.com/git-bug/git-bug` (`refs/bugs/*`), `github.com/google/git-appraise` (`refs/devtools/*`), `gitlab.com/inkscape/inkscape` (`refs/replace/*`), `bitbucket.org/atlassian/atlassian-connect-express` (`refs/remotes/*`).
- The Fabrica Console design handoff (`design_handoff_hivemind_console`, 2026-10-21), kept under `design/console/` (Appendices A to C).
- Added in the refinement: Pi's RPC mode, extension events and `pi-ai`'s OAuth sign-ins (Pi's docs and source at the pinned version; issue #7368 on `before_provider_request`); DuckDB's Node package (`@duckdb/node-api`) and its Appender; Effect RPC's socket and WebSocket protocols; Cytoscape.js's dagre and ELK layouts; `tsgo`; Playwright's Electron support.

## Appendix A. The console design handoff

The handoff as designed on 2026-10-21, under Fabrica's first name, Hivemind (`design_handoff_hivemind_console`), carried here so that the spec needs none of its files to be read. It is **high fidelity**: colours, type, spacing and radii are final, recreated pixel-accurately at its 1280 × 800 reference window. It drew a dashboard for supervising several coding agents: a sidebar of sessions, then ticket and system stats, a chat with the orchestrator, an activity history, and two ticket columns, one for work in progress and one for tickets that need a person. The same layout ships in three themes, **Lichen Bright** (the default), **Classic** and **Neon Grid**.

Where Fabrica's console departs from it, §18.3 says so and wins; the departures are marked *(Fabrica: …)* below. Its HTML is a reference to recreate in Foldkit, not code to copy (its own suggestion of React doesn't apply, §18.2).

### A.1 Layout

```text
┌ Title bar 38px ──────────────────────────────────────────────────────┐
├ Sidebar 260px ─┬ Main (padding 20px 24px, column, gap 16px) ─────────┤
│ Header         │ Ticket stats row (one compact strip)                 │
│ Session list   │ ┌ Conversation agent (1fr) ──┬ History (320px) ┐ 156px│
│                │ └────────────────────────────┴─────────────────┘      │
│                │ ┌ In progress (1fr) ─────────┬ Needs your attention ┐ │
│ [+ New session]│ │ scrolls                    │ (1fr) scrolls        │ │
└────────────────┴──────────────────────────────────────────────────────┘
```

- The window is a flex column; the body a grid, `260px minmax(0,1fr)`.
- The ticket columns are a grid, `minmax(0,1fr) minmax(0,1fr)` with a 16px gap. They take the remaining height (`flex:1; min-height:0`), and each column has `overflow:auto`.

### A.2 Components

**Title bar**

- Height 38px, background `--side`, a 1px bottom border in `--line`, padding 0 14px, gap 8px.
- Window controls: three 12×12 squares in `--c3`, `--c2` and `--c1`, with the theme's radius. *(Fabrica: dropped for the native controls, H46.)*
- App name: 13px, weight 700, a 16px left margin. *(Fabrica: "Fabrica".)*
- System stats, right-aligned with an 18px gap, 12px `--mono` in `--muted`, values in `--fg`:
  - `MEM`: a 64×6 bar (track `--line`, fill `--c4`), then "11.2/32 GB";
  - `CPU`: a 64×6 bar (fill `--c5`), then "47%";
  - `CORES`: one 5×12 block per core with a 2px gap, busy cores `--c1` and idle ones `--line`, then "6/10".
  *(Fabrica: the selected project's engine host, with warning colours, §18.3; the usage windows beside them, H90.)*
- Search field: 260×24, a 1px `--line` border, radius `--rb`, the placeholder "Search tickets and sessions ⌘K" at 12px in `--muted`. *(Fabrica: it opens the command palette.)*

**Sidebar** *(Fabrica: projects and their runs, H43)*

- Background `--side`, a 1px right border in `--line`.
- Header: padding 16px 16px 10px; the title ("Coding sessions"; *Fabrica: "Projects"*) at 13px, weight 800, on the left, the count at 12px in `--muted` on the right.
- Row: a grid of `22px 1fr auto` with a 10px gap, padding 10px 16px.
  - Chip: a 22×22 square in the row's colour, radius `--rb`, holding a 2-digit index at 11px, weight 800, in `--ink`.
  - Name: 14px, weight 600, cut with an ellipsis.
  - Branch: 12px `--mono` in `--muted`.
  - Status label on the right, 12px: Running in `--c1`, Waiting in `--c2`, Idle with no colour.
  - Selected row: background `--panel` and a 3px left border in `--c1`; other rows have a transparent left border.
- Button pinned to the bottom (`margin-top:auto`): its container padded 12px 16px with a 1px top border in `--line`; the button padded 8px 12px, background `--c1`, its label ("+ New session"; *Fabrica: "+ Add project"*) at 13px, weight 700, in `--ink`, left-aligned, radius `--rb`, shadow `--glow1`, hover `brightness(1.08)`.

**Ticket stats row**

- A wrapping flex row with a 1px `--line` border, radius `--r`, background `--panel`.
- Each item is padded 10px 18px with a 1px right divider: a value at 20px, weight 800, in its stat's colour, then a label at 12px, weight 700, in `--muted`, side by side on the baseline with an 8px gap.
- Items: "7 Agents live" in `--c1`, "23 Tickets done" in `--c4`, "3 Needs you" in `--c2`, "1.2M Tokens" in `--c5`. *(Fabrica: live workers against the slots, done today, set aside, needs you, in queue, tokens, and the run's controls at its right end, §18.3.)*

**Conversation agent panel** *(Fabrica: the run talk, H44)*

- Background `--panel`, a 1px `--line` border, radius `--r`.
- Header (padding 8px 12px, a bottom border): an 8×8 square in `--c5`, the agent's name at 13px, weight 800, "orchestrator" at 12px in `--muted`, and on the right the model and its context ("claude · 14k ctx") at 11px `--mono`.
- Messages: a flex column with `justify-content:flex-end` and `overflow:auto`, padding 8px 12px, gap 6px, 12.5px text at line-height 1.35. Each row is a grid of `64px 1fr`; the author at 12px, weight 800: "You" in `--c1`, the agent in `--c5`.
- Composer (padding 8px 12px, a top border): a "›" prompt in `--c1` `--mono`, weight 700, the placeholder "Ask the agents or give an instruction…", and a "⏎" key cap on the right.

**History panel** (320px)

- The conversation panel's styling.
- Header: "History" on the left, "Today" on the right.
- Rows: a grid of `40px 6px 1fr` with an 8px gap, padding 5px 12px, 12px text: a time in `--mono` `--muted`, a 6×6 dot in the event's colour, and the text on one line, cut.
- Event colours: merged or a pull request `--c4`, an approval request `--c2`, a failure `--c3`, a session started `--c1`. *(Fabrica: organs and the run talk's actions in `--c5`, §18.3.)*

**Column headers**

- A 14px, weight 800 title and a 12px count, with 8px of bottom padding.
- "In progress" has a 2px bottom border in `--c1`; "Needs your attention" one in `--c2`, its count in `--c2` too.

**In-progress card**

- Background `--panel`, a 1px `--line` border, radius `--r`, padding 12px 14px, a column with an 8px gap.
- Row 1: the ID (12px `--mono`, `--muted`) and the title (14px, weight 700).
- Row 2: a 4px progress bar, its track `--line`, its fill the agent's colour at the percentage done. *(Fabrica: the phase bar, no percentage, H45.)*
- Row 3: 12px `--muted` text: the agent's name (weight 700, in its colour), the current step, and the elapsed time on the right.

**Needs-attention card**

- The same card, with no coloured left border.
- Row 1: a kind tag (11px, weight 800, padding 2px 6px, radius `--rb`, its background the kind's colour, its text `--ink`), the ID, and "waiting 14m" on the right in `--c2`.
- The title at 14px, weight 700; the reason at 13px in `--muted`.
- Actions: a primary button (background `--c2`, text `--ink`, weight 700, 13px, padding 6px 12px, radius `--rb`, shadow `--glow2`) labelled by the kind, Approve, Answer or Review; and a ghost "Open session" button in `--fg`.
- Kind colours: Approval `--c2`, Question `--c5`, Review `--c4`. *(Fabrica: also Your task in `--c2`, for a maintainer task, §18.3.)*

### A.3 Behaviour

- Selecting a sidebar row gives it the selected style and scopes the main area to it.
- The primary action on an attention card resolves the request, and the ticket goes back to In progress; "Open session" focuses its session. *(Fabrica: the worker view.)*
- The composer sends to the orchestrator; new messages appear at the bottom, and the list scrolls when it overflows.
- The system stats refresh about every second; History adds new events at the top.
- Hover: rows and cards lighten their background or border slightly; buttons take `brightness(1.08)`.
- Focus: a 2px outline in `--c1` with a 2px offset.
- The handoff left the "New session" flow undesigned. *(Fabrica: Add project, §10.1, and the screens of §18.4 wait for a second handoff, §28.)*

### A.4 Tokens

- **Roles**: `c1` running, `c2` needs attention, `c3` error, `c4` done, `c5` information.
- **Surfaces**: `bg`, `side` and `panel`, with `line` for borders; text in `fg` and `muted`, and `ink` for text on coloured fills.
- **Radii**: `r` for cards, `rb` for buttons and chips, `rw` for the window.
- **Shadows**: `glow1` and `glow2`, `none` but in Neon Grid.
- **Fonts**: Archivo (Lichen Bright), Inter (Classic), JetBrains Mono for everything in Neon Grid. The handoff names Google Fonts; Fabrica bundles them (§18.2).
- **Spacing**: 4, 6, 8, 10, 12, 16, 18, 20 and 24px.
- **Assets**: no images. The UI uses type, colour blocks and Unicode glyphs (›, ⏎, ⌘); Lucide where icons are added later.
- One theme applies at a time, through `data-theme` on the root element. The values are Appendix B's.

## Appendix B. The theme tokens

`themes.css` as the handoff gives it, the only source of colours, fonts, radii and glows (§18.2). It is copied into `packages/ui` unchanged; this copy and `design/console/themes.css` are the same text.

```css
/* Hivemind console themes. Apply one by setting data-theme on the app root. */
/* Role mapping: c1 = running, c2 = needs attention, c3 = error, c4 = done, c5 = info */

[data-theme="neon-grid"] {
  --bg: #05060B; --side: #030409; --panel: #0B0D18;
  --line: rgba(255,46,155,0.24); --muted: #7A82A2; --fg: #E8ECF8;
  --c1: #00E5FF; --c2: #FF2E9B; --c3: #FF3D3D; --c4: #39FF14; --c5: #FFB800;
  --ink: #05060B;
  --font: 'JetBrains Mono', ui-monospace, monospace;
  --mono: 'JetBrains Mono', ui-monospace, monospace;
  --r: 0px; --rb: 0px; --rw: 0px;
  --glow1: 0 0 18px rgba(0,229,255,0.5);
  --glow2: 0 0 18px rgba(255,46,155,0.55);
}

[data-theme="classic"] {
  --bg: #1A1D21; --side: #19171D; --panel: #222529;
  --line: rgba(255,255,255,0.1); --muted: #949BA4; --fg: #D1D2D3;
  --c1: #2BAC76; --c2: #C2724E; --c3: #E5484D; --c4: #5B9BD5; --c5: #D4A574;
  --ink: #FFFFFF;
  --font: Inter, system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --r: 6px; --rb: 4px; --rw: 10px;
  --glow1: none; --glow2: none;
}

[data-theme="lichen-bright"] {
  --bg: oklch(0.19 0.025 140); --side: oklch(0.165 0.025 140); --panel: oklch(0.235 0.03 140);
  --line: oklch(0.31 0.035 140); --muted: oklch(0.72 0.0375 140); --fg: oklch(0.94 0.015 140);
  --c1: oklch(0.86 0.17 125); --c2: oklch(0.82 0.16 75); --c3: oklch(0.72 0.16 25);
  --c4: oklch(0.82 0.11 190); --c5: oklch(0.78 0.1 295);
  --ink: oklch(0.2 0.02 140);
  --font: 'Archivo', system-ui, sans-serif;
  --mono: ui-monospace, monospace;
  --r: 0px; --rb: 0px; --rw: 0px;
  --glow1: none; --glow2: none;
}
```

## Appendix C. Where the design's files are

| Files | Where | In the repository |
|---|---|---|
| `README.md` (the handoff, carried in Appendix A), `themes.css` (Appendix B), `Hivemind Console Kits.dc.html` (the three themes side by side, the primary reference), `Hivemind Console Reference.dc.html` (Lichen Bright alone, with its palette), `kits.png` and `reference.png` (the two references rendered at their size, which the UI look tests compare against, §24) | `design/console/` in the repository | Yes, committed |
| The whole export: the README, `themes.css` and the two HTML references, with `support.js` and `_ds/…/styles.css`, which the HTML needs to open in a browser | `~/Desktop/design_handoff_hivemind_console/` on the maintainer's Mac | No: the design tool's runtime has no licence of ours, so it stays out of the public repository (§18.2) |
| An earlier copy of `design/console/`, the PNGs included | `~/Projects/hivemind/design/console/` (the earlier repository, `noesis-sol/hivemind`) | No |

To open an HTML reference, put it beside `support.js` and `_ds/` from the whole export. The screens the handoff doesn't draw wait for a second handoff (§18.4, §28).


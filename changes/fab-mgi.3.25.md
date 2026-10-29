- Projects (spec §10.1, §10.2): the engine registers a checkout on its host where it is, or clones a git URL
  into `<data>/projects/<id>/repo/` with the host's git credentials. Adding one checks it as a run's start
  does (git 2.38 or later, a repository's main checkout on a branch, which is its Base, its settings valid
  where it has them), listing every problem, and removes a clone it couldn't add. It makes `.fabrica/`, keeps
  `work.db*`, `run/`, `reports/` and `fabrica.log` out of git through the repository's `info/exclude`, and
  opens the project's work graph on `.fabrica/work.db`, its ticket prefix from the project's name; a
  project with no settings yet is offered `fabrica init`.
- The Projects RPC group is served: `projects.add`, `list`, `remove` (a registered checkout stays where it
  is), `settings.get` and `settings.set`, which writes only the settings that changed and keeps the file's
  formatting, and the project status stream, a snapshot then numbered patches that a client resumes after
  its last. `projects.init` is M5's.
- `fabrica project add <path|url> [--name <name>]`, `fabrica project list` and `fabrica project remove <id>`
  talk to the engine, with `--json`.

// A command's environment (spec §20.2, H62, H85): the one rule for what every command the engine
// starts (git, checks, setups, requirements, agents) gets. It is built from an allowlist of the
// engine's own variables and the variables its caller names, never by copying the engine's
// environment, so a parent session's variables (Claude Code's, Pi's, a terminal pane's) never reach
// a command; and it never holds git's local variables, so a command never acts on a repository a
// git hook or a shell exporting `GIT_DIR` pointed the engine at.

/** The engine's own variables a command gets, where the engine has them. */
const ALLOWED: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
])

/** The locale's categories: `LC_ALL`, `LC_CTYPE` and the rest. */
const LOCALE = /^LC_[A-Z]+$/

/**
 * Git's local variables, as `git rev-parse --local-env-vars` lists them from git 2.38 on
 * (`GIT_INTERNAL_SUPER_PREFIX` as git 2.38 had it): each points git at one repository, and none is
 * ever passed to a command, not even when its caller names it.
 */
export const GIT_LOCAL_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
])

const allowed = (name: string): boolean =>
  ALLOWED.has(name) || LOCALE.test(name)

/**
 * A command's environment: the allowlisted variables of `host` (the engine's environment, read once
 * where the engine starts), then the caller's `extra` over them, less git's local variables.
 */
export const commandEnvironment = ({
  host,
  extra,
}: {
  readonly host: Readonly<Record<string, string | undefined>>
  readonly extra: Readonly<Record<string, string>>
}): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(host)) {
    if (value !== undefined && allowed(name)) environment[name] = value
  }
  for (const [name, value] of Object.entries(extra)) environment[name] = value
  for (const name of GIT_LOCAL_VARIABLES) delete environment[name]
  return environment
}

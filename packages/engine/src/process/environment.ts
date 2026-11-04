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

/**
 * What a command reaching a remote also gets, where the engine has it (spec §10.1, §10.3, §11.7): the
 * host's own transport, so a clone, fetch or push signs in and connects as the host's own git would.
 * The ssh-agent holding the keys an SSH URL signs in with; the host's own ssh command, which git
 * ranks over `core.sshCommand`, and its kind with it (`GIT_SSH_VARIANT`); curl's proxies, as curl
 * reads them (never `HTTP_PROXY`, which curl ignores, since a CGI server sets it from a request's
 * `Proxy` header); and the CA certificates an HTTPS URL's server is checked against. Only git's
 * network commands get them, never an agent's or a check's command. What would ask is never passed
 * (`SSH_ASKPASS`, `GIT_ASKPASS`, `DISPLAY`), since a network command fails instead of asking; nor is
 * `GIT_SSH`, which git ranks under the batch-mode ssh command the engine names where the host names
 * none.
 */
const NETWORK: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND',
  'http_proxy',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])

/**
 * The kind of ssh the host's own command is (`plink`, `tortoiseplink`, `putty`, `simple`), which git
 * reads over its configuration: a network command gets it only with the host's `GIT_SSH_COMMAND`,
 * since it may describe the `GIT_SSH` a command never gets, and git would build plink's arguments
 * around the engine's own OpenSSH (`-P` for a port, no `GIT_PROTOCOL`). A host naming its ssh in
 * `core.sshCommand` names its kind in `ssh.variant`.
 */
const SSH_VARIANT = 'GIT_SSH_VARIANT'

/**
 * What a command reaching the host's secret stores also gets, where the engine has it (spec §20.2,
 * §20.3): a keyring's CLI (`security`, `secret-tool`), or a key's command (a password manager's CLI).
 * The desktop session the keyring answers on: its D-Bus session bus, which the Secret Service is
 * reached over where no systemd user bus sits at `$XDG_RUNTIME_DIR/bus`, and its display, which a
 * keyring that asks its user to unlock it shows its prompt on. The password managers' sessions and
 * stores: 1Password's service account, Connect server and account (its signed-in sessions are
 * `OP_SESSION_<account>`), Bitwarden's session, pass's store and GnuPG's home. Only these commands
 * get them, never an agent's, a check's or git's.
 */
const SECRET_STORES: ReadonlySet<string> = new Set([
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'OP_CONNECT_HOST',
  'OP_CONNECT_TOKEN',
  'OP_ACCOUNT',
  'BW_SESSION',
  'PASSWORD_STORE_DIR',
  'GNUPGHOME',
])

/**
 * What a command driving a container runtime also gets, where the engine has it (spec §12.7): how the
 * `docker` or `podman` CLI finds its daemon or machine, which a rootless host's shell profile often
 * names. Only these commands get them, never an agent's, a check's or git's.
 */
const CONTAINER_RUNTIME: ReadonlySet<string> = new Set([
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
  'CONTAINER_SSHKEY',
])

/** 1Password's signed-in sessions, one per account: `OP_SESSION_<account>`. */
const OP_SESSION = /^OP_SESSION_\w+$/

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

const allowed = (
  name: string,
  {
    network,
    secrets,
    containerRuntime,
  }: {
    readonly network: boolean
    readonly secrets: boolean
    readonly containerRuntime: boolean
  },
  host: Readonly<Record<string, string | undefined>>,
): boolean =>
  ALLOWED.has(name) ||
  LOCALE.test(name) ||
  (network &&
    (NETWORK.has(name) ||
      (name === SSH_VARIANT && host['GIT_SSH_COMMAND'] !== undefined))) ||
  (secrets && (SECRET_STORES.has(name) || OP_SESSION.test(name))) ||
  (containerRuntime && CONTAINER_RUNTIME.has(name))

/**
 * A command's environment: the allowlisted variables of `host` (the engine's environment, read once
 * where the engine starts), with those a `network` command, a `secrets` command and a
 * `containerRuntime` command get, then the caller's `extra` over them, less git's local variables.
 */
export const commandEnvironment = ({
  host,
  extra,
  network = false,
  secrets = false,
  containerRuntime = false,
}: {
  readonly host: Readonly<Record<string, string | undefined>>
  readonly extra: Readonly<Record<string, string>>
  /** Whether the command reaches a remote: git's clone, fetch and push. */
  readonly network?: boolean
  /** Whether the command reaches the host's secret stores: a keyring CLI, a key's command. */
  readonly secrets?: boolean
  /** Whether the command drives a container runtime: its `docker` or `podman` CLI. */
  readonly containerRuntime?: boolean
}): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(host)) {
    if (
      value !== undefined &&
      allowed(name, { network, secrets, containerRuntime }, host)
    )
      environment[name] = value
  }
  for (const [name, value] of Object.entries(extra)) environment[name] = value
  for (const name of GIT_LOCAL_VARIABLES) delete environment[name]
  return environment
}

/**
 * The variables carrying a command's share of the machine's cores (spec §7.3, H56): `FABRICA_CORES`,
 * and `GOFLAGS=-p=<n>` for Go, whose `go` reads that variable alone and takes `-p` only in its `=`
 * form there. `cores` is the share, at least 1, as the scheduler divides the cores.
 */
export const coreShareVariables = (
  cores: number,
): Readonly<Record<string, string>> => ({
  FABRICA_CORES: String(cores),
  GOFLAGS: `-p=${cores}`,
})

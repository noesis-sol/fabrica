- `fabrica engine add <name> --ssh <destination>|--wsl <distro>|--tls <host:port> [--fingerprint <SHA-256>]`,
  `fabrica engine list` and `fabrica engine remove <name>` keep the CLI's own known engines, usable on a host
  with no app, and `--engine <name>` (`-e`) reaches each as the app does: through the SSH bridge, the WSL2
  bridge, or TLS with its pinned certificate and token, a refusal said in words and not tried again. They are
  in `engines.json` in the user's config folder (`~/Library/Application Support/fabrica/` on macOS,
  `$XDG_CONFIG_HOME/fabrica/` or `~/.config/fabrica/` on Linux), mode 0600, since it holds the pairing tokens;
  no command prints one. Over TLS, `add` shows the fingerprint the engine presents for the user to accept on
  the terminal and takes the token typed unseen or from stdin; a script gives `--fingerprint`, as nobody can
  accept it off a terminal. `local` and `ssh://[user@]host[:port]` still work as `--engine` values, and can't be
  a known engine's name.
- Each change to `engines.json` holds `engines.lock` beside it from its read to its write, so `fabrica engine add`
  and `remove` run side by side lose nothing; a stdin of more than one word isn't taken for a pairing token.

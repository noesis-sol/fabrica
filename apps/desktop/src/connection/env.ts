// The user's environment as the commands the app runs for them take it (ssh, wsl.exe, the install's
// shell on this machine): Node's `process.env`, less its unset variables.

/** `env` less its unset variables. */
export const definedOf = (
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  )

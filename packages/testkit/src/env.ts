// A test's environment, built from nothing (spec §24): the PATH and home folder it is given, a fixed
// locale and zone, and the variables it names. Nothing is inherited from the process running the
// tests, so no terminal variable (`TERM`, `COLORTERM`, `NO_COLOR`, `COLUMNS`, …) reaches a command a
// test runs, and no test passes on one machine for a variable another lacks (orchestra-nqbn, -163s).

export interface AirtightEnvOptions {
  /** The PATH: a toolbox's folder (`toolbox.ts`). */
  readonly path: string
  /** The home folder: a temp folder of the test's. */
  readonly home: string
  /** Every other variable the test's commands are to see. */
  readonly vars?: Readonly<Record<string, string>>
}

/** An environment holding only the PATH, the home folder, a fixed locale and zone, and `vars`. */
export const airtightEnv = (
  options: AirtightEnvOptions,
): Readonly<Record<string, string>> => ({
  PATH: options.path,
  HOME: options.home,
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  ...options.vars,
})

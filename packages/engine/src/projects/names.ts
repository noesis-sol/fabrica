import { ProjectId, ProjectSource } from '@fabrica/contracts'

// What a project is called (spec §10.1): its name where the client gives none, its ID, and the prefix
// its work graph draws ticket IDs with. Its name is its checkout's folder, or the repository a URL
// names; its ID is the name in lower case, letters, digits and dashes, made unique among the engine's
// projects with a number; its prefix the first three letters and digits of its name, as `fab` is
// Fabrica's.

/** The last part of a path or URL: `app` for `/src/app/`, `git@host:team/app.git`, `https://host/app.git`. */
const lastPart = (text: string): string => {
  const parts = text.split(/[/:\\]/u).filter(part => part !== '')
  return (parts.at(-1) ?? '').replace(/\.git$/u, '')
}

/** The name a project from `source` takes where none is given. */
export const nameOf = (source: ProjectSource): string => {
  const name = lastPart(
    ProjectSource.match(source, {
      path: ({ path }) => path,
      url: ({ url }) => url,
    }),
  )
  return name === '' ? 'project' : name
}

/** The name as an ID's text: lower case, a dash for every run of anything but letters and digits. */
const slug = (name: string): string => {
  const text = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return text === '' ? 'project' : text
}

/** The ID a project named `name` takes: its slug, or the slug and a number where `taken` has it. */
export const projectIdFor = (
  name: string,
  taken: ReadonlySet<string>,
): ProjectId => {
  const base = slug(name)
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return ProjectId.make(id)
}

/** The prefix of the tickets the project's work graph draws: `fab` for `fabrica`, `fa` where there are no letters. */
export const ticketPrefixFor = (name: string): string => {
  const letters = name.toLowerCase().replace(/[^a-z0-9]/gu, '')
  const prefix = letters.replace(/^[0-9]+/u, '').slice(0, 3)
  return prefix === '' ? 'fa' : prefix
}

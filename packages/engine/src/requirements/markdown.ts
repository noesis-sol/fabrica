import { Option } from 'effect'

import { type Requirement, RequirementMeets } from '@fabrica/contracts'

import { projectSettingsPath } from '../settings'

// The README's section on what to install (spec §17): people read the README to set a machine up, the
// engine reads the list, and written apart they drift. So the section is the list as Markdown, printed by
// `fabrica requires --markdown` and kept between its markers by `init`.

/** The line that opens the section in the README. */
export const requirementsSectionStart = '<!-- fabrica:requires -->'

/** The line that closes it. */
export const requirementsSectionEnd = '<!-- /fabrica:requires -->'

const platformNames = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
} as const

/** A command as a code span, its fence longer than any run of backticks in it. */
const codeSpan = (command: string): string => {
  const longest = Math.max(
    0,
    ...[...command.matchAll(/`+/gu)].map(([run]) => run.length),
  )
  const fence = '`'.repeat(longest + 1)
  const pad = command.startsWith('`') || command.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${command}${pad}${fence}`
}

/** An entry's lines: its name, its check, and its install or the step a person takes. */
const entryLines = ({
  name,
  check,
  meets,
  platforms,
}: Requirement): ReadonlyArray<string> => [
  `- **${name}**${Option.match(platforms, {
    onNone: () => '',
    onSome: only =>
      ` (only on ${only.map(platform => platformNames[platform]).join(', ')})`,
  })}`,
  `  - check: ${codeSpan(check)}`,
  RequirementMeets.match(meets, {
    Install: ({ command }) => `  - install: ${codeSpan(command)}`,
    Manual: ({ instruction }) =>
      `  - by hand: ${instruction.trim().split(/\s+/u).join(' ')}`,
  }),
]

/** The README's section for `list`, its markers included. */
export const requirementsMarkdown = (
  list: ReadonlyArray<Requirement>,
): string =>
  [
    requirementsSectionStart,
    `<!-- Generated from "requires" in ${projectSettingsPath}: change the list, then run fabrica requires --markdown. -->`,
    '## What to install',
    '',
    ...(list.length === 0
      ? [
          `Nothing yet: the project's requires list, \`"requires"\` in \`${projectSettingsPath}\`, has no entries.`,
        ]
      : [
          `What this project needs of the machine, from \`"requires"\` in \`${projectSettingsPath}\`. \`fabrica requires\` checks each one and installs what it can.`,
          '',
          ...list.flatMap(entryLines),
        ]),
    requirementsSectionEnd,
  ].join('\n')

// scripts/check-dist-size.ts: checks each engine distribution archive against the size budget (spec §22.5,
// H64), in the release workflow (.github/workflows/release.yml) as the archives are built. It prints each
// archive's size, and exits 1 where one is over the budget, saying by how much.
//
//   node scripts/check-dist-size.ts apps/engine/out/fabrica-*.tar.gz
//
// The budget is the largest archive's size at Fabrica 0.0.0 with DuckDB 1.5.6 (darwin-x64's,
// 99,161,272 bytes; `pnpm --filter @fabrica/engine-app dist all` prints each) plus 20%, rounded up to a
// whole MB, until the maintainer sets the number (§28).
//
// Node runs this file itself, stripping its types.
import { Option, Result } from 'effect'
import { statSync } from 'node:fs'

/** The most an engine distribution archive may weigh, in bytes. */
export const ARCHIVE_BUDGET_BYTES = 119_000_000

/** An archive and its size in bytes. */
export interface Archive {
  readonly path: string
  readonly bytes: number
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

const sized = (archive: Archive) =>
  `${archive.path}: ${megabytes(archive.bytes)} (${archive.bytes.toLocaleString('en-US')} bytes)`

/** What the check says of an archive within the budget. */
export const describeWithin = (archive: Archive, budget: number): string =>
  `${sized(archive)}, within the budget of ${megabytes(budget)}`

/** What the check says of an archive over the budget. */
export const describeOver = (archive: Archive, budget: number): string =>
  `${sized(archive)}, ${megabytes(archive.bytes - budget)} over the budget of ${megabytes(budget)}`

/** The archives, once none is over the budget; or those over it. */
export const checkSizes = ({
  archives,
  budget,
}: {
  readonly archives: ReadonlyArray<Archive>
  readonly budget: number
}): Result.Result<ReadonlyArray<Archive>, ReadonlyArray<Archive>> => {
  const over = archives.filter(archive => archive.bytes > budget)
  return over.length === 0 ? Result.succeed(archives) : Result.fail(over)
}

const usage = 'usage: node scripts/check-dist-size.ts <archive>...\n'

const main = (paths: ReadonlyArray<string>): number => {
  if (paths.length === 0) {
    process.stderr.write(usage)
    return 2
  }
  const archives: Array<Archive> = []
  for (const path of paths) {
    const bytes = Option.liftThrowable(() => statSync(path).size)()
    if (Option.isNone(bytes)) {
      process.stderr.write(`check-dist-size: ${path} isn't there\n`)
      return 1
    }
    archives.push({ path, bytes: bytes.value })
  }
  const budget = ARCHIVE_BUDGET_BYTES
  return Result.match(checkSizes({ archives, budget }), {
    onFailure: over => {
      for (const archive of archives)
        if (!over.includes(archive))
          process.stdout.write(`${describeWithin(archive, budget)}\n`)
      for (const archive of over)
        process.stderr.write(
          `check-dist-size: ${describeOver(archive, budget)}\n`,
        )
      return 1
    },
    onSuccess: within => {
      for (const archive of within)
        process.stdout.write(`${describeWithin(archive, budget)}\n`)
      return 0
    },
  })
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))

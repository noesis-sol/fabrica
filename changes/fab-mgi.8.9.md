- The release checks each engine distribution archive against a size budget (spec §22.5):
  `scripts/check-dist-size.ts`, in the release workflow's build job, prints each archive's size and fails the
  release with the sizes where one is over. The budget is 119 MB, the largest archive at Fabrica 0.0.0 with
  DuckDB 1.5.6 (darwin-x64's, 99.2 MB) plus 20%, until the maintainer sets the number.

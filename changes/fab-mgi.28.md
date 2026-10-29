- `finish` takes `checkOwn: "none"` where the project's `check_own` is `"none"`: the work finishes unchecked,
  and its `Finished` outcome says so (`OwnCheck.Unchecked`, beside `OwnCheck.Passed` with the pass). Where
  `check_own` is a command or isn't set, `"none"` is refused, as is a pass where it is `"none"`.

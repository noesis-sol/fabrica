- The Git service reads the files git merges by union: `Git.unionMerged` gives the files tracked at a
  revision whose `merge` attribute is `union`, from that revision's `.gitattributes` (`check-attr --source`,
  git 2.40 and later; an older git reads the checkout's), for footprints' files apart (spec §13.4).

- The attention column's key guards start afresh whenever the console is shown again, by another screen left,
  an overlay closed or an SSH prompt gone: a key pressed right after ⌘1 or closing the palette no longer answers
  a request that arrived, or whose 500 ms ran out, while the console was covered. A guard passes only while the
  console is shown, so a palette entry answers only a request whose guard passed before the palette opened.

- The Review screen's diff view draws its icons (the gutter's +/−, the folds of unchanged regions) in
  codicon's font, which Monaco's editor.api left out; checked in the packaged app, whose page loads from
  its app.asar, where Monaco's editor worker starts and computes the diff. A test loads the diff view
  from a file, under the app's Content-Security-Policy, in a sandboxed Electron window.

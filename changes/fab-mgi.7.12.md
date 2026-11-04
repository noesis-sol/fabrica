- `fabrica run --spec <file|url>` runs a spec. A spec from outside the repository is committed under `.fabrica/specs/`,
  its commits recording `Spec-Source:`. A URL is fetched with the start checks each run: https only, up to 5 redirects
  over https, within 30 s and 5 MB, with no credentials or cookies; a GitHub file or one-file gist as its raw file, a
  private GitHub file through the host's `gh` login; an HTML answer refused. A failure is a setup problem saying why.
- The breakdown organ, a session with read tools and `file_root`, files the root epic and the environment ticket first
  (solo, priority 0, every other ticket waiting on it), so the run starts on that ticket while it goes on; the rest of
  the tree is its answer, checked whole and refused with every reason. A run carries on by the spec's SHA-256, updating
  the tree for a changed spec. A narrow tree is warned of (`NARROW_TREE`), naming its chain and hubs. A breakdown at the
  usage limit waits, its time limit paused; its cost, turns and session are in its organ record.

# Third-party notices

Fabrica is MIT-licensed (`LICENSE`). Its app and its engine distribution bundle the components below, each
under its own licence (spec §20.5). The app carries this file, and the licence files that must travel with a
component, in its resources' `licenses/` folder, and Electron's and Chromium's where Electron has them; the engine distribution carries Node's `node/LICENSE`, and Pi
with its dependencies as their packages ship them, each with its own licence file, under `lib/pi/`.

## The app

| Component | Version | Licence | Copyright |
|---|---|---|---|
| Electron | 45.1.0 | MIT | Electron contributors; GitHub Inc. |
| Chromium (in Electron) | 156 | BSD-3-Clause and the licences of its parts, in `LICENSES.chromium.html` | The Chromium Authors |
| Node.js (in Electron) | 24 | MIT and the licences of its parts | Node.js contributors |
| Effect (`effect`, `@effect/platform-browser`, `@effect/platform-node-shared`) | 4.0.0 | MIT | Effectful Technologies Inc |
| Foldkit (`foldkit`, `@foldkit/ui`), with its fork of snabbdom 3.6.3 (MIT, Simon Friis Vindum) | 0.169.0 | MIT | Devin Jameson |
| Monaco Editor, and the parts its `ThirdPartyNotices.txt` lists | 0.57.0 | MIT | Microsoft Corporation |
| Cytoscape.js | 3.34.4 | MIT | The Cytoscape Consortium |
| cytoscape-dagre, with dagre | 4.0.1 | MIT | The Cytoscape Consortium; Chris Pettitt |
| electron-updater, with builder-util-runtime 9.7.0 and lazy-val 1.0.5 | 6.8.11 | MIT | Loopline Systems; Vladimir Krivosheev |
| fs-extra 10.1.0, jsonfile 6.2.1 | | MIT | JP Richardson |
| universalify 2.0.1 | | MIT | Ryan Zimmerman |
| graceful-fs 4.2.11, semver 7.7.4 | | ISC | Isaac Z. Schlueter, Ben Noordhuis and contributors |
| sax | 1.6.1 | BlueOak-1.0.0 | Isaac Z. Schlueter |
| js-yaml 4.3.2, debug 4.4.3, ms 2.1.3, supports-color 7.2.0, has-flag 4.0.0, lodash.isequal 4.5.0, lodash.escaperegexp 4.1.2, ws 8.22.0 | | MIT | Vitaly Puzrin; TJ Holowaychuk; Vercel, Inc.; Sindre Sorhus; the JS Foundation and the jQuery Foundation; Einar Otto Stangvik |
| Tailwind CSS (its generated styles) | 4.3.3 | MIT | Tailwind Labs, Inc. |
| Archivo (font, Lichen Bright) | Fontsource 5.3.0 | SIL Open Font License 1.1 | The Archivo Project Authors |
| Inter (font, Classic) | Fontsource 5.3.0 | SIL Open Font License 1.1 | The Inter Project Authors |
| JetBrains Mono (font, Neon Grid) | Fontsource 5.3.0 | SIL Open Font License 1.1 | The JetBrains Mono Project Authors |
| xterm.js (the terminal view) | when bundled | MIT | The xterm.js authors |

## The engine distribution

The macOS and Linux apps embed it, and the Windows app installs it in WSL2 (spec §22.1, §22.2).

| Component | Version | Licence | Copyright |
|---|---|---|---|
| Node.js, and the parts its `LICENSE` lists | 26.13.0 | MIT and the licences of its parts | Node.js contributors |
| Pi (`@earendil-works/pi-coding-agent`), and its dependencies, each under its own licence | 1.4.0 | MIT | Mario Zechner |
| Effect (`effect`, `@effect/platform-node`, `@effect/platform-node-shared`, `@effect/sql-sqlite-node`) | 4.0.0 | MIT | Effectful Technologies Inc |
| TypeBox (in the extension) | 1.3.27 | MIT | Haydn Paterson |
| ws | 8.22.0 | MIT | Einar Otto Stangvik |
| DuckDB (`@duckdb/node-api`, the telemetry query layer, spec §21) | when bundled | MIT | Stichting DuckDB Foundation |

## The licences

### MIT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

### ISC

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING
ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL,
DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION
WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

### Blue Oak Model License 1.0.0

The Blue Oak Model License 1.0.0, <https://blueoakcouncil.org/license/1.0.0>, under which sax is licensed,
gives each contributor's permission to do everything with the software that would otherwise infringe their
copyright or patents, on the condition that everyone who gets a copy of any part of it from you also gets the
text of the licence or a link to it.

### SIL Open Font License 1.1

The three fonts are under the SIL Open Font License, Version 1.1, <https://openfontlicense.org>. Each font's
copyright and the licence's full text are in `packages/ui/src/theme/fonts/OFL-Archivo.txt`,
`OFL-Inter.txt` and `OFL-JetBrains-Mono.txt`, which the app carries in its `licenses/` folder.

### Chromium, Monaco Editor and Foldkit's parts

Electron's licence and Chromium's licences are in `LICENSE.electron.txt` and `LICENSES.chromium.html`,
beside the app's executable (in its resources on macOS). Monaco Editor's parts' licences are in its
`ThirdPartyNotices.txt`, and Foldkit's snabbdom fork's in its `THIRD-PARTY-NOTICES.md`, which the app carries in
its `licenses/` folder.

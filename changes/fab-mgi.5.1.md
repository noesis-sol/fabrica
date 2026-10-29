- The renderer's look comes from the design handoff: `packages/ui/src/theme/themes.css` is the handoff's
  `themes.css`, unchanged, and Tailwind's theme maps onto its variables only (colours `bg`, `side`, `panel`,
  `line`, `fg`, `muted`, `ink`, `c1` to `c5`; radii `card`, `button`, `window`; shadows `glow1`, `glow2`; fonts
  `sans` and `mono`), with Tailwind's own palette, radii and shadows cleared and spacing kept to the handoff's
  steps, named by their pixels (`p-12` is 12px). Lichen Bright applies by default through `data-theme` on the
  root; Archivo, Inter and JetBrains Mono are bundled as WOFF2. Buttons brighten on hover and focus is a 2px
  `--c1` outline at a 2px offset.
- `fabrica/no-colour-literals` refuses hex colours, CSS colour functions and Tailwind's palette classes in the
  renderer's source, and a test finds none in its stylesheets but `themes.css`.
- A contrast test checks each theme's text and status colours, and its ink, against WCAG AA: Lichen Bright and
  Neon Grid pass; Classic's eight failing pairs are held as known (fab-mgi.35).

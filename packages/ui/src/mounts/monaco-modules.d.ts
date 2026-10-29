// The modules monaco.ts loads that Monaco ships no types for, declared here rather than by Vite's
// client types, so a program without them that reaches monaco.ts has them too: the desktop app's
// type checks include this file (apps/desktop/tsconfig.node.json, tsconfig.web.json).

/** Monaco's syntax colours for its basic languages, registered on import; it exports nothing. */
declare module 'monaco-editor/basic-languages/monaco.contribution' {}

/** Monaco's editor worker, as Vite builds a module into a worker of its own. */
declare module 'monaco-editor/editor/editor.worker?worker' {
  const EditorWorker: new (options?: { readonly name?: string }) => Worker
  export default EditorWorker
}

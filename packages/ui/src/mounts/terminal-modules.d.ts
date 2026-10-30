// The modules terminal.ts loads that xterm.js ships no types for, declared here rather than by Vite's
// client types, so a program without them that reaches terminal.ts has them too: the desktop app's
// type checks include this file (apps/desktop/tsconfig.node.json).

/** xterm.js's stylesheet, which Vite adds to the page on import; it exports nothing. */
declare module '@xterm/xterm/css/xterm.css' {}

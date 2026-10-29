# Handoff: Hivemind Console (Electron)

## Overview
A desktop dashboard for supervising several AI coding agents at once. A sidebar lists the coding sessions. The main area shows ticket and system stats, a chat with the orchestrator agent, an activity history, and two ticket columns: one for work in progress and one for tickets that need a human.

The same layout ships in three themes: **Neon Grid**, **Classic** and **Lichen Bright** (the default).

## About the Design Files
The files in this bundle are **design references created in HTML**. They are prototypes showing the intended look, not production code to copy. Recreate them in the target codebase's environment, for example Electron with React, using its established patterns. If no environment exists yet, Electron with React and CSS variables is a good fit. The `.dc.html` files open directly in a browser next to `support.js`.

## Fidelity
**High-fidelity.** Colors, type, spacing and radii are final. Recreate them pixel-accurately. All theme values are in `themes.css`.

## Layout (1280 × 800 reference window)
```
┌ Title bar 38px ──────────────────────────────────────────────────────┐
├ Sidebar 260px ─┬ Main (padding 20px 24px, column, gap 16px) ─────────┤
│ Header         │ Ticket stats row (one compact strip)                 │
│ Session list   │ ┌ Conversation agent (1fr) ──┬ History (320px) ┐ 156px│
│                │ └────────────────────────────┴─────────────────┘      │
│                │ ┌ In progress (1fr) ─────────┬ Needs your attention ┐ │
│ [+ New session]│ │ scrolls                    │ (1fr) scrolls        │ │
└────────────────┴──────────────────────────────────────────────────────┘
```
- The window is a flex column. The body is a grid: `260px minmax(0,1fr)`.
- The ticket columns are a grid, `minmax(0,1fr) minmax(0,1fr)` with a 16px gap. They take the remaining height (`flex:1; min-height:0`), and each column has `overflow:auto`.

## Components

### Title bar
- Height 38px, background `--side`, 1px bottom border in `--line`, padding 0 14px, gap 8px.
- **Window controls:** three 12×12 squares in `--c3`, `--c2` and `--c1`, with the theme radius applied.
- **App name:** "Hivemind", 13px weight 700, 16px left margin.
- **System stats**, right-aligned with a 18px gap, 12px `--mono` in `--muted`. Values are in `--fg`.
  - `MEM`: a 64×6 bar (track `--line`, fill `--c4`), then "11.2/32 GB".
  - `CPU`: a 64×6 bar (fill `--c5`), then "47%".
  - `CORES`: one 5×12 block per core with a 2px gap. Used cores are `--c1` and idle cores are `--line`. Then "6/10".
- **Search field:** 260×24, 1px `--line` border, radius `--rb`. Placeholder "Search tickets and sessions ⌘K" at 12px in `--muted`.

### Sidebar
- Background `--side`, 1px right border in `--line`.
- **Header:** padding 16px 16px 10px. "Coding sessions" at 13px weight 800 on the left, the count "7" at 12px in `--muted` on the right.
- **Session row:** a grid of `22px 1fr auto` with a 10px gap, padding 10px 16px.
  - **Chip:** a 22×22 square in the agent's color, radius `--rb`. It holds a 2-digit index at 11px weight 800 in `--ink`.
  - **Name:** 14px weight 600, truncated with an ellipsis.
  - **Branch:** 12px `--mono` in `--muted`.
  - **Status label** on the right, 12px: Running in `--c1`, Waiting in `--c2`, Idle has no color.
  - **Selected row:** background `--panel` and a 3px left border in `--c1`. Other rows have a transparent left border.
- **New session button**, pinned to the bottom (`margin-top:auto`): container padding 12px 16px with a 1px top border in `--line`.
  - The button is padded 8px 12px, background `--c1`, text "+ New session" at 13px weight 700 in `--ink`.
  - Radius `--rb`, shadow `--glow1`. The label is left-aligned and the hover state is `brightness(1.08)`.

### Ticket stats row
- A flex row that wraps, with a 1px `--line` border, radius `--r` and background `--panel`.
- Each item is padded 10px 18px with a 1px right divider. It shows a value at 20px weight 800 in its stat color, then a label at 12px weight 700 in `--muted`. They sit side by side, aligned on the baseline, with an 8px gap.
- Items:
  - "7 Agents live" in `--c1`
  - "23 Tickets done" in `--c4`
  - "3 Needs you" in `--c2`
  - "1.2M Tokens" in `--c5`

### Conversation agent panel
- Background `--panel`, 1px `--line` border, radius `--r`.
- **Header** (padding 8px 12px, bottom border): an 8×8 square in `--c5`, "Hivemind" at 13px weight 800, "orchestrator" at 12px in `--muted`, and on the right "claude · 14k ctx" at 11px `--mono`.
- **Messages:** a flex column with `justify-content:flex-end` and `overflow:auto`, padding 8px 12px, gap 6px, 12.5px text with line-height 1.35.
  - Each row is a grid of `64px 1fr`. The author is 12px weight 800: "You" in `--c1`, the agent in `--c5`.
- **Composer** (padding 8px 12px, top border): a "›" prompt in `--c1` `--mono` weight 700, a placeholder "Ask the agents or give an instruction…", and a "⏎" key cap on the right.

### History panel (320px)
- Same panel styling as the conversation panel.
- **Header:** "History" on the left, "Today" on the right.
- **Rows:** a grid of `40px 6px 1fr` with an 8px gap, padding 5px 12px, 12px text. Each row has a time in `--mono` `--muted`, a 6×6 dot in the event color, and the text on one truncated line.
- **Event colors:** merged or PR is `--c4`, approval request is `--c2`, failure is `--c3`, session started is `--c1`.

### Column headers
- 14px weight 800 title plus a 12px count, with an 8px bottom padding.
- "In progress" has a 2px bottom border in `--c1`.
- "Needs your attention" has a 2px bottom border in `--c2`, and its count is also in `--c2`.

### In-progress ticket card
- Background `--panel`, 1px `--line` border, radius `--r`, padding 12px 14px, column with an 8px gap.
- **Row 1:** the ID (12px `--mono`, `--muted`) and the title (14px weight 700).
- **Row 2:** a 4px progress bar. The track is `--line` and the fill is the agent's color, with its width set to the percentage.
- **Row 3:** 12px `--muted` text with the agent name (weight 700, in the agent's color), the current step, and the elapsed time on the right.

### Needs-attention ticket card
- Same card as above but with no colored left border.
- **Row 1:** a kind tag (11px weight 800, padding 2px 6px, radius `--rb`, background in the kind's color, text `--ink`), the ID, and "waiting 14m" on the right in `--c2`.
- **Title:** 14px weight 700.
- **Reason:** 13px in `--muted`.
- **Actions:**
  - A primary button: background `--c2`, text `--ink` weight 700, 13px, padding 6px 12px, radius `--rb`, shadow `--glow2`. The label depends on the kind: Approve, Answer or Review.
  - A ghost "Open session" button in `--fg`.
- **Kind colors:** Approval is `--c2`, Question is `--c5`, Review is `--c4`.

## Interactions & Behavior
- Clicking a session selects it, giving it the selected style. It should also filter or highlight that session's tickets.
- "New session" opens a creation flow, which has not been designed yet.
- The primary action on an attention card resolves the request, and the ticket moves back to "In progress". "Open session" focuses the session.
- The composer sends the message to the orchestrator. New messages appear at the bottom, and the list scrolls when it overflows.
- The system stats refresh roughly every second. History appends new events at the top.
- **Hover states:** session rows and cards lighten their background or border slightly. Buttons use a brightness of about 1.08.
- **Focus:** a 2px outline in the theme's `--c1` with a 2px offset.

## State
- `sessions[]`: id, name, branch, status (running, waiting or idle), elapsed time and color index.
- `tickets[]`: id, title, agentId, step, progress, elapsed time, and needsHuman with its kind, reason and waitingSince.
- `stats`: agents live, tickets done today, needs-you count and tokens. These are derived from the data above.
- `system`: memory used and total, CPU %, and per-core busy flags. In Electron these come from the main process (`os`, `process.getSystemMemoryInfo`) over IPC.
- `chat[]` and `history[]`.
- The selected session id and the active theme.

## Design Tokens
See `themes.css` and apply one theme with `data-theme` on the root element.
- **Roles:** `c1` running, `c2` needs attention, `c3` error, `c4` done, `c5` info.
- **Surfaces:** `bg`, `side` and `panel`, with `line` for borders. Text uses `fg` and `muted`, and `ink` is for text on colored fills.
- **Radii:** `r` for cards, `rb` for buttons and chips, `rw` for the window.
- **Shadows:** `glow1` and `glow2` are only non-`none` in Neon Grid.
- **Fonts:**
  - Lichen Bright uses Archivo.
  - Classic uses Inter.
  - Neon Grid uses JetBrains Mono for everything.
  - All three are on Google Fonts.
- **Spacing:** 4, 6, 8, 10, 12, 16, 18, 20 and 24px.

## Assets
There are no images. The UI uses type, color blocks and Unicode glyphs (›, ⏎, ⌘). Use Lucide icons where icons are added later.

## Files
- `Hivemind Console Kits.dc.html`: all three themes side by side. This is the primary reference.
- `Hivemind Console Reference.dc.html`: Lichen Bright alone, with its palette.
- `themes.css`: the theme tokens, ready to use.
- `support.js` and `_ds/…/styles.css`: needed to open the HTML references locally.

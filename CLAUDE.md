# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page browser app (no build step, no server) — open `index.html` directly in a browser. All logic lives in three files: `index.html`, `script.js`, `style.css`.

## Architecture

### Data model
All state is in `boxes`: an array of `{ id, type, content }` objects. `type` is one of `'math' | 'text' | 'h1' | 'h2' | 'h3'`. Math content is raw LaTeX (e.g. `\frac{1}{2}`); text/heading content is plain string.

### Three-panel layout
- **Left panel** — raw LaTeX source textarea (`#latex-source`) with a line-number gutter (`#line-numbers`). Editing here triggers a 300ms-debounced sync to the box list via `parseFromLatex` → `diffAndApply`.
- **Right panel** — visual box list rendered from `boxes`. Each box is either a MathQuill field (math) or a textarea (text/headings). Editing here calls `syncToText()` which serializes `boxes` → `serializeToLatex()` → writes to the textarea.
- **Preview panel** — toggled via Preview button. Renders using MathJax (`typesetPromise`), then `paginatePreview()` splits content into page-sized `div.preview-page` divs. Print/PDF via `window.print()`.

### Sync loop prevention
Three boolean flags prevent feedback loops between the two panels:
- `suppressTextSync` — set while writing to `latexSource.value` programmatically (prevents textarea input handler from firing)
- `suppressBoxSync` — set while `diffAndApply` runs (prevents each MathQuill `edit` handler from calling `syncToText`)
- `suppressHistory` — set during undo/redo restores and clipboard pastes to avoid creating spurious history entries

### Serialization format
```
\[LaTeX content\]          ← math box (display math)
% text line                ← text box (one or more consecutive lines)
\section{heading}          ← H1
\subsection{heading}       ← H2
\subsubsection{heading}    ← H3
```

### Undo history
`history[]` stores `{ latex, focusId }` snapshots. `pushHistory()` is called from `syncToText()` and the latexSource input handler. `restoreSnapshot()` parses the snapshot back into `boxes`, rebuilds the DOM, and calls `updateLineNumbers()` + `updatePreview()`.

### Project persistence
Projects are stored in `localStorage` under key `mathnotepad_projects` (JSON array). The current working draft is auto-saved to `mathnotepad_draft`. `currentProjectId` tracks which project is active. `isDirty` / `markDirty()` drive the `•` dot on the title label.

### Preview pagination
`updatePreview()` first renders everything into a single tall `.preview-page`, then `paginatePreview()` measures each child's `offsetTop` and splits elements across multiple `div.preview-page` divs when they cross a page boundary (11in × 96dpi = 1056px, minus 2in padding = 768px usable). SVG strokes are forced to `stroke="none"` after MathJax renders to prevent PDF artefacts.

### Key functions
| Function | Purpose |
|---|---|
| `serializeToLatex(boxArray)` | `boxes` → LaTeX string |
| `parseFromLatex(src)` | LaTeX string → `boxes` array (always generates new IDs) |
| `diffAndApply(newBoxes)` | Reconcile parsed boxes into DOM, reusing elements by position |
| `rebuildBoxList()` | Full DOM reconcile using existing element map |
| `syncToText()` | Right→Left: serialize boxes, write to textarea, push history, update preview |
| `updatePreview()` | Async: build HTML, run MathJax, paginate, apply zoom |
| `paginatePreview()` | Split one tall page into multiple `div.preview-page` elements |
| `restoreSnapshot(snap)` | Apply a history snapshot (parse + rebuild + sync textarea + update preview) |
| `updateLineNumbers()` | Recount `\n` in textarea, write 1…N to `#line-numbers` |
| `appendBox(type)` | Insert new box after focused box (or at end) |
| `insertBoxAfter(id, type)` | Insert new box after a specific box id |
| `focusBox(id)` | Focus a MathQuill field or `.text-input` textarea by box id |
| `cutBox(id)` / `pasteBox()` | Box-level clipboard (type + content) |
| `setDefaultBoxType(type)` | Set which type Enter key creates; updates toggle button state |

### External libraries (CDN, no npm)
- **jQuery 3.7.1** — required by MathQuill
- **MathQuill 0.10.1-a** — WYSIWYG math editor fields; accessed via `MQ.MathField(span, opts)`
- **MathJax 3 (`tex-svg.js`)** — renders LaTeX in the preview panel; configured for display math `\[...\]` and inline math `\(...\)`

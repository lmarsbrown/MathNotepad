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

### Highlight feature

Boxes can be "highlighted" — this is a user-facing annotation feature (toggled via the **Highlight** toolbar button or the `h` key shortcut) that is distinct from focus/selection. A highlighted box has `box.highlighted = true` on the data object, and optionally `box.filled` and `box.fillColor` for a background fill color shown in the preview.

**Data fields on a highlighted box:**
```js
{ highlighted: true, filled: true, fillColor: '#ffe066' }
```

**Serialization** — a `%@hl` prefix line is prepended before the box's serialized content:
```
%@hl filled #ffe066    ← filled + color flags (optional)
\[LaTeX content\]
```
`pendingHighlight` in `parseFromLatex` captures this and applies it to the next box via `applyPending()`.

**Preview rendering** — highlighted boxes are wrapped in a `<div class="preview-highlight-box">` with an inline background style driven by `fillColor`.

**Box editor rendering** — highlighted boxes get the CSS class `box-is-highlighted` (dark yellow background `#2a2600`, border `#6b5900`) so they are visually distinct in the right panel. This class is set in `createBoxElement` and synced in `diffAndApply`; the two toggle sites (button click and `h` key) also update the class directly on the DOM element for immediate feedback without waiting for a debounce cycle.

**Preview-click blink** — when a box is scrolled-to via a preview click, it flashes with a green animation (`box-blink-green` / `.box.box-highlight-blink`). This is unrelated to the highlight feature; do not confuse the two.

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

### Graph boxes

Graph boxes are a special `type: 'graph'` variant. Their structure differs from other boxes:

```js
{
  id, type: 'graph', content: '',
  width: 600, height: 400,
  lightTheme: false,
  expressions: [
    { id: 'ge1', latex: 'x^{2}+y^{2}=1', color: '#3b82f6', enabled: true, thickness: 2.0 },
    ...
  ]
}
```

**Serialization format** (in the LaTeX source textarea):
```
\begin{graph}{600}{400}{light}     ← {light} suffix is optional, omit for dark
x^{2}+y^{2}=1|#3b82f6|2|1         ← latex|color|thickness|enabled(0/1)
\end{graph}
```
Parsing happens in `parseFromLatex` via the `\begin{graph}` / `\end{graph}` block handler.

**Graph mode** — clicking a graph box in the right panel opens the graph editor, which replaces the preview panel. `graphModeBoxId` holds the active box id (or `null`). Key graph-mode flow:
1. `openGraphEditor(boxId)` — builds the expression editor UI into `#preview-content`, sets `graphModeBoxId`, calls `scheduleGraphRender()`.
2. Any expression edit → `commitGraphEditorToBox(graphModeBoxId)` reads DOM state back into `boxes[idx].expressions`, then calls `syncToText()`.
3. `scheduleGraphRender()` → `renderGraphPreview()` — compiles all expressions via `compileLatexToGlsl`, calls `graphRenderer.render(exprs, w, h, lightTheme)`.
4. `closeGraphEditor()` — clears `graphModeBoxId`, restores preview panel, calls `updatePreview()`.

**Key graph functions in script.js:**
| Function | Purpose |
|---|---|
| `openGraphEditor(boxId)` | Enter graph edit mode for a box |
| `closeGraphEditor()` | Exit graph mode, restore preview |
| `commitGraphEditorToBox(boxId)` | DOM → `boxes[idx].expressions` → `syncToText()` |
| `renderGraphPreview()` | Compile + render active graph box |
| `scheduleGraphRender()` | rAF-debounced `renderGraphPreview()` |
| `createGraphExprRow(expr)` | Build one expression row DOM element |
| `addGraphExpression()` | Append a new expression row |
| `makeGraphBox(id)` | Create a default graph box object |
| `nextGraphColor()` | Cycle through `GRAPH_COLORS` palette |

**Color palette** — `GRAPH_COLORS` in `script.js` is a 7-color array of medium-saturation hex colors chosen to be readable on both light and dark backgrounds (Tailwind 500 level: `#3b82f6`, `#22c55e`, `#f97316`, `#ef4444`, `#a855f7`, `#eab308`, `#06b6d4`). New expressions cycle through this list via `nextGraphColor()`. The color stored on each expression is the literal CSS hex used both in the swatch (`<input type="color">`) and passed unchanged to the renderer — **do not transform colors at render time**, as it breaks swatch/render parity.

---

### GraphRenderer (graph.js)

`graph.js` contains two independent pieces: the **LaTeX → GLSL compiler** and the **`GraphRenderer` class**.

**LaTeX → GLSL compiler** (`compileLatexToGlsl(latex)`):
- Entry point: returns `{ glsl }` or `{ error }`.
- Internally: `latexToGlslF` splits on `=` at brace-depth 0, compiles each side via a recursive-descent `Parser`, producing a GLSL float expression `F(x,y)` representing the implicit curve `F=0`.
- Supported: arithmetic, `\frac`, `\sqrt`, trig/log/exp, `\pi`, `\infty`, absolute value `|...|`, Greek letters (passed through as GLSL variable names — only `x` and `y` are meaningful).
- Throws `CompileError` on unknown commands.

**`GraphRenderer` — WebGL2 two-pass implicit curve renderer:**

*Pass 1 (one draw call per expression):* Each expression gets its own fragment shader with `F(x,y)` inlined. A 7×7 subpixel grid samples `F` per pixel to detect sign changes; binary search refines the crossing to subpixel precision. Output is a float texture: `vec4(subpixelOffsetX, subpixelOffsetY, graphId, 1.0)` at crossing pixels, or the previous frame's value otherwise. Multiple expressions share one ping-pong buffer (`GPUImage`) via `img.swapBuffers()`.

*Pass 2 (single draw call):* The thicken shader reads the crossing texture, expands each crossing into a circle of radius `thickness` pixels with smooth anti-aliasing, looks up `u_colors[graphId]`, and composites all curves over the background. Also draws grid and axes using world-space distance fields.

**Theme handling in the renderer:**
- `render(expressions, width, height, lightTheme)` — `lightTheme` is `!!box.lightTheme`.
- Dark mode bg: `#1e1e2e` (rgb `0.118, 0.118, 0.180`). Light mode bg: white.
- Both `u_bgColor` (vec3) and `u_lightTheme` (float 0/1) must be uploaded — the shader uses `u_lightTheme` to select light vs dark grid/axis colors.
- Grid colors are theme-aware in the shader; curve colors are passed as-is from `u_colors`.

**Shader caching:** Each unique GLSL expression string gets its own compiled program, cached in `thinLineShaders: Map<string, {program, uniforms}>`. `clearShaderCache()` deletes all programs. Cache is invalidated in `renderGraphPreview()` when the expression set changes.

**Interaction:** `_setupInteraction()` wires mouse drag (pan) and wheel (zoom) on the canvas. Pan/zoom update `xMin/xMax/yMin/yMax` and call `this._onRender()` (set by `openGraphEditor` to `scheduleGraphRender`). Y range is aspect-corrected at render time from the stored Y center, so only the X range and Y center are truly authoritative.

### External libraries (CDN, no npm)
- **jQuery 3.7.1** — required by MathQuill
- **MathQuill 0.10.1-a** — WYSIWYG math editor fields; accessed via `MQ.MathField(span, opts)`
- **MathJax 3 (`tex-svg.js`)** — renders LaTeX in the preview panel; configured for display math `\[...\]` and inline math `\(...\)`

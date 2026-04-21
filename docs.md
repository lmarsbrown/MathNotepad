# Project Overview

## Motivation
Math Notepad is a browser-based document editor for composing structured mathematical documents. It combines a WYSIWYG math editor (MathQuill), a LaTeX source view, an embedded graphing calculator (WebGL), and inline numeric computation. The output is a paginated document that can be printed or exported as PDF. The target use case is writing math-heavy notes, problem sets, or reference sheets where you want both the editability of a WYSIWYG editor and the precision of LaTeX.

## Subfeature index
- [Three-Panel Layout](#three-panel-layout) — source editor, box editor, preview panel
- [Box System](#box-system) — data model; math, text, heading, page break, graph, calc, image box types
- [Sync & Serialization](#sync--serialization) — bidirectional source ↔ box sync; LaTeX format; loop prevention
- [Source Editor (Left Panel)](#source-editor-left-panel) — raw LaTeX textarea with line numbers and source highlighting
- [Box Editor (Right Panel)](#box-editor-right-panel) — WYSIWYG box list; toolbar; drag/drop; highlight feature
- [Preview Panel](#preview-panel) — paginated MathJax-rendered document view; zoom; print/PDF
- [Graph Box & Editor](#graph-box--editor) — graph edit mode; expression list UI; snap tooltip; color palette
- [WebGL Graph Renderer](#webgl-graph-renderer) — two-pass implicit curve renderer; pan/zoom; shader cache
- [LaTeX/AST Engine](#latexast-engine) — shared parser, evaluator, differentiator, simplifier, GLSL compiler
- [Calc Box](#calc-box) — inline numeric computation chain
- [Image Box](#image-box) — embeds images via URL or file upload; files stored in IndexedDB
- [Undo/Redo History](#undoredo-history) — snapshot-based undo/redo
- [Project Persistence](#project-persistence) — localStorage projects and draft auto-save; ZIP export for image projects
- [Physics Constants](#physics-constants) — built-in SI constants available in calc boxes
- [Units System](#units-system) — symbolic SI unit tracking and simplification in calc boxes

## Behaviour
The app has three panels: a raw LaTeX source editor on the left, a visual box editor in the middle, and a document preview on the right. The two editors stay in sync — edits in either direction propagate to the other. The document is made of "boxes", each representing one content element (equation, text block, heading, graph, or computation). The preview renders the document as letter-sized pages with MathJax typesetting. The app is entirely client-side; all state is in memory and localStorage.

## Implementation
**Files:** `index.html` (HTML structure + CDN scripts), `script.js` (core UI: box system, serialization, state, projects, ~3437 lines), `graph-ui.js` (graph editing mode UI, ~914 lines), `preview.js` (preview panel rendering, ~574 lines), `math.js` (LaTeX parser, AST evaluator, GLSL/JS/LaTeX codegen, calc evaluator, ~2359 lines), `graph.js` (GraphRenderer class only, ~1152 lines), `gpuimage.js` (WebGL framebuffer utility), `gl_utils.js` (WebGL helpers), `style.css` (dark Catppuccin theme).

**Load order:** `gl_util.js` → `gpuimage.js` → `math.js` → `graph.js` → `script.js` → `graph-ui.js` → `preview.js`. The last two load after script.js because they depend on globals defined there; their top-level event bindings run after all scripts have parsed.

**Entry point:** IIFE `init()` at the bottom of `script.js` — restores UI state from localStorage, loads the draft project, initializes event listeners.

**External deps (CDN):** jQuery 3.7.1, MathQuill 0.10.1-a (`MQ.MathField(span, opts)`), MathJax 3 `tex-svg.js`.

---

# Three-Panel Layout

## Motivation
Keeps the raw LaTeX source, WYSIWYG editor, and rendered preview simultaneously visible and synced, so the user can work in whichever view suits the task.

## Subfeature index
- [Source Editor (Left Panel)](#source-editor-left-panel)
- [Box Editor (Right Panel)](#box-editor-right-panel)
- [Preview Panel](#preview-panel)

## Behaviour
- **Left panel** — raw LaTeX source textarea with a line-number gutter. Edits here update the box list after a 300ms debounce.
- **Right panel** — scrollable list of box editors. Edits here serialize back to the textarea immediately (debounced preview update). In graph mode the box list is replaced by the graph expression editor and WebGL canvas.
- **Preview panel** — read-only paginated document. Toggled via the Preview button or `togglePreview()`. Zoom in/out with −/+ buttons.
- **Dividers** — `#divider` and `#divider2` are draggable to resize panel widths. Panel widths are saved to localStorage (`UI_STATE_KEY`) and restored on load.
- **Panel toggles** — Source and Preview can each be independently hidden; when the preview is hidden the divider and panel are `display:none`. In graph mode, Source/Preview toggles are replaced by graph-specific hide buttons.

## Implementation
**DOM:** `#left-panel`, `#divider`, `#right-panel`, `#divider2`, `#preview-panel` are flex children of `#app`. `#box-list` and `#graph-editor-content` are siblings inside `#right-panel`; exactly one is visible at a time.

**Divider drag** — `mousedown` on `#divider` / `#divider2` computes pixel deltas and sets `flex-basis` on adjacent panels. `saveUiState()` (script.js:2688) persists widths.

**ResizeObserver on `#box-list`** — triggers `boxResizers` callbacks so MathQuill fields reflow when panel width changes.

**ResizeObserver on `#preview-content`** — calls `renderGraphPreview()` to re-render graphs at new canvas size.

**Toolbar swap** — `#normal-toolbar` is shown normally; `#graph-toolbar` swaps in during graph edit mode (script.js:2953 `enterGraphMode`).

---

# Box System

## Motivation
Boxes are the atomic unit of the document. Each box maps to one logical content element and one block of serialized LaTeX. The box model lets the app track identity across edits (via stable IDs), render correctly in both editors, and serialize cleanly.

## Subfeature index
- [Math Box](#math-box)
- [Text & Heading Boxes](#text--heading-boxes)
- [Page Break Box](#page-break-box)
- [Graph Box](#graph-box)
- [Calc Box](#calc-box)
- [Image Box](#image-box)

## Behaviour
All document state lives in `boxes: { id, type, content, ... }[]`. `type` is one of `'math' | 'text' | 'h1' | 'h2' | 'h3' | 'pagebreak' | 'graph' | 'calc' | 'image'`. IDs are stable within a session but regenerated on parse. Boxes are created, deleted, reordered, and edited; every change serializes back to the LaTeX source and triggers a debounced preview update.

## Implementation
**State:** `let boxes = []` (script.js:7). IDs generated by `genId()` (script.js:272).

**Creation:** `appendBox(type)` (script.js:1475) inserts after the focused box or at end. `insertBoxAfter(afterId, type)` (script.js:1460) inserts at a specific position.

**Deletion:** `deleteBox(id)` (script.js:1526) removes from `boxes`, removes DOM element, calls `cleanupCalcBox` if needed, then calls `syncToText()`.

**DOM construction:** `createBoxElement(box)` (script.js:619) builds the full DOM for one box including MathQuill field (math), textarea (text/headings), or custom structure (graph/calc). Returns the element.

**Reconciliation:** `diffAndApply(newBoxes)` (script.js:1729) reconciles a freshly-parsed box array with the current DOM, reusing existing elements by position. Calc boxes always fully rebuild.

**Focus:** `focusBox(id)` (script.js:1590), `focusBoxAtEdge(id, edge)` (script.js:1608). `focusedBoxId` tracks the currently focused box.

---

## Math Box

### Motivation
The primary content type — a single display-math LaTeX equation rendered by MathQuill for WYSIWYG editing.

### Subfeature index
None.

### Behaviour
Renders as a MathQuill editable field. Enter key inserts a new box of the default type after it. Arrow keys at the field edge move focus to adjacent boxes. Backspace on empty math box deletes it. The `h` key toggles the highlight state (see [Highlight Feature](#highlight-feature)).

**Matrix notation:** Write `mat(cols;rows)` to render a matrix in the preview. Columns are separated by `,` and rows by `;`. Example: `mat(1,0;0,1)` renders as a 2×2 identity matrix. MathQuill displays the `mat(...)` call as-is; the matrix only renders in the preview (MathJax). This notation also works in text box inline math (`$mat(...)$`).

### Implementation
**Data:** `{ id, type: 'math', content: '<latex string>' }`. Content is raw LaTeX, e.g. `\frac{1}{2}`.

**MathQuill:** `MQ.MathField(span, opts)` created inside `createBoxElement` (script.js:619). Field instance stored in `mqFields` map. `edit` handler calls `syncToText()` (after `suppressBoxSync` check). `enter` handler calls `appendBox(defaultBoxType)`.

**Serialization:** `\[content\]` block. See [Serialization Format](#serialization-format).

**Matrix preprocessing:** `matrixSub(latex)` in `preview.js` (called from `applyBBSubs`) replaces `mat(...)` with `\begin{pmatrix}...\end{pmatrix}` before MathJax renders. Handles both `mat\left(...\right)` (MathQuill output) and `mat(...)` (source editor). Implemented via `matToLatex(inner)` which splits on `;` for rows and `,` for columns. Nested parentheses in entries (e.g. `mat((a),(b))`) are handled via balanced-paren scanning.

---

## Text & Heading Boxes

### Motivation
Plain text and section headings for document structure around equations.

### Subfeature index
None.

### Behaviour
Text boxes use a `<textarea>` (auto-resizing). H1/H2/H3 are single-line text inputs styled as headings. All use plain string content (no LaTeX). In the preview, text renders as a paragraph, H1/H2/H3 as styled headings.

### Implementation
**Data:** `{ id, type: 'text'|'h1'|'h2'|'h3', content: '<string>' }`.

**Serialization:**
```
% text line          ← text box (one or more consecutive % lines)
\section{heading}    ← H1
\subsection{heading} ← H2
\subsubsection{heading} ← H3
```

**DOM:** `<textarea class="text-input">` for text; `<input class="heading-input">` for headings. Both `input` events call `syncToText()`. Text content is HTML-escaped via `processTextContent()` (script.js:2088).

---

## Page Break Box

### Motivation
Explicit page break marker for controlling where pages split in the preview and PDF output.

### Subfeature index
None.

### Behaviour
Renders as a horizontal dashed line in the editor. Forces a page boundary in the preview; `paginatePreview()` always breaks before a `pagebreak` box.

### Implementation
**Data:** `{ id, type: 'pagebreak', content: '' }`.

**Serialization:** `\pagebreak`

**Preview:** `createPreviewElement` emits a `<div class="preview-pagebreak">` which acts as a hard page split signal in `paginatePreview()` (script.js:2339).

---

## Graph Box

### Motivation
Embeds a rendered implicit-curve graph in the document. See [Graph Box & Editor](#graph-box--editor) for the editor UI and [WebGL Graph Renderer](#webgl-graph-renderer) for rendering.

### Subfeature index
- [Graph Box & Editor](#graph-box--editor)

### Behaviour
Appears in the box list as a clickable thumbnail (or placeholder if not yet rendered). Clicking opens graph edit mode. The graph has configurable width/height and light/dark theme. Each expression has a color, thickness, and enabled toggle.

### Implementation
**Data:**
```js
{
  id, type: 'graph', content: '',
  width: 600, height: 400, lightTheme: false,
  expressions: [{ id, latex, color, enabled, thickness }]
}
```
Created by `makeGraphBox(id)` (script.js:274). Color palette: `GRAPH_COLORS` (script.js:60), cycled by `nextGraphColor()` (script.js:62).

**Serialization:**
```
\begin{graph}{600}{400}{light}   ← {light} optional, omit for dark
x^{2}+y^{2}=1|#3b82f6|2|1       ← latex|color|thickness|enabled(0/1)
\end{graph}
```
Parsed in `parseFromLatex` (script.js:407) via `\begin{graph}` block handler.

---

# Sync & Serialization

## Motivation
The left (LaTeX source) and right (box editor) panels must stay in sync. The serialization format is the source of truth — it bridges the two views and is also used for project persistence.

## Subfeature index
- [Serialization Format](#serialization-format)
- [Sync Loop Prevention](#sync-loop-prevention)

## Behaviour
Edits in the right panel immediately serialize to the textarea (with a debounced preview update). Edits in the left panel debounce 300ms, then parse and diff-apply to the box list. The two directions share the same serialization format, so round-tripping is lossless.

## Implementation
**Right → Left:** `syncToText()` (script.js:1684) — calls `serializeToLatex(boxes)`, writes to `latexSource.value`, pushes history, schedules preview update. Called by every MathQuill `edit` and textarea `input` handler.

**Left → Right:** `latexSource` `input` event handler (debounced 300ms) — calls `parseFromLatex(src)` then `diffAndApply(newBoxes)`.

**Key functions:**
| Function | Location | Purpose |
|---|---|---|
| `serializeToLatex(boxArray)` | script.js:373 | boxes → LaTeX string |
| `parseFromLatex(src)` | script.js:407 | LaTeX string → boxes array |
| `collectMathBlock(lines, start)` | script.js:580 | parse a `\[...\]` block |
| `syncToText()` | script.js:1684 | right→left sync |
| `diffAndApply(newBoxes)` | script.js:1729 | reconcile parsed boxes into DOM |

---

## Serialization Format

### Motivation
A human-readable LaTeX-compatible text format that can round-trip through the editor without loss.

### Subfeature index
None.

### Behaviour
Each box type has a fixed textual representation. Multiple text lines are collapsed into one text box. Block types (`graph`, `calc`) use `\begin{...}` / `\end{...}` delimiters.

### Implementation
```
\[LaTeX content\]              ← math box (display math)
% text line                    ← text box (one or more consecutive % lines)
\section{heading}              ← H1
\subsection{heading}           ← H2
\subsubsection{heading}        ← H3
\pagebreak                     ← page break

\begin{graph}{W}{H}{light}     ← graph box ({light} optional)
latex|color|thickness|enabled
\end{graph}

\begin{calc}{showresults}      ← calc box ({showresults} present when on)
% id on|off latex
\end{calc}
```

**Highlight prefix** — prepended before any box's content:
```
%@hl filled #ffe066    ← optional fill color flags
\[LaTeX content\]
```
`pendingHighlight` in `parseFromLatex` captures this prefix and applies it to the next parsed box via `applyPending()`.

---

## Sync Loop Prevention

### Motivation
Without guards, a right→left write would trigger the textarea input handler, which would parse and re-apply boxes, causing MathQuill fields to lose cursor position and recreate unnecessarily.

### Subfeature index
None.

### Behaviour
Three boolean flags prevent feedback loops. They are set immediately before a programmatic write and cleared immediately after (or in a `finally` block).

### Implementation
```js
let suppressTextSync = false;  // set while writing latexSource.value programmatically
let suppressBoxSync  = false;  // set while diffAndApply runs (prevents MQ edit → syncToText)
let suppressHistory  = false;  // set during undo/redo and clipboard paste
```
All three are in script.js:11–13.

---

# Source Editor (Left Panel)

## Motivation
Provides a raw LaTeX view for power users who prefer direct text editing and for debugging the serialized state.

## Subfeature index
None.

## Behaviour
- A monospace `<textarea id="latex-source">` with a line-number gutter (`#line-numbers`).
- As the cursor moves in the textarea, the corresponding box in the right panel is highlighted with a blue outline, and the source lines for that box get a yellow background highlight.
- Conversely, clicking a box in the right panel scrolls and highlights the corresponding lines in the source.
- Edits are debounced 300ms before syncing to boxes.

## Implementation
**DOM:** `#latex-wrapper` contains `#line-numbers` and `#latex-source-container` (which holds `#source-line-highlight` overlay + `#latex-source` textarea).

**Line numbers:** `updateLineNumbers()` (script.js:1861) — counts `\n` in the textarea value, writes `1…N` to `#line-numbers`.

**Source highlight:** `updateSourceHighlight(start, end)` (script.js:1904) sets the `.source-hl` overlay height/top to cover the active line range. `highlightSourceForBox(boxId)` (script.js:1918) calls `computeBoxLineRanges` then `updateSourceHighlight`.

**Box→Source link:** `computeBoxLineRanges(boxArray)` (script.js:1888) maps each box id to its start/end line numbers in the serialized source.

**Source→Box link:** `onSourceCursorChange()` (script.js:1927) is debounced on `keyup`/`click` — finds which box owns the cursor's line and calls `highlightSourceForBox`.

---

# Box Editor (Right Panel)

## Motivation
The primary WYSIWYG editing surface. Users interact with boxes as visual units rather than raw LaTeX.

## Subfeature index
- [Toolbar](#toolbar)
- [Box Drag & Drop](#box-drag--drop)
- [Highlight Feature](#highlight-feature)

## Behaviour
- `#box-list` is a scrollable flex column of box elements.
- Clicking a box focuses it (blue border). The focused box determines where new boxes are inserted and which toolbar actions apply.
- Each box has a drag handle (shown on hover) and a delete button (×, shown on hover).
- Font size (A−/A+) applies to all MathQuill fields and text areas globally.
- Keyboard: `Enter` in a math box creates a new box of the default type; arrow keys at field edges move between boxes.

## Implementation
**DOM:** `#box-list` inside `#right-panel`. Boxes are `.box` divs with `.box-type-label` badge, content area, `.box-drag-handle`, `.delete-btn`.

**Focus tracking:** `setFocused(id, el)` / `clearFocused(id, el)` (script.js:1398/1411) add/remove `.focused` class and update `focusedBoxId`.

**Font size:** Stored in `localStorage` key `'mathnotepad_fontSize'`. `applyFontSize()` (script.js:1972) sets CSS custom property or direct styles on all fields.

**Box clipboard:** `cutBox(id)` (script.js:1986), `pasteBox()` (script.js:2009) — box-level cut/paste storing `{ type, content }`.

---

## Toolbar

### Motivation
Quick access to all box-creation and document-control actions without needing to type in the source panel.

### Subfeature index
None.

### Behaviour
The normal toolbar (`#normal-toolbar`) contains:
- **Default type toggle** (Math/Text) — sets what `Enter` creates
- **Add buttons** — `+ Math`, `+ Text`, `+ H1`, `+ H2`, `+ H3`, `+ Break`, `+ Graph`, `+ Calc`
- **Font size** — A−/A+ with current size label
- **Source / Preview toggles**
- **Highlight** — highlights focused box; shows fill-color swatch when box is highlighted

In graph mode, `#graph-toolbar` replaces it with: `+ Expression`, Hide Source, Hide Preview, Crop checkbox, Done Editing.

### Implementation
DOM IDs: `#normal-toolbar`, `#graph-toolbar` (index.html:59–92). Toggle between them via `display:none` style in `enterGraphMode` / `exitGraphMode`.

`setDefaultBoxType(type)` (script.js:1943) updates `defaultBoxType` and toggles active state on `#default-math-btn` / `#default-text-btn`.

---

## Box Drag & Drop

### Motivation
Allows reordering boxes by dragging without touching the source panel.

### Subfeature index
None.

### Behaviour
Boxes are draggable via the `.box-drag-handle` (6-dot grip). Dragging over another box highlights it with `.drag-over`. Dropping inserts the dragged box before or after the target depending on cursor position.

### Implementation
`dragSrcBoxId` (script.js:17) tracks the source. `dragstart`, `dragover`, `drop` listeners are set up inside `createBoxElement` (script.js:619). On drop, the `boxes` array is spliced, then `rebuildBoxList()` (script.js:1554) and `syncToText()` are called.

---

## Highlight Feature

### Motivation
A user-facing annotation tool for marking important boxes (e.g. key results, definitions) with a visual background, distinct from the editor focus/selection state.

### Subfeature index
None.

### Behaviour
The **Highlight** toolbar button (or `h` key) toggles `box.highlighted`. When highlighted, the box shows a dark yellow background in the editor and a black-bordered div in the preview. A fill color swatch button appears next to the Highlight button, offering 5 preset colors plus a custom color picker — this sets `box.fillColor` (shown as a tinted background in the preview). Highlighting and fill color are independent: a box can be highlighted without a fill color, or with one.

### Implementation
**Data fields:**
```js
{ highlighted: true, filled: true, fillColor: '#ffe066' }
```

**Serialization prefix** (prepended before the box's normal content):
```
%@hl filled #ffe066
```
Parsed in `parseFromLatex` (script.js:407); `pendingHighlight` captures the prefix and `applyPending()` applies it to the next box.

**Editor CSS:** `.box-is-highlighted` class — dark yellow background `#2a2600`, border `#6b5900`. Set in `createBoxElement` and synced in `diffAndApply`; also toggled directly on the DOM element by the button/key handler for immediate feedback.

**Preview:** highlighted boxes wrapped in `<div class="preview-highlight-box">` with inline background style from `fillColor`.

**Fill color popup:** `openFillColorPopup(anchorEl, boxId)` (script.js:3553) — shows 5 preset swatches + custom `<input type="color">`. `closeFillColorPopup()` (script.js:3542).

**Toolbar sync:** `updateHighlightToolbar()` (script.js:1419) — enables/disables Highlight button and shows/hides fill swatch based on `focusedBoxId`.

**Preview blink** — when clicking a box in the preview panel, the corresponding editor box flashes green (`box-blink-green`). This is unrelated to highlighting; do not confuse them.

---

# Preview Panel

## Motivation
Shows the document as it will look when printed — paginated, typeset with MathJax, with proper math rendering and embedded graph images.

## Subfeature index
- [Preview Pagination](#preview-pagination)

## Behaviour
- Renders all boxes into a scrollable column of `div.preview-page` elements (8.5×11in letter pages).
- Updates with a 400ms debounce after any box edit.
- Zoom in/out (50%–200%) via −/+ buttons; current zoom displayed as a percentage.
- Download PDF opens `window.print()` with print styles that hide the UI and show only the pages.
- Clicking a preview element scrolls the editor to that box and flashes it green.
- Double-clicking a preview math element focuses and scrolls to the source box.

## Implementation
**DOM:** `#preview-content` inside `#preview-panel`. Contains one or more `div.preview-page`.

**Render pipeline:**
1. `schedulePreview(delay)` (preview.js) — debounced trigger.
2. `updatePreview()` (preview.js) — async; calls `createPreviewElement(box)` for each box, inserts into a single page, runs `MathJax.typesetPromise()`, then `paginatePreview()`.
3. `createPreviewElement(box)` (preview.js) — builds preview DOM per box type; result is cached in `previewBoxCache` by box id + content hash. Graph boxes render as `<canvas>` via `graphRenderer`.

**Zoom:** `applyPreviewZoom()` (preview.js) sets `transform: scale(...)` on `.preview-page` elements. `stepPreviewZoom(delta)` (preview.js) steps through `ZOOM_STEPS` array.

**Scroll sync:** `scrollAndHighlightPreview(boxId)` (preview.js) scrolls preview to a box's element. `scrollAndHighlightBox(boxId)` (preview.js) scrolls editor to a box.

**Print/PDF:** `@media print` in style.css hides all panels except the pages. SVG strokes set to `stroke="none"` post-MathJax to prevent PDF artefacts.

---

## Preview Pagination

### Motivation
The preview renders a multi-page document. Pagination must handle MathJax-rendered elements (which have dynamic heights) and split content correctly at page boundaries.

### Subfeature index
None.

### Behaviour
After MathJax typesetting, all content sits in a single tall page. Pagination then measures each element's `offsetTop` and moves elements to a new page when they would cross the page boundary. Page break boxes always force a new page. Text boxes that overflow a page are split at `<br>` tags.

### Implementation
**`paginatePreview()`** (preview.js) — iterates children of the first `.preview-page`, measuring `offsetTop`. Page height: 11in × 96dpi = 1056px, minus 2in padding top/bottom = 768px usable. Creates additional `div.preview-page` elements as needed.

**`splitTextAtBr(el, maxHeight, ruler)`** (preview.js) — splits a text element at `<br>` tags into two parts when it overflows. Uses a hidden `ruler` element to measure partial heights.

---

# Graph Box & Editor

## Motivation
The graphing calculator lets users embed mathematical graphs in their documents. It supports implicit curves, parametric-style equations, user-defined functions, and multiple overlapping expressions — all rendered in real time on the GPU.

## Subfeature index
- [Graph Expression Editor](#graph-expression-editor)
- [WebGL Graph Renderer](#webgl-graph-renderer)

## Behaviour
Clicking a graph box in the right panel enters graph edit mode:
- The box list is hidden; `#graph-editor-content` shows instead.
- The preview panel shows the WebGL canvas.
- The toolbar swaps to `#graph-toolbar`.
- Users can add/edit/delete expressions, each with a color swatch, enable toggle, thickness (implicitly), and error badge.
- Width and height inputs control the output graph dimensions.
- A crop rectangle can be enabled to define a sub-region for export.
- A snap tooltip shows `(x, y)` coordinates when hovering near a curve.
- "Done Editing" returns to normal mode and updates the preview.

## Implementation
**Entry/exit:**
- `enterGraphMode(boxId)` (graph-ui.js) — hides box list, builds expression list, sets `graphModeBoxId`, calls `scheduleGraphRender()`.
- `exitGraphMode()` (graph-ui.js) — calls `_teardownGraphModeUI()`, restores box list and preview.
- `_teardownGraphModeUI()` (graph-ui.js) — destroys MathQuill fields, clears maps.

**Expression list:**
- `renderGraphExprList(box)` (graph-ui.js) — builds the expression list DOM from `box.expressions`.
- `createGraphExprRow(expr)` (graph-ui.js) — builds one row with MathQuill field, color swatch, enable pill toggle, error badge.
- `addGraphExpression()` (graph-ui.js), `addGraphExpressionAfter(afterId)` (graph-ui.js) — append/insert expressions.
- `deleteGraphExpr(exprId)` (graph-ui.js) — remove expression row.
- `commitGraphEditorToBox(boxId)` (graph-ui.js) — reads DOM state into `boxes[idx].expressions`, then calls `syncToText()`.

**Color picker:** `openColorPopup(anchorEl, exprId)` (graph-ui.js), `closeColorPopup()` (graph-ui.js) — fixed popup with preset palette + `<input type="color">`.

**Render trigger:**
- `scheduleGraphRender()` (script.js) — rAF-debounced.
- `renderGraphPreview()` (script.js) — compiles expressions via `compileGraphExpressions` (math.js), calls `graphRenderer.render(...)`.
- `updateGraphExprErrors(errors)` (script.js) — updates error badges on rows.

**Crop:** `showGraphCropRect` (script.js) toggled by checkbox. `getGraphCropInfo(box)` (script.js), `updateGraphCropOverlay()` (script.js) manage the dashed overlay.

**Snap tooltip:** `graphRenderer._onSnapUpdate` callback wired in `enterGraphMode` to update `#graph-snap-tooltip` with formatted `(x, y)`.

**GraphRenderer singleton:** `getGraphRenderer()` (script.js) lazily creates one instance shared across all graph boxes.

---

## Graph Expression Editor

### Motivation
Per-expression editing within a graph box — input, color, enable/disable, thickness, and error feedback.

### Subfeature index
None.

### Behaviour
Each expression row has:
- A pill toggle (enabled/disabled)
- A MathQuill input field
- A color swatch button (opens color picker popup)
- An error badge (shown when the expression fails to compile)

Arrow keys / Tab navigate between expression rows. Enter in a row inserts a new row after it. Backspace on empty row deletes it.

### Implementation
Built by `createGraphExprRow(expr)` (graph-ui.js). MathQuill fields stored in `graphMqFields` map. `edit` handler debounces via `graphCommitTimer` then calls `commitGraphEditorToBox` + `scheduleGraphRender()`. `focusGraphExpr(idx, edge)` (graph-ui.js) focuses a row by index.

**Color palette:** `GRAPH_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#eab308', '#06b6d4']` (script.js). New expressions cycle via `nextGraphColor()`. Colors are stored as literal CSS hex and passed unchanged to the renderer — do not transform at render time.

---

# WebGL Graph Renderer

## Motivation
Renders mathematical implicit curves in real time on the GPU, supporting multiple overlapping curves with anti-aliasing, pan/zoom interaction, and snap-to-curve.

## Subfeature index
- [GPUImage (Ping-Pong Framebuffer)](#gpuimage-ping-pong-framebuffer)
- [gl_utils (WebGL Utilities)](#gl_utils-webgl-utilities)

## Behaviour
The renderer uses a two-pass approach:
1. **Pass 1 (thin lines):** One draw call per expression. A fragment shader with the implicit function `F(x,y)` inlined detects sign changes via a 7×7 subpixel grid and binary search. Output is a float texture recording crossing positions and curve IDs.
2. **Pass 2 (thicken):** A single draw call reads the crossing texture, expands each crossing into a circle of radius `thickness` pixels with smooth anti-aliasing, looks up the curve's color, and composites over the background with grid and axes.

Pan and zoom via mouse drag and scroll wheel. Snap-to-curve follows the cursor along a focused curve showing `(x, y)` in real time.

## Implementation
**Class:** `GraphRenderer` (graph.js). Singleton created by `getGraphRenderer()` (script.js).

**Render entry:** `render(width, height, lightTheme, focusedExprId)` — resizes canvas/buffers if needed, computes aspect-corrected world bounds (X range authoritative, Y derived from aspect), then executes both passes.

**Shader caching:** `_getThinLineProgram(shaderKey, shaderArg)` — async compilation; cached in `thinLineShaders: Map<string, {program, uniforms}>`. `clearShaderCache()` flushes all programs.

**Theme:**
- Dark bg: `#1e1e2e` (rgb 0.118, 0.118, 0.180); Light bg: white.
- Both `u_bgColor` (vec3) and `u_lightTheme` (float 0/1) uploaded on each render.

**Interaction:** `_setupInteraction()` — drag pan (threshold 3px), wheel zoom (centered on mouse). Y range aspect-corrected. `pickAt(cx, cy, radius)` reads pixel buffer to identify curve under cursor.

**Snap:** `_updateSnap(cx, cy)` finds nearest curve point via grid sign-change search + bisect refinement. `_snapF` persists the last curve's JS evaluator for refinement. `_onSnapUpdate(point, cx, cy)` callback fires with the result.

**Expression update:** `updateExpressions(boxExpressions)` — compares incoming expressions to cached; recompiles only changed ones. Cache keyed by expression latex string.

---

## GPUImage (Ping-Pong Framebuffer)

### Motivation
Multi-pass WebGL rendering requires reading from one texture while writing to another. GPUImage manages a double-buffered RGBA32F framebuffer pair.

### Subfeature index
None.

### Behaviour
Two textures + two framebuffers. `swapBuffers()` swaps front/back. After pass 1 for each expression, buffers swap so the next expression reads the accumulated result.

### Implementation
**File:** `gpuimage.js`. **Class:** `GPUImage`.
- `constructor(gl, w, h)` — creates 2 textures + 2 framebuffers
- `swapBuffers()` — swap front/back
- `clear()` — clear both to transparent black
- `resize(w, h)` — recreate at new dimensions
- `destroy()` — free GPU resources

---

## gl_utils (WebGL Utilities)

### Motivation
Reusable WebGL2 boilerplate for shader compilation, texture creation, and fullscreen rendering.

### Subfeature index
None.

### Behaviour
Static utility object (no global state). All functions take a `gl` parameter. Provides async shader compilation to avoid blocking the main thread.

### Implementation
**File:** `gl_utils.js`. **Object:** `GL`.
- `GENERIC_VS` — reusable vertex shader (fullscreen triangle)
- `createShaderProgram(gl, vsCode, fsCode)` — compile & link synchronously
- `beginShaderProgram(gl, vsCode, fsCode)` — begin async compile
- `finalizeShaderProgram(gl, handle)` — complete async compile, link, check errors
- `createTexture(gl, w, h, data)` — RGBA32F, CLAMP_TO_EDGE, NEAREST filtering
- `createFullscreenTriangle(gl, program)` — VAO for 2×2 coverage triangle

---

# LaTeX/AST Engine

## Motivation
A shared math expression pipeline used by both the graphing calculator (to compile expressions to GLSL) and the calc box evaluator (to evaluate expressions numerically). Centralizing it prevents duplication and ensures consistent behavior.

## Subfeature index
- [Expression Classification & Analysis](#expression-classification--analysis)
- [AST Evaluation & Simplification](#ast-evaluation--simplification)
- [GLSL Compiler](#glsl-compiler)

## Behaviour
Takes a MathQuill LaTeX string and produces either a numeric value, a GLSL shader expression, or a JavaScript evaluator function. The pipeline is: **tokenize → parse → AST → classify → analyze → evaluate/compile**.

## Implementation
**File:** `math.js`. Entry point: `parseLatexToAst(latex)` (math.js).

**Tokenizer:** `tokenize(src)` (math.js) — produces token array from LaTeX. Token types defined in `TK` object.

*Multi-letter unit name matching:* The tokenizer greedily matches SI unit names (listed in `SI_ALL_UNIT_NAMES`, sorted longest-first) before falling back to single-letter IDENT tokens. This means `kg` tokenizes as one IDENT `kg`, not `k` × `g`. Any sequence of letters that begins a known unit name and is not directly adjacent to another letter on its left will match. Consequence: `kg`, `mol`, `Pa`, `Hz`, `rad`, etc. are always single variable-name tokens, even outside units mode. Multi-unit sequences without an explicit separator (e.g., `kgm`) are resolved greedily: `kg` matches first, then `m` separately.

**Parser:** `Parser` class (math.js) — recursive descent. Methods: `parseExpr`, `parseSum`, `parseProduct`, `parseUnary`, `parsePower`, `parseAtom`, `parseCallArgs`. Handles: arithmetic, `\frac`, `\sqrt`, trig/log/exp, `\pi`, `\infty`, absolute value `|...|`, Greek letters, subscripts, user function calls.

`\log` is compiled to `div(ln(x), ln(10))` — it does not appear as a `log` AST node. `\sqrt[n]{x}` compiles to `pow(x, div(1, n))`.

**Special AST nodes:**
- `{ type: 'derivative', variable: 'x', arg }` — from `\frac{d}{dx} expr`
- `{ type: 'primecall', name: 'f', order: N, args }` — from `f'(x)`, `f''(x)`, `f^{\prime}(x)`

Both are handled in `evaluateAst`, `evaluateAstSymbolic`, `differentiateAst`, `astToGlsl`, and `astToJsFunction` by calling `differentiateAst` N times.

**AST helpers:**
- `collectVariables(ast)` (math.js) — extract variable names
- `substituteAst(ast, paramMap)` (math.js) — bind params → args; variables not in map are left as-is
- `collectFunctionCalls(ast, funcDefNames)` (math.js) — find calls to user functions (for cycle detection)

**`parseExpression(latex)`** (math.js) — convenience wrapper returning `{ ast, error }`.

---

## Expression Classification & Analysis

### Motivation
Before evaluating or compiling, expressions must be categorized so the system knows how to handle them (e.g., a function definition `f(x) = body` is different from a variable assignment `x = 5` or a bare equation `x^2 + y^2 = 1`).

### Subfeature index
None.

### Behaviour
- **`classifyExpression`** identifies whether an expression is a function definition (`funcdef`), variable definition (`vardef`), or implicit equation.
- **`analyzeExpressions`** resolves dependencies between definitions, detects cycles in function definitions (DFS), determines which definitions depend on x/y, and pre-evaluates constants on the CPU.
- User-defined functions `f(x) = body` are collected into `funcDefs: Map<name, { params, body, exprId }>`.

### Implementation
- `classifyExpression(parsed)` (math.js)
- `analyzeExpressions(classifiedList)` (math.js) — returns `{ funcDefs, allValues, xyDefNames, constantNames, errors }`
- `evaluateConstants(analysis)` (math.js) — pre-compute non-xy-dependent definitions
- `compileGraphExpressions(expressions)` (math.js) — full pipeline: parse → classify → analyze → compile each expression to `{ shaderCode, jsEvaluator }` or `{ error }`

---

## AST Evaluation & Simplification

### Motivation
Numeric evaluation is needed for calc boxes and for pre-computing constants before GPU compilation. Symbolic differentiation supports derivative notation. Simplification reduces expressions for cleaner GLSL output and for symbolic unit algebra.

### Subfeature index
- [Units System](#units-system) — uses `evaluateAstSymbolic` and `simplifyAst` for unit algebra

### Behaviour
- **`evaluateAst`** evaluates an AST to a numeric value given a map of variable values and function definitions. Throws on undefined variables.
- **`evaluateAstSymbolic`** like `evaluateAst` but leaves unit symbols and (optionally) unknown variables as symbolic AST nodes rather than throwing. Returns a simplified AST node (may be a `number` node if fully numeric). Used by the units system.
- **`differentiateAst`** symbolically differentiates an AST with respect to a variable, applying chain rule, product rule, etc.
- **`simplifyAst`** normalizes to canonical sum-of-products form: flattens to `{ coeff, factors }` terms, combines like terms, reconstructs. Falls back to basic constant folding for unsupported structures. Works correctly on mixed numeric-and-variable expressions (unit symbols are treated as opaque atoms). Key correctness property: `pow(mul(a, b), n)` expands to `mul(pow(a,n), pow(b,n))` for single-term bases (crucial for unit exponentiation like `(kg·m)²` → `kg²·m²`). After combining terms, applies `_simplifyTermUnits` to each term: if the term's SI expansion matches a named derived unit, the term is rewritten to use it (e.g., `N·m → J`). Terms with non-unit atoms are skipped. Cross-unit combination (e.g., `5 N + 5 kg·m·s⁻²`) is handled in `_combineTerms` by SI-expanding both terms, combining, and then letting `_simplifyTermUnits` re-match the result.
- **`astToLatex`** converts a simplified AST to a LaTeX string. Used for rendering unit results in the preview. Unit variable names are wrapped in `\text{...}`.

### Implementation
- `evaluateAst(ast, values, funcDefs)` (math.js)
- `evaluateAstSymbolic(ast, valueMap, funcDefs, opts)` (math.js) — `valueMap` maps names to `number | ASTNode`; `opts.useSymbolic` keeps unknown vars symbolic; `opts.warnings` accumulates `{ funcName, units[] }` objects when transcendental functions receive unit arguments
- `differentiateAst(ast, varName, funcDefs)` (math.js)
- `simplifyAst(ast)` (math.js) — calls `_toCanonical`, `_combineTerms`, `_fromCanonical`
- Internal helpers: `_atomKey` (math.js), `_toCanonical` (math.js), `_combineTerms` (math.js), `_fromCanonical` (math.js), `_simplifyAstFallback` (math.js)
- `astToLatex(ast)` (math.js) — AST → LaTeX string; `_latexAtom(ast)` wraps add/sub/mul in parens when used as a `pow` base or `neg` operand (but not when used as a `mul` operand, since multiplication is associative)

---

## GLSL Compiler

### Motivation
Converts mathematical expressions to GLSL fragment shader code so the GPU can evaluate `F(x, y)` at millions of pixels per frame.

### Subfeature index
None.

### Behaviour
Takes an implicit expression (e.g. `x^2 + y^2 - 1`) and produces a GLSL float expression `F(x, y)`. Constants are inlined; x/y-dependent sub-expressions become GLSL variables. The full shader wraps this with the sign-change detection logic.

### Implementation
- `astToGlsl(ast, constantNames, xyDefNames, funcDefs)` (math.js) — recursive AST → GLSL string
- `astToJsFunction(ast, constantValues, funcDefs)` (math.js) — AST → JavaScript `function(x, y)` for snap-to-curve evaluation
- `generateShaderCode(implicitExpr, analysis)` (math.js) — produces complete fragment shader GLSL
- `buildImplicitJsEvaluator(implicitExpr, analysis, funcDefs)` (math.js) — builds JS evaluator for one expression

**Error type:** `CompileError` (math.js) — thrown on unknown LaTeX commands.

---

# Calc Box

## Motivation
Inline numeric computation within the document — a mini spreadsheet-style chain where each expression can reference previous variable definitions, with results shown in real time next to each row.

## Subfeature index
- [Calc Evaluator](#calc-evaluator)
- [Units System](#units-system)

## Behaviour
A calc box contains a list of expression rows. Each row has:
- A pill toggle (enabled/disabled)
- A MathQuill input field
- A result display (right-aligned, monospace)
- A delete button

Expressions are evaluated in dependency order; results update as you type (rAF-debounced). The "Show Results" button in the box toolbar controls whether results appear in the preview. The "Hidden" toggle hides all preview output for the entire box (expressions still evaluate normally in the editor — useful for intermediate computations). A disabled expression is skipped in evaluation but its variable definition is still available to other expressions.

Navigation: Enter in a row adds a new row after it; arrow keys at field edges cross between calc rows; Backspace on empty row deletes it.

## Implementation
**Data:**
```js
{
  id, type: 'calc', content: '',
  showResultsDefs: true,   // show results for assignment rows (x = expr)
  showResultsBare: true,   // show results for bare expression rows
  physicsConstants: false, // inject SI physics constants
  useUnits: false,         // enable SI units mode (symbolic unit tracking)
  useSymbolic: false,      // keep undefined non-unit variables symbolic
  hidden: false,           // suppress all preview output (expressions still evaluate in editor)
  sigFigs: 6,              // significant figures for numeric result display
  expressions: [{ id, latex, enabled }]
}
```
Created by `makeCalcBox(id?)` (script.js:288).

**Module-level state (script.js:50–54):**
```js
let calcExprNextId   = 1;
let calcMqFields     = new Map();      // boxId → Map<exprId, MQField>
let calcUpdateFnsMap = new Map();      // boxId → Map<exprId, (resultMap) => void>
let calcAddExprFns   = new Map();      // boxId → (afterExprId?) => void
let calcPendingUpdate = new Set();     // boxIds with pending rAF update
```

**Key functions:**
| Function | Location | Purpose |
|---|---|---|
| `makeCalcBox(id?)` | script.js:288 | Create default calc box |
| `formatCalcResult(result)` | script.js:304 | `{value}` → `"= 5"` / `"≈ 1.414"`, etc. |
| `classifyCalcExpr(latex)` | script.js:313 | Detect expression kind for display |
| `scheduleCalcUpdate(boxId)` | script.js:328 | rAF-debounced update trigger |
| `updateCalcResults(boxId)` | script.js:337 | Evaluate + fire per-row update fns |
| `commitCalcBox(boxId)` | script.js:346 | DOM → `boxes[idx].expressions` → `syncToText()` |
| `cleanupCalcBox(boxId)` | script.js:365 | Delete all 4 maps for boxId |

**DOM structure** (built in `createBoxElement`, `type === 'calc'` branch, script.js:619):
```
.box.box-calc
  .calc-toolbar
    .box-type-label         "CALC"
    .calc-show-results-btn  "Assignments" toggle
    .calc-show-results-btn  "Bare" toggle
    .calc-show-results-btn  "Physics" toggle
    .calc-show-results-btn  "Units" toggle
    .calc-show-results-btn  "Symbolic" toggle (disabled when Units is off)
    .calc-show-results-btn  "Hidden" toggle
    .calc-sigfigs-label     "sf:" label
      .calc-sigfigs-input   number input (1–15, default 6)
  .calc-expr-list
    .expr-wrapper           (shared with graph editor rows)
      .expr-row
        .expr-toggle        pill button
        .expr-mq            MathQuill field
        .calc-expr-result   result text (plain text or inline HTML for fractions)
        .expr-delete        × button
      .calc-expr-error      error text (hidden unless error)
      .calc-unit-warning    warning text (hidden unless unit mismatch)
  .calc-add-btn             "+ Expression"
  .delete-btn
```

**Inner function `createCalcExprRow`** — closure inside `createBoxElement`. Wires:
- Toggle click → `commitCalcBox` + `scheduleCalcUpdate`
- MQ `edit` → `commitCalcBox` + `scheduleCalcUpdate`
- MQ `enter` → insert new row after current
- MQ `moveOutOf/upOutOf/downOutOf` → navigate within box; at edges, call `focusBoxAtEdge`
- MQ `keydown` Backspace on empty → delete row, focus adjacent

**`diffAndApply` behaviour:** Calc boxes always fully rebuild (cleanupCalcBox + createBoxElement + replaceChild) even when the id matches, so expression list stays in sync with source-panel edits.

**Serialization:**
```
\begin{calc}{showdefs}{showbare}{physics}{units}{symbolic}{sf=3}
% ce1 on x=5
% ce2 off y=x^{2}
\end{calc}
```
Each flag token is only emitted when the corresponding setting is `true` (or non-default for `{sf=N}`, which is omitted when sigFigs is 6). Legacy `{showresults}` (old format) sets both `showResultsDefs` and `showResultsBare`. Each expression line: `% <id> <on|off> <latex>`. Parsed via `\begin{calc}` block handler in `parseFromLatex`.

**Preview rendering** (`createPreviewElement`, `type === 'calc'` branch, script.js:2106):
- Calls `evaluateCalcExpressions` fresh on each render, passing all flags
- Numeric results: `\[latex \text{ = value}\]`
- Unit results (from units mode): `\[latex = <astToLatex output>\]` — note: unit LaTeX is NOT wrapped in `\text{}` since it is itself valid LaTeX
- Disabled expressions skipped

---

## Calc Evaluator

### Motivation
Evaluates a list of math expressions in dependency order, supporting variable definitions, function definitions, equations/inequalities, physics constants, and symbolic unit tracking.

### Subfeature index
- [Units System](#units-system)

### Behaviour
1. Collects ALL variable definitions (enabled + disabled) for dependency resolution.
2. Collects function definitions with DFS cycle detection.
3. Resolves variable definitions iteratively in dependency order (up to `allDefs.size + 1` passes to handle chains).
4. Evaluates each enabled expression:
   - Bare expression → numeric value (or unit AST in units mode)
   - `name = rhs` → value of rhs
   - Equation with non-name lhs → `{ boolValue }` (ε=1e-9 tolerance); if symbolic, shows lhs result
   - Inequality → `{ boolValue }`; if symbolic, shows error
   - Function definition → no result shown
5. Returns `Map<exprId, { value } | { boolValue } | { error } | { unitAst, warnings }>`.

**Variable definition LHS constraint:** The LHS regex only accepts single-letter variable names or Greek letters (with optional subscript). Multi-letter names (including unit names like `kg`) are treated as equations, not definitions — this is intentional to prevent shadowing unit symbols.

### Implementation
- `evaluateCalcExpressions(expressions, opts)` (math.js) — main evaluator
  - `opts.usePhysicsConstants` — inject PHYSICS_CONSTANTS into values map
  - `opts.useUnits` — enable units mode: builds `unitValues` map (physics constants as unit ASTs; derived units remain symbolic atoms), uses `evaluateAstSymbolic` for all evaluation
  - `opts.useSymbolic` — only meaningful with `useUnits`; keeps undefined non-unit variables symbolic rather than throwing
- `findCalcOperatorAtDepth0(s)` (math.js) — finds `=`, `<`, `>`, `\leq`, `\geq`, `\neq` at brace-depth 0; returns `{ idx, len, op }` or `null`
- `findEqAtDepth0(s)` (math.js) — finds `=` only

**Units mode internal data flow:** When `useUnits` is true, a parallel `unitValues: Map<name, number|ASTNode>` is built alongside `allValues`. Derived unit names (N, J, W, etc.) are NOT pre-expanded — they are kept as symbolic atoms by `evaluateAstSymbolic` (which recognizes them via `DERIVED_UNIT_EXPANSIONS`). Physics constants are stored as unit ASTs via `buildConstantUnitAst`. Variable definitions are resolved into `unitValues` using `evaluateAstSymbolic`. The `evalToResult` helper dispatches to either `evaluateAstSymbolic` or `evaluateAst` based on the mode.

Reuses `parseLatexToAst` and `evaluateAst` / `evaluateAstSymbolic` from [LaTeX/AST Engine](#latexast-engine). Physics constants injected from [Physics Constants](#physics-constants). Symbolic units from [Units System](#units-system).

---

# Units System

## Motivation
Extends calc boxes to track physical dimensions symbolically. When enabled, SI unit symbols (m, kg, s, A, K, mol, cd) and derived unit symbols (N, J, Pa, W, Hz, V, C, F, H, T, Wb) are treated as symbolic atoms rather than undefined variables. Derived units are kept as-is unless simplification requires it: `5 N * 2 m` simplifies to `10 J` (N·m matches joules), and `N / m^3` stays `N·m⁻³` rather than expanding to base SI. When combining terms with dimensionally equivalent but differently-expressed units (e.g., `5 N + 5 kg·m·s⁻²`), both are converted to SI base units for combination and then re-matched to a named derived unit if possible. After matching, the best-scaled prefix is selected: `5000 J → 5 kJ`, `3600 s → 1 hr`, `0.005 kg → 5 g`.

## Subfeature index
None.

## Behaviour
**Units toggle (per calc box):** Enables SI units mode. When on, any variable name matching a base, derived, or prefixed SI unit symbol is treated as a symbolic atom, not an undefined variable. Derived and prefixed units are kept symbolic and only resolved to SI base units when needed for combining non-trivially-equivalent terms.

**Symbolic toggle (per calc box):** Only active when Units is on. When on, undefined variables that are *not* unit symbols are also kept symbolic rather than producing an error. Allows writing expressions like `F = m a` where `m` and `a` haven't been defined yet.

**Auto-scaling:** After simplification, results are automatically displayed in the most human-readable scaled unit. `5000 J` → `5 kJ`, `0.001 m^2` → `10 cm^2`, `1e9 Hz` → `1 GHz`. The scale is chosen so the coefficient is in [1, 1000). If no clean scale exists (coefficient outside that range for all prefixes), the result is left as-is.

**Result display:** Unit results are shown in the editor result area using:
- Plain text with Unicode superscripts (`kg·m·s⁻²`) for expressions without division
- CSS inline fraction bars for expressions containing `div` nodes

In the preview, unit results use `astToLatex` output embedded directly in display math (not wrapped in `\text{}`).

**Warnings:** When a transcendental function (`sin`, `cos`, `ln`, etc.) receives an argument that still contains unit variables after simplification, a warning is shown below the expression row: `⚠ sin([kg]) — unit mismatch`. This indicates a dimensional error in the expression.

**Multi-letter unit entry:** Users type unit names normally in the MathQuill field. The tokenizer handles multi-letter unit names: `kg`, `mol`, `Pa`, `Hz`, `kHz`, `km`, `min`, `day`, etc. are each tokenized as a single identifier. Adjacent multi-letter unit names must be separated with `\cdot` or similar; e.g., `kPa \cdot m` works but `kPam` would not. `μ`-prefixed units (μm, μs, μA, μJ, etc.) are handled by a dedicated tokenizer branch matching the longest unit name starting with μ (U+00B5 or U+03BC). The parser also handles `\mu` + letter: if `\mu` is followed by a known unit letter it forms a combined μ-unit atom (e.g. `\mu J` → `μJ`).

**Liter units (chemistry mode only):** `L`, `mL`, `μL` are enabled only when the Physics Chem constants group is active. This prevents `L` from conflicting with common physics variables. When chem mode is on, `1e-3 m^3` auto-scales to `1 L`. When off, volume stays in m³/cm³/mm³.

**`g` (gram) vs `g` (gravity):** When the Classic Mechanics constants group is active, `g = 9.81 m/s²` shadows the gram unit. `mg` and `μg` are unaffected (multi-char atoms never confused with `m*g`).

## Implementation
**Constants in math.js:**
- `SI_BASE_UNITS` — `Set` of 7 base unit symbols: `m`, `s`, `kg`, `A`, `K`, `mol`, `cd`
- `DERIVED_UNIT_EXPANSIONS` — maps 12 derived unit names + liter units (`L`, `mL`, `μL`) to `{ coeff, units: { [base]: exponent } }`. Includes: N, J, W, Pa, Hz, V, C, F, H, T, Wb, rad, L, mL, μL
- `CHEM_ONLY_UNITS` — `Set(['μL', 'mL', 'L'])` — gated behind chemistry mode
- `SCALED_UNIT_ATOMS` — same format as `DERIVED_UNIT_EXPANSIONS`; all prefixed/scaled unit names not already in the base sets. Covers: nm/μm/mm/cm/km (km is max for distance), ns/μs/ms, min/hr/day/yr, μg/mg/g, μA/mA, nJ/μJ/mJ/kJ/MJ/GJ/TJ/PJ, nW/μW/mW/kW/MW/GW/TW, mN/kN/MN, kPa/MPa/GPa, kHz/MHz/GHz/THz, μV/mV/kV/MV, μC/mC, pF/nF/μF/mF, nH/μH/mH, μT/mT, μWb/mWb
- `SCALABLE_UNITS_SERIES` — map from base unit name to `[{name, p}]` sorted ascending by scale factor `p`. Used by `_selectBestScale` to find the best-fit prefix.
- `SI_ALL_UNIT_NAMES` — all unit names (base + derived + scaled) sorted longest-first; used by the tokenizer for greedy matching
- `_activePhysicsChem` — module-level boolean set in `evaluateCalcExpressions`; gates liter unit recognition

**Key functions in math.js:**
- `buildDerivedUnitParamMap()` — converts `DERIVED_UNIT_EXPANSIONS` into a `Map<name, ASTNode>` of base-unit expansion ASTs. Used by `buildConstantUnitAst` but not injected into `unitValues` at eval time (derived units stay symbolic).
- `collectUnitVarsInAst(ast)` — walks AST, returns `Set` of unit variable names (base, derived, and scaled). Used for transcendental-function unit warnings.
- `_termToSISignature(term)` — expands a `{coeff, factors}` term to SI base units, returning `{coeff, siUnits}` or `null`. Handles `DERIVED_UNIT_EXPANSIONS`, `SCALED_UNIT_ATOMS`, and SI base units. Chem-only units (`L`, `mL`, `μL`) return `null` when chem mode is off.
- `_siSignatureKey(siUnits)` — canonical string key from SI units dict; groups terms by dimensional equivalence.
- `_selectBestScale(baseName, power, siCoeff)` — given a base unit name (`J`, `m`, `s`, `kg`, etc.), the power it appears at, and its SI coefficient, returns `{name, power, newCoeff}`. Scans the series from largest to smallest prefix; picks the first where `|newCoeff| ∈ [1, 1000)`. If no prefix fits (coefficient too large or too small for all entries), returns the largest prefix anyway rather than `null`. Special case: `baseName='m', power=3` with chem mode tries liter series first (returning power=1 result for L/mL/μL).
- `_simplifyTermUnits(term, atomMap)` — after combination: (1) tries `matchDerivedUnit` (only `power >= 1` matches accepted, to avoid false Hz⁻¹ matches); (2) falls back to single-SI-base-unit terms; (3) calls `_selectBestScale` to choose best prefix; rewrites the term. For single-factor terms where `_selectBestScale` would be null (unit not in any series), returns the original term unchanged to avoid ugly forced coefficients.
- `evaluateAstSymbolic(ast, valueMap, funcDefs, opts)` — symbolic evaluator; recognises `DERIVED_UNIT_EXPANSIONS` (with chem gating) and `SCALED_UNIT_ATOMS` variable nodes as unit atoms.

**Display helpers in script.js (after `formatCalcResult`, script.js:~310):**
- `toSuperscript(n)` — converts integer to Unicode superscript string (⁻², ³, etc.)
- `_astNumStr(v, sigFigs)` — formats a number as plain text. Integers < 10000 as-is; |v| in [0.001, 10000) via `toPrecision`; |v| < 0.001 as standard scientific notation with Unicode superscripts; |v| ≥ 10000 as engineering notation (exponent is a multiple of 3, mantissa in [1, 1000)).
- `_numToLatex(v, sigFigs)` — same thresholds as `_astNumStr` but returns a LaTeX string (`\times 10^{n}`). Used for preview panel rendering.
- `buildAstText(ast)` — plain-text renderer; returns `null` if the AST contains a `div` node
- `buildAstHtml(ast)` — DOM renderer; handles `div` nodes as `.inline-frac` CSS fractions
- `renderUnitResult(resultSpan, unitAst, warnings)` — uses `buildAstText`/`buildAstHtml` directly on the already-simplified `unitAst`; does not re-process through `matchDerivedUnit`
- `formatUnitWarnings(warnings)` — formats warning array to display string

**preview.js unit result rendering:** Uses `astToLatex(result.unitAst, sigFigs)` directly. Does not call `matchDerivedUnit` on the result — the AST is already fully simplified by `_simplifyTermUnits` before reaching the display layer.

**CSS (style.css):**
- `.calc-unit-warning` — amber warning line below expression row
- `.inline-frac` / `.frac-num` / `.frac-den` — CSS inline fraction (flex column with border-bottom on numerator)
- `.btn-disabled` — dimmed appearance for the Symbolic button when Units is off

**Serialization:** `{units}` and `{symbolic}` flag tokens on the `\begin{calc}` line.

**`rad` (radians):** Treated as dimensionless (`coeff: 1, units: {}`) — evaluates to the number 1 and disappears from unit expressions. This is physically correct but means `sin(x rad)` will evaluate numerically rather than triggering a unit warning.

---

# Image Box

## Motivation
Allows embedding images in a document. Supports two input modes: a direct URL (no storage required) or an uploaded file (stored locally in IndexedDB). File images are bundled into the exported ZIP alongside the `.tex` source.

## Subfeature index
None.

## Behaviour
- The toolbar contains a **URL / File** pill toggle. The toggle locks once an image has been filled in.
- The toolbar also has a **fit cycle button** that cycles: `⇔ Lock → ✂ Crop → ⤢ Scale`. It controls what happens when width and height are changed independently.
- A second **align cycle button** cycles: `⇤ Left → ↔ Center → ⇥ Right`. Controls horizontal alignment of the image within the box (and preview).
- **URL mode:** A text input is always visible. Typing a URL and pressing Enter or blurring displays the image below the input. The toggle locks as soon as a URL is set; clearing the input unlocks it. No X button — just edit or clear the URL input directly.
- **File mode:** A dashed drag-and-drop zone is shown. Clicking also opens the OS file picker. Once a file is uploaded, the image replaces the dropzone and an X button appears at the top-right of the image. Clicking X deletes the IDB record, clears the box, and unlocks the mode toggle.
- If an image box is loaded from a project but its IDB entry is missing (e.g. different device), an error state is shown with an X button to reset the box.
- In the preview panel, URL images render synchronously; file images load asynchronously from IDB (a "Loading image…" placeholder is shown until resolved).
- In the editor, images are always displayed at natural size, capped at 500px wide and constrained to fit the box, preserving aspect ratio. They are horizontally centered. The user-set W/H dimensions have no effect on the editor display — they only affect the preview.
- When an image is loaded, **W and H pixel inputs** appear below the image. Leaving both empty means natural size. The fit mode determines behavior:
  - **Lock**: Editing W auto-computes H from the natural aspect ratio, and vice versa.
  - **Crop**: Both dimensions are independent; image is rendered with `object-fit: cover` (cropped to fill).
  - **Scale**: Both dimensions are independent; image is rendered with `object-fit: fill` (stretched).

## Implementation
**Data model:**
```js
{ id, type: 'image', mode: 'url'|'file', locked: bool, src: string, filename: string, alt: string, width: number, height: number, fit: 'locked'|'crop'|'scale' }
```
- `src`: full URL (URL mode) or IDB key `"${projectId}/${filename}"` (file mode)
- `filename`: original filename in file mode; empty string in URL mode
- `locked`: `true` once an image is set; prevents mode toggle
- `width`/`height`: pixel dimensions; `0` means natural size
- `fit`: `'locked'` (aspect-ratio locked), `'crop'` (object-fit cover), `'scale'` (object-fit fill)
- `align`: `'left'` | `'center'` | `'right'` — horizontal alignment in editor and preview

**Serialization format:**
```
\begin{image}{url}
% https://example.com/photo.png
% size: 400x300
% fit: crop
\end{image}

\begin{image}{file}{locked}
% proj123/photo.jpg
% alt: A diagram
\end{image}
```
- First flag: `{url}` or `{file}`
- Second flag: `{locked}` only when `box.locked === true`
- Body line 1: `% <src>` (URL or IDB key) — omitted if empty
- Body line 2: `% alt: <text>` — only when `box.alt` is non-empty
- Body line (optional): `% size: WxH` — only when width or height is non-zero
- Body line (optional): `% fit: <mode>` — only when fit is not `'locked'` (default)
- Body line (optional): `% align: <left|center|right>` — only when align is not `'left'` (default)

**Key functions (script.js):**
| Function | Purpose |
|---|---|
| `makeImageBox(id)` | Returns default image box object (~line 308) |
| `createImageBoxElement(box, div)` | Builds full box DOM; handles all interactions (~line 823) |
| `cleanupImageBox(boxId)` | Revokes stored blob object URL; does NOT delete IDB record (~line 818) |
| `initImageDb()` | Opens IndexedDB on startup (~line 3208) |
| `idbSaveImage(projectId, filename, mimeType, arrayBuffer)` | Writes image record to IDB |
| `idbLoadImageAsObjectURL(key)` | Reads record, returns a blob object URL |
| `idbGetImageRecord(key)` | Returns full record (used by ZIP export) |
| `idbDeleteImage(key)` | Deletes one record |
| `idbGetAllImagesForProject(projectId)` | Returns all records for a project (used by ZIP export) |
| `idbDeleteAllImagesForProject(projectId)` | Bulk-deletes via `by_project` index (called on project delete) |
| `idbMigrateImageKeys(oldId, newId)` | Re-keys `draft/` records when a new project is first saved |

**IndexedDB schema:** Database `mathnotepad_imagedb` v1, object store `images`:
- Primary key: `"${projectId}/${filename}"` (stored as `key` field)
- Index: `by_project` on `projectId` (non-unique)
- Record: `{ key, projectId, filename, mimeType, data: ArrayBuffer }`

**Editor image sizing:** In the editor, `.image-preview-img` has `max-width: min(500px, 100%); height: auto; margin: 0 auto` (style.css). `applyImageSize()` is intentionally not called in the editor — it is only called in `createPreviewElement` for the preview panel.

**Blob object URL lifecycle:** When a file image is displayed in the editor, a blob URL is created and stored in `imageObjectUrls: Map<boxId, string>`. `cleanupImageBox(boxId)` revokes it. Object URLs for the preview panel are short-lived (not tracked) — the IDB read fires on each preview re-render since image boxes bypass the preview cache.

**Startup / IDB initialization:** `initImageDb()` is async. The `init()` startup function is called via `.then(init)` so it only runs after the IDB is open. This ensures file-mode image boxes can load their blob URLs from IDB during initial render. (`init` must be a function declaration, not an IIFE, for this to work.)

**Draft / unsaved project:** Before a project has been saved for the first time, `currentProjectId` is `null`. File uploads use `"draft"` as the project ID prefix. When the project is first saved and assigned an ID, `idbMigrateImageKeys('draft', newId)` re-keys all records and updates `box.src` in the live `boxes` array, then calls `syncToText()`.

**Download behavior:** `downloadCurrentProject()` is async. If the project contains no file-mode image boxes, it produces a plain `.tex` file (unchanged behavior). If file images are present, it uses JSZip (CDN: `jszip@3.10.1`) to create a ZIP containing `<title>.tex` and an `images/` folder. IDB keys in the `.tex` source are rewritten to `images/<filename>` for LaTeX compatibility.

**Integration points:**
- `createBoxElement` (~line 1826): `else if (box.type === 'image')` branch calls `createImageBoxElement`
- `deleteBox` / `rebuildBoxList`: call `cleanupImageBox(id)` alongside `cleanupCalcBox(id)`
- `deleteProject`: calls `idbDeleteAllImagesForProject(id)` after localStorage removal
- `saveCurrentProject`: calls `idbMigrateImageKeys` after first-save
- `createPreviewElement`: async file-image loading with placeholder
- `updatePreview` `needsCache`: excludes image boxes (`box.type !== 'image'`)

---

# Undo/Redo History

## Motivation
Allows reversing edits in both the source panel and the box editor, captured at a coarse granularity (per sync cycle, not per keystroke).

## Subfeature index
None.

## Behaviour
Each sync cycle pushes a snapshot of the serialized LaTeX source + the focused box id. Undo/redo steps through the snapshot stack. Max 200 snapshots.

## Implementation
**State (script.js:231–234):**
```js
const MAX_HISTORY = 200;
let history = [];         // [{ latex, focusId }]
let historyIndex = -1;
let suppressHistory = false;
```

**Functions:**
- `pushHistory(latexStr)` (script.js:1633) — called from `syncToText()` and the `latexSource` input handler
- `applyUndo()` (script.js:1642), `applyRedo()` (script.js:1654)
- `restoreSnapshot(snap, preferFocusIdx)` (script.js:1666) — parses snapshot latex, rebuilds DOM, updates line numbers and preview

**Keyboard:** Ctrl+Z / Ctrl+Y (or Cmd+Z / Cmd+Y on Mac) wired in the global `keydown` listener.

---

# Project Persistence

## Motivation
Persists documents across browser sessions without a server. Multiple named projects can be saved and reopened. The current draft is auto-saved continuously so work isn't lost.

## Subfeature index
None.

## Behaviour
- Projects are named documents stored in `localStorage` as a JSON array (LaTeX source only — binary image data is in IndexedDB).
- The current working draft is auto-saved 1s after the last edit (separate from named project saves).
- The projects panel (slide-in from left) lists all projects. Users can create, rename, delete, open, and download projects.
- Saving a project updates the named entry. The title label shows a `•` when there are unsaved changes.
- Downloading exports the project as a `.tex` file, or as a `.zip` (containing `<title>.tex` + `images/` folder) if the project contains any file-mode image boxes. See [Image Box](#image-box).
- Panel widths and visibility are saved separately and restored on load.
- Deleting a project also deletes all associated IndexedDB image records.

## Implementation
**localStorage keys (script.js:34–36):**
```js
const PROJ_KEY     = 'mathnotepad_projects';  // JSON array of projects
const DRAFT_KEY    = 'mathnotepad_draft';      // current working LaTeX
const UI_STATE_KEY = 'mathnotepad_ui';         // panel widths/visibility
```

**Key functions:**
| Function | Location | Purpose |
|---|---|---|
| `loadProjects()` | script.js:2664 | Load from localStorage |
| `saveProjects(list)` | script.js:2668 | Write to localStorage |
| `saveDraftNow()` | script.js:2672 | Immediate draft save |
| `saveDraft()` | script.js:2683 | Debounced draft save |
| `saveUiState()` | script.js:2688 | Save panel widths/visibility |
| `saveCurrentProject()` | script.js:2725 | Save to named project entry |
| `openProject(id)` | script.js:2763 | Load project, parse, rebuild |
| `downloadCurrentProject()` | script.js:2752 | Export as JSON file |
| `deleteProject(id)` | script.js:2778 | Remove from list |
| `renameProject(id)` | script.js:2790 | Edit project title inline |
| `newProject()` | script.js:2901 | Create blank project |
| `renderProjectsList()` | script.js:2808 | Render projects panel DOM |
| `openProjectsPanel()` | script.js:2921 | Show slide-in panel |
| `closeProjectsPanel()` | script.js:2927 | Hide panel |
| `markDirty()` / `markClean()` | script.js:2697/2703 | Update `isDirty` + title dot |
| `restoreFromLatex(latex)` | script.js:2708 | Parse latex into boxes, rebuild |

---

# Physics Constants

## Motivation
Provides built-in SI physical constants (speed of light, gravitational constant, Planck's constant, etc.) as named variables in calc boxes, so users don't need to look up and type constant values manually.

## Subfeature index
None.

## Behaviour
Constants are split into three independently toggleable groups, each with its own button on the calc box toolbar:
- **Physics** (`physicsBasic`): c, g, G, h, ℏ, m_e, m_p, σ
- **E&M** (`physicsEM`): q_e, ε₀, μ₀, α
- **Chem** (`physicsChem`): R, k_B, N_A

When a group is enabled, its constants are injected as pre-defined variables in the calc box. Constants appear as hover tooltips on the toolbar buttons. A small badge displays the constant's value when recognized in an expression.

## Implementation
**`PHYSICS_CONSTANTS_BASIC` / `PHYSICS_CONSTANTS_EM` / `PHYSICS_CONSTANTS_CHEM`** (math.js) — three arrays of `{ varName, value, label, description, unitDims }` objects. `PHYSICS_CONSTANTS` is their concatenation, used for legacy deserialization. `varName` must match what `parseLatexToAst` produces for the corresponding LaTeX. `unitDims` maps unit names to exponents and may include derived unit names (J, W, N, C, F, H) as well as SI base unit names; dimensionless constants use `{}`. Constants are expressed in the most natural named units (e.g., `h` uses `{J:1, s:1}` rather than `{kg:1, m:2, s:-1}`).

**In `evaluateCalcExpressions`** — accepts `usePhysicsBasic`, `usePhysicsEM`, `usePhysicsChem` (plus legacy `usePhysicsConstants`). Active constants from enabled groups are merged into `allValues` as plain numbers. In units mode, they are additionally merged into `unitValues` as unit ASTs via `buildConstantUnitAst(pc.value, pc.unitDims)`.

**Box model flags:** `physicsBasic`, `physicsEM`, `physicsChem` (all boolean, default false). Serialized as `{physics_basic}`, `{physics_em}`, `{physics_chem}` on the `\begin{calc}` line. Legacy `{physics}` (without underscore suffix) enables all three groups on load.

**`formatConstantValue(v)`** (script.js:74) — formats a numeric value for display: integers → `"= N"`, floats → `"≈ N"`. Used by both physics constant badges and calc result formatting.

**`buildPhysicsTooltip(group, label)`** (script.js:81) — generates tooltip string for a constants group button.

**No symbol conflicts with SI units:** Physics constant `varName` values do not overlap with `SI_BASE_UNITS` or `DERIVED_UNIT_EXPANSIONS` keys. `m_e` / `m_p` (electron/proton mass) have subscripts and do not conflict with `m` (meter).

---

# Policy Examples

This section records worked examples of policy confusions and their resolutions, per the CLAUDE.md guideline. Add entries here after clarifying any ambiguity about how to follow the policies in CLAUDE.md.

*(No entries yet.)*

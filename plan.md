# Math Notepad — Implementation Plan

## Context
Build a browser-based math notepad that lets the user write and manipulate equations digitally using MathQuill (Desmos-style visual editing), while simultaneously maintaining a valid LaTeX text representation. The goal is to eliminate the friction of typesetting: work happens visually, and the LaTeX is produced automatically.

---

## Tech Stack & File Structure
- **No build system.** Three files:
  - `index.html` — layout and CDN links
  - `style.css` — two-panel UI
  - `script.js` — all app logic
- **MathQuill via CDN** (jsDelivr, v0.10.1-a) — simplest path, no npm needed
- **jQuery via CDN** (MathQuill dependency)

CDN links to include:
```html
<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mathquill@0.10.1-a/build/mathquill.css">
<script src="https://cdn.jsdelivr.net/npm/mathquill@0.10.1-a/build/mathquill.min.js"></script>
```

---

## Layout (index.html / style.css)
- Full-height flexbox row, two equal panels with a divider
- **Left panel**: `<textarea id="latex-source">` — monospace, full height
- **Right panel**:
  - Toolbar at top: `[+ Math]` and `[+ Text]` buttons
  - Scrollable `<div id="box-list">` containing box elements

---

## Data Model (script.js)
Central state: an ordered array of box objects.
```js
boxes = [
  { id: 'b1', type: 'math',  content: 'x^2 + y^2 = r^2' },
  { id: 'b2', type: 'text',  content: 'So the radius is r.' },
]
```
Each box maps 1:1 to a rendered element in the right panel and a "block" in the LaTeX source.

---

## LaTeX Serialization Format
Each box serializes to one "block" in the textarea. Blocks are joined with `\n`.

| Box type | LaTeX format |
|----------|-------------|
| math     | `\[content\]` |
| text     | `% content` (LaTeX comment — keeps the file compilable) |

**Parsing** (text → boxes): scan lines, collect `\[...\]` spans as math boxes, `% ...` lines as text boxes, blank lines ignored.

---

## Right Panel Box Behavior

### Rendering
- Each box is a `<div class="box">` containing:
  - A MathQuill `MathField` (for `type: 'math'`) OR a `<textarea>` (for `type: 'text'`)
  - An `×` delete button (top-right, visible on hover/focus)

### Keyboard behavior
- **Enter** in any box → insert new math box immediately after, focus it
- **Backspace** in an empty box → delete box, focus previous (or next)
- **×** button → delete box, focus adjacent box

### MathQuill setup per math box
```js
const field = MQ.MathField(span, {
  handlers: {
    edit:  () => syncToText(),
    enter: () => insertBoxAfter(id),
  }
});
span.addEventListener('keydown', e => {
  if (e.key === 'Backspace' && field.latex() === '') deleteBox(id);
});
```

---

## Synchronization Logic

### Right panel → Left panel (primary direction)
Every `edit` event, box add/delete/reorder: serialize `boxes[]` → set `textarea.value`.

### Left panel → Right panel
`textarea` `input` event, debounced 300ms: parse LaTeX → diff against current boxes → update right panel. Allows power users to edit LaTeX directly.

**Diff strategy**: match by position. Reuse IDs/elements where type matches; update content via `mq.latex(newContent)` or textarea value.

---

## Divider
Drag-to-resize: `mousedown` on `#divider` → track `mousemove` → update `left-panel` width in px.

---

## Future-Proofing for Evaluation/Graphing
- Box objects carry `type`/`id`/`content` — easy to add `{ type: 'graph' }` later
- `mqFields` Map keeps MathQuill instances accessible by id for future evaluation hooks

---

## Critical Files
| File | Purpose |
|------|---------|
| `index.html` | Shell, CDN links, two-panel layout |
| `style.css` | Panel layout, dark theme, box styling |
| `script.js` | State, MQ init, sync logic, keyboard handling |

---

## Verification
1. Open `index.html` directly in browser (no server needed)
2. Type an equation in the right panel → left shows `\[...\]`
3. Press Enter → new math box appears below, focus moves
4. Backspace in empty box → box deleted, focus moves
5. Click `×` → box deleted
6. Click `+ Text` → text box appears, shows `% text` on left
7. Edit LaTeX directly in left panel → right updates after ~300ms
8. Drag the divider to resize panels

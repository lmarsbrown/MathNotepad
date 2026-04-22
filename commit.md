Fix calc box dblclick preview navigation; add per-expression preview highlight

- Fix: scrollAndHighlightPreview was broken for calc boxes because the .preview-calc-box wrapper (holding data-box-id) is removed from the DOM after unwrapping its children; now each child element gets data-box-id + data-expr-id stamped before unwrapping
- Fix: scrollAndHighlightPreview now accepts optional exprId to scroll to a specific calc expression in preview
- Double-clicking an expression row or text row within a calc box now scrolls the preview to that specific expression and blinks it; stops propagation so the outer box dblclick doesn't also fire

Add text annotation rows to calc boxes

- New "text row" type in calc box expressions: plain-text textarea with inline-LaTeX support (same $...$ syntax as text boxes)
- Alt+T when focused inside a calc box inserts a text row after the current row; outside a calc box retains existing "add text box" behavior
- Text rows serialize as `% ct<id> text <content>` inside \begin{calc} blocks; backslashes and newlines are escaped
- Preview renders text rows as <p class="preview-text"> via processTextContent (inline MathJax)
- Navigation: Arrow up/down at edges crosses to adjacent rows; Backspace on empty deletes the row; Enter inserts a new expression row after
- Empty text rows show greyed "Text…" placeholder
- Fix: calc box mousedown handler now excludes textarea from e.preventDefault(), allowing text rows to receive focus; click handler also routes to text rows
- Fix: focusBoxAtEdge handles text rows as first/last row of a calc box
- Fix: text row input handler directly updates boxes[].expressions[].text and calls syncToText()
- Fix: preview cache key for calc boxes now includes e.text for text rows (was only keying on e.latex which is always '' for text rows, causing stale cache hits)

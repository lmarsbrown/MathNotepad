class Box{
    constructor(type,id){
        this.id = id||genId();
        this.type = type;
        this.content = "";
    }
    createElement(){
        _dbg('CREATE_BOX_ELEMENT', {
            id: this.id, type: this.type,
            inRebuild: _dbgInRebuild,
            boxesHasId: boxes.some(b => b.id === this.id),
        });
        const div = document.createElement('div');
        div.className = 'box' + (this.commented ? ' commented' : '') + (this.highlighted ? ' box-is-highlighted' : '');
        div.dataset.id = this.id;

        // Drag handle
        const dragHandle = document.createElement('span');
        dragHandle.className = 'box-drag-handle';
        dragHandle.textContent = '⠿';
        dragHandle.title = 'Drag to reorder';
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', e => {
            dragSrcBoxId = this.id;
            e.dataTransfer.effectAllowed = 'move';
        });
        div.appendChild(dragHandle);

        // Double-click → scroll the preview to this box and blink it
        div.addEventListener('dblclick', e => {
            if (!isPreviewOpen) return;
            scrollAndHighlightPreview(this.id);
        });

        // Click on box padding → focus the field
        let mousedownInMqField = false;
        div.addEventListener('mousedown', e => {
            mousedownInMqField = !!e.target.closest('.mq-editable-field');
            // Prevent default for calc box clicks outside MQ fields / interactive controls so the
            // currently-focused MQ field doesn't blur (causing the focused outline to flash off).
            // The click handler re-focuses the correct expression explicitly.
            // Exclude textarea so calc text rows can receive focus naturally.
            if (this.type === 'calc' && !mousedownInMqField
                && !e.target.closest('button') && !e.target.closest('input') && !e.target.closest('textarea')) {
            e.preventDefault();
            }
        });
        div.addEventListener('click', e => {
            const wasMqDrag = mousedownInMqField;
            mousedownInMqField = false;
            if (e.target.closest('.delete-btn') || e.target.closest('.box-drag-handle')) return;
            if (e.target.closest('.mq-editable-field') || e.target.closest('.text-input') || e.target.closest('.calc-text-input')) return;
            if (e.target.closest('.calc-toolbar') || e.target.closest('.calc-expr-result')) return;
            if (this.type === 'math') {
            const field = mqFields.get(this.id);
            if (field) field.focus();
            } else if (this.type === 'pagebreak' || this.type === 'graph') {
            setFocused(this.id, div);
            } else if (this.type === 'calc') {
            if (wasMqDrag) return; // Don't steal focus when user was dragging to select in a MQ field
            // Focus the expression/text row nearest to the click position
            const wrappers = [...div.querySelectorAll('.expr-wrapper')];
            if (!wrappers.length) return;
            let nearest = wrappers[0];
            let minDist = Infinity;
            for (const w of wrappers) {
                const rect = w.getBoundingClientRect();
                const cy = (rect.top + rect.bottom) / 2;
                const d = Math.abs(e.clientY - cy);
                if (d < minDist) { minDist = d; nearest = w; }
            }
            if (nearest.dataset.rowType === 'text') {
                nearest.querySelector('.calc-text-input')?.focus();
            } else {
                const field = calcMqFields.get(this.id)?.get(nearest.dataset.exprId);
                if (field) field.el().querySelector('textarea')?.focus({ preventScroll: true });
            }
            } else {
            const ta = div.querySelector('.text-input');
            if (ta) ta.focus();
            }
        });

        div.addEventListener('dragover', e => {
            if (!dragSrcBoxId || dragSrcBoxId === this.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            div.classList.add('drag-over');
        });
        div.addEventListener('dragleave', e => {
            if (e.relatedTarget && div.contains(e.relatedTarget)) return;
            div.classList.remove('drag-over');
        });
        div.addEventListener('drop', e => {
            e.preventDefault();
            div.classList.remove('drag-over');
            if (!dragSrcBoxId || dragSrcBoxId === this.id) return;
            const srcIdx = boxes.findIndex(b => b.id === dragSrcBoxId);
            const dstIdx = boxes.findIndex(b => b.id === this.id);
            dragSrcBoxId = null;
            if (srcIdx === -1 || dstIdx === -1) return;
            const [moved] = boxes.splice(srcIdx, 1);
            boxes.splice(dstIdx, 0, moved);
            rebuildBoxList();
            syncToText();
        });

        return div;
    }

    /**
     * Auto-resizes the textarea (.text-input) inside this box to fit its content.
     * Preserves the scroll position of the box list.
     */
    _autoResize() {
        const ta = this.element.querySelector('.text-input');
        if (!ta) return;
        const savedScroll = boxList.scrollTop;
        ta.style.height = '1px';
        ta.style.height = ta.scrollHeight + 'px';
        boxList.scrollTop = savedScroll;
    }

    _createDeleteButton(){
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete box';
        deleteBtn.addEventListener('click', () => deleteBox(this.id));
        return deleteBtn;
    }
}

class MathBox extends Box{
    constructor(content,id){
        super("math",id);
        if(content){
            this.content = content;
        }
        this.element = this.createElement();
    }

    /**
     * Resizes the box to fit the rendered MathQuill equation height.
     * Uses requestAnimationFrame so layout is stable before measuring.
     */
    _resizeBox() {
        requestAnimationFrame(() => {
            this.element.style.minHeight = '';
            const mqSpan = this.element.querySelector('.mq-math-mode');
            const h = mqSpan ? mqSpan.offsetHeight : 0;
            if (h > 0) this.element.style.minHeight = (h + 20) + 'px';
        });
    }

    createElement(){
        let div = super.createElement();

        const mqSpan = document.createElement('span');
        div.appendChild(mqSpan);
        div.appendChild(this._createDeleteButton());

        // Resize the box to fit the rendered equation height.
        // MathQuill's internal vertical-align tricks don't always push the CSS block
        // height, so we measure the actual rendered offsetHeight and set min-height.
        boxResizers.set(this.id, () => this._resizeBox());

        const greekLetters = "alpha beta Gamma gamma Delta delta epsilon zeta eta Theta theta iota kappa Lambda lambda mu nu Xi xi Pi pi rho Sigma sigma tau Upsilon upsilon Phi phi Chi chi Psi Omega omega";

        const field = MQ.MathField(mqSpan, {
        spaceBehavesLikeTab: false,
        autoCommands: 'sqrt nthroot sum int prod in notin subset subseteq supset supseteq cup cap emptyset forall exists infty partial setminus ell approx times vec hbar nabla '+greekLetters,
        autoOperatorNames: 'sin cos tan arcsin arccos arctan ln log exp mat',
        handlers: {
            edit: () => {
            const idx = boxes.findIndex(b => b.id === this.id);
            if (idx !== -1) {
                boxes[idx].content = field.latex();
                syncToText();
            }
            this._resizeBox();
            },
            enter: () => {
            insertBoxAfter(this.id, defaultBoxType);
            },
            // dir === 1 → right arrow past end; dir === -1 → left arrow past start
            moveOutOf: (dir) => {
            const idx = boxes.findIndex(b => b.id === this.id);
            if (dir === 1 && idx < boxes.length - 1) focusBoxAtEdge(boxes[idx + 1].id, 'start');
            else if (dir === -1 && idx > 0)          focusBoxAtEdge(boxes[idx - 1].id, 'end');
            },
            upOutOf: () => {
            const idx = boxes.findIndex(b => b.id === this.id);
            if (idx > 0) focusBoxAtEdge(boxes[idx - 1].id, 'end');
            },
            downOutOf: () => {
            const idx = boxes.findIndex(b => b.id === this.id);
            if (idx < boxes.length - 1) focusBoxAtEdge(boxes[idx + 1].id, 'start');
            },
        },
        });

        if (this.content){
            field.latex(this.content);
        }
        setTimeout(() => this._resizeBox(), 0);

        // Capture-phase keydown: fires before MathQuill's inner textarea handler.
        mqSpan.addEventListener('keydown', e => {
        // Enter with any modifier combo → new box
        if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey || e.altKey)) {
            e.preventDefault();
            insertBoxAfter(this.id, defaultBoxType);
        }
        // Backspace on empty → delete box
        if (e.key === 'Backspace' && field.latex() === '') {
            e.preventDefault();
            deleteBox(this.id);
        }
        // Ctrl+X: whole-box cut only when nothing is selected in MathQuill.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
            const hasSelection = !!mqSpan.querySelector('.mq-selection');
            if (!hasSelection) {
            e.preventDefault();
            e.stopPropagation();
            cutBox(this.id);
            } else {
            boxClipboard = null;
            }
        }
        // Ctrl+/: toggle comment
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
            e.preventDefault();
            e.stopPropagation();
            toggleComment(this.id);
        }
        // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y: intercept before MathQuill's own undo handler
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) applyRedo(); else applyUndo();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            e.stopPropagation();
            applyRedo();
        }
        // Ctrl+H: suppress browser default (toggle logic handled by global keydown listener)
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
            e.preventDefault();
        }
        }, true); // capture phase: fires before MathQuill's inner textarea handler

        // Track focus
        mqSpan.addEventListener('focusin', () => setFocused(this.id, div));
        mqSpan.addEventListener('focusout', () => clearFocused(this.id, div));

        mqFields.set(this.id, field);

        return div;
    }
}

class TextBox extends Box{
    constructor(content,id){
        super("text",id);
        if(content){
            this.content = content;
        }
        this.element = this.createElement();
    }
    createElement(){
        let div = super.createElement();

        // Text box: textarea that auto-resizes
        const ta = document.createElement('textarea');
        ta.className = 'text-input';
        ta.rows = 1;
        ta.value = this.content || '';
        ta.placeholder = 'Text…';

        boxResizers.set(this.id, () => this._autoResize());

        ta.addEventListener('input', () => {
        this._autoResize();
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx !== -1) {
            boxes[idx].content = ta.value;
            syncToText();
        }
        });

        ta.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            insertBoxAfter(this.id, defaultBoxType);
        }
        if (e.key === 'Backspace' && ta.value === '') {
            e.preventDefault();
            deleteBox(this.id);
        }
        // Ctrl+X with no selection → cut whole box; with selection → let browser cut text
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
            if (ta.selectionStart === ta.selectionEnd) {
            e.preventDefault();
            cutBox(this.id);
            } else {
            boxClipboard = null;
            }
        }
        // Ctrl+/: toggle comment
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
            e.preventDefault();
            toggleComment(this.id);
        }
        // Arrow key inter-box navigation (only plain arrow keys — no modifier keys)
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const idx = boxes.findIndex(b => b.id === this.id);
            if (e.key === 'ArrowLeft' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
            if (idx > 0) { e.preventDefault(); focusBoxAtEdge(boxes[idx - 1].id, 'end'); }
            } else if (e.key === 'ArrowRight' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
            if (idx < boxes.length - 1) { e.preventDefault(); focusBoxAtEdge(boxes[idx + 1].id, 'start'); }
            } else if (e.key === 'ArrowUp') {
            // Navigate up only when cursor is already on the first line
            const onFirstLine = ta.value.lastIndexOf('\n', ta.selectionStart - 1) === -1;
            if (onFirstLine && idx > 0) { e.preventDefault(); focusBoxAtEdge(boxes[idx - 1].id, 'end'); }
            } else if (e.key === 'ArrowDown') {
            // Navigate down only when cursor is already on the last line
            const onLastLine = ta.value.indexOf('\n', ta.selectionStart) === -1;
            if (onLastLine && idx < boxes.length - 1) { e.preventDefault(); focusBoxAtEdge(boxes[idx + 1].id, 'start'); }
            }
        }
        });

        ta.addEventListener('focus', () => setFocused(this.id, div));
        ta.addEventListener('blur',  () => clearFocused(this.id, div));

        
        div.appendChild(ta);
        div.appendChild(this._createDeleteButton());

        // Trigger resize after append
        requestAnimationFrame(() => this._autoResize());
        return div;
    }
}

class HeaderBox extends Box{
    constructor(type, content='', id){
        super(type,id);
        this.content = content;
        this.element = this.createElement();
    }
    createElement(){
        let div = super.createElement();

        // Badge sits on the top border of the box (absolutely positioned)
        const label = document.createElement('span');
        label.className = 'box-type-label';
        label.textContent = this.type.toUpperCase();
        div.appendChild(label);

        // Inner flex container for the textarea only
        const inner = document.createElement('div');
        inner.className = 'box-heading-inner';

        const fontSizes = { h1: '20px', h2: '17px', h3: '15px' };

        const ta = document.createElement('textarea');
        ta.className = 'text-input';
        ta.rows = 1;
        ta.value = this.content || '';
        ta.placeholder = this.type.toUpperCase() + '…';
        ta.style.fontWeight = 'bold';
        ta.style.fontSize = fontSizes[this.type];

        boxResizers.set(this.id, () => this._autoResize());

        ta.addEventListener('input', () => {
        this._autoResize();
        // Strip newlines from headings
        if (ta.value.includes('\n')) ta.value = ta.value.replace(/\n/g, '');
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx !== -1) {
            boxes[idx].content = ta.value;
            syncToText();
        }
        });

        ta.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            insertBoxAfter(this.id, defaultBoxType);
        }
        if (e.key === 'Backspace' && ta.value === '') {
            e.preventDefault();
            deleteBox(this.id);
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
            if (ta.selectionStart === ta.selectionEnd) {
            e.preventDefault();
            cutBox(this.id);
            } else {
            boxClipboard = null;
            }
        }
        // Ctrl+/: toggle comment
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
            e.preventDefault();
            toggleComment(this.id);
        }
        // Arrow key inter-box navigation (plain arrow keys only)
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const idx = boxes.findIndex(b => b.id === this.id);
            if (e.key === 'ArrowLeft' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
            if (idx > 0) { e.preventDefault(); focusBoxAtEdge(boxes[idx - 1].id, 'end'); }
            } else if (e.key === 'ArrowRight' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
            if (idx < boxes.length - 1) { e.preventDefault(); focusBoxAtEdge(boxes[idx + 1].id, 'start'); }
            } else if (e.key === 'ArrowUp' && idx > 0) {
            e.preventDefault(); focusBoxAtEdge(boxes[idx - 1].id, 'end');
            } else if (e.key === 'ArrowDown' && idx < boxes.length - 1) {
            e.preventDefault(); focusBoxAtEdge(boxes[idx + 1].id, 'start');
            }
        }
        });

        ta.addEventListener('focus', () => setFocused(this.id, div));
        ta.addEventListener('blur',  () => clearFocused(this.id, div));

        inner.appendChild(ta);
        div.appendChild(inner);
        div.appendChild(this._createDeleteButton());
        requestAnimationFrame(() => this._autoResize());

        return div;
    }
}

class PagebreakBox extends Box{
    constructor(id){
        super("pagebreak", id);
        this.element = this.createElement();
    }
    createElement(){
        let div = super.createElement();

        div.classList.add('box-pagebreak');

        const rule = document.createElement('div');
        rule.className = 'pagebreak-rule';
        div.appendChild(rule);
        div.appendChild(this._createDeleteButton());

        return div;
    }
}
// ── ID generation ─────────────────────────────────────────────────────────────
function genId() { return 'b' + (nextId++); }

/** Sync highlight/fill-color toolbar buttons to the currently focused box. */
function updateHighlightToolbar() {
  const box = focusedBoxId ? boxes.find(b => b.id === focusedBoxId) : null;
  const hl  = !!(box && box.highlighted);

  highlightBtn.disabled = !box;
  highlightBtn.classList.toggle('hl-active', hl);
  fillColorBtn.style.display = hl ? '' : 'none';
  if (hl) {
    if (box.fillColor) {
      fillColorBtn.style.background = box.fillColor;
      fillColorBtn.classList.remove('no-fill');
    } else {
      fillColorBtn.style.background = '';
      fillColorBtn.classList.add('no-fill');
    }
  }
}

// ── Render all boxes ──────────────────────────────────────────────────────────
function renderBoxes() {
  boxList.innerHTML = '';
  for (const box of boxes) {
    boxList.appendChild(box.element);
    reflowBox(box);
  }
}
// Setting the latex of a box before it is in the DOM can cause bugs. Calling reflow after it is added fixes this.
function reflowBox(box){
  if(mqFields.get(box.id) != undefined){
    const field = mqFields.get(box.id) ;
    field.reflow();
  }
  // Reflow all MathQuill fields in a calc box
  const calcMap = calcMqFields.get(box.id);
  if (calcMap) {
    for (const field of calcMap.values()) field.reflow();
  }
}

function setFocused(id, el) {
  _dbg('SET_FOCUSED', {
    id, prev: focusedBoxId,
    idInBoxes: boxes.some(b => b.id === id),
    idInDom: !!boxList.querySelector(`[data-id="${id}"]`),
  });
  if (focusedBoxId && focusedBoxId !== id) {
    const prevEl = boxList.querySelector(`[data-id="${focusedBoxId}"]`);
    if (prevEl) prevEl.classList.remove('focused');
  }
  focusedBoxId = id;
  el.classList.add('focused');
  // Clear source-panel box outline (source panel takes over when textarea is focused)
  boxList.querySelectorAll('.box-source-active').forEach(b => b.classList.remove('box-source-active'));
  highlightSourceForBox(id);
  updateHighlightToolbar();
}

function clearFocused(id, el) {
  _dbg('CLEAR_FOCUSED', { id, wasFocused: focusedBoxId === id });
  if (focusedBoxId === id) focusedBoxId = null;
  el.classList.remove('focused');
  updateSourceHighlight(-1, -1);
  updateHighlightToolbar();
}

function createBoxFromType(type, id, content=''){
    return type === 'graph'   ? new GraphBox(id)
        : type === 'calc'     ? new CalcBox(id)
        : type === 'image'    ? new ImageBox(id)
        : type === 'math'     ? new MathBox(content, id)
        : type === 'text'     ? new TextBox(content, id)
        : (type === 'h1' || type === 'h2' || type === 'h3') ? new HeaderBox(type, content, id)
        : type === 'pagebreak' ? new PagebreakBox(id)
        : new Box(type, id);
}
// ── Insert / delete ───────────────────────────────────────────────────────────
function insertBoxAfter(afterId, type = 'math') {
  const newBox = createBoxFromType(type);

  const idx = boxes.findIndex(b => b.id === afterId);
  _dbg('INSERT_BOX_AFTER', {
    afterId, type, newId: newBox.id,
    afterIdFound: idx !== -1,
    insertPos: idx === -1 ? boxes.length : idx + 1,
    focusedBoxId,
  });
  if (idx === -1) {
    boxes.push(newBox);
  } else {
    boxes.splice(idx + 1, 0, newBox);
  }
  rebuildBoxList();
  syncToText();
  focusBox(newBox.id);
}

function appendBox(type = 'math') {
  _dbg('APPEND_BOX', { type, focusedBoxId, boxCount: boxes.length });
  if (focusedBoxId) {
    const idx = boxes.findIndex(b => b.id === focusedBoxId);
    if (idx !== -1) {
      // Check if focused box is empty
      const focused = boxes[idx];
      // Pagebreaks, graphs, calc, and image boxes have no simple editable content — always insert after, never convert
      if (focused.type === 'pagebreak' || focused.type === 'graph' || focused.type === 'calc' || focused.type === 'image') {
        insertBoxAfter(focusedBoxId, type);
        return;
      }
      let isEmpty = false;
      if (focused.type === 'math') {
        const field = mqFields.get(focusedBoxId);
        isEmpty = !field || field.latex() === '';
      } else {
        const ta = boxList.querySelector(`[data-id="${focusedBoxId}"] .text-input`);
        isEmpty = !ta || ta.value === '';
      }
      if (isEmpty) {
        if (focused.type === type) {
          // Already the right type and empty — just refocus
          focusBox(focusedBoxId);
          return;
        }
        // Convert the empty box to the new type in-place.
        // Snapshot the id before oldEl.remove() — Chrome fires focusout synchronously
        // during DOM removal, which calls clearFocused() and nulls focusedBoxId.
        const convertId = focusedBoxId;
        mqFields.delete(convertId);
        boxResizers.delete(convertId);
        const oldEl = boxList.querySelector(`[data-id="${convertId}"]`);
        if (oldEl) oldEl.remove();
        boxes[idx] = createBoxFromType(type,convertId);

        rebuildBoxList();
        syncToText();
        focusBox(convertId);
        return;
      }
    }
    insertBoxAfter(focusedBoxId, type);
  } else {
    const newBox = createBoxFromType(type);
    boxes.push(newBox);
    rebuildBoxList();
    syncToText();
    focusBox(newBox.id);
  }
}

function deleteBox(id) {
  const idx = boxes.findIndex(b => b.id === id);
  if (idx === -1) return;

  // Decide where to focus next
  const focusTargetIdx = idx > 0 ? idx - 1 : (boxes.length > 1 ? 1 : -1);
  const focusTarget = focusTargetIdx >= 0 ? boxes[focusTargetIdx]?.id : null;

  mqFields.delete(id);
  boxResizers.delete(id);
  cleanupCalcBox(id);
  cleanupImageBox(id);
  boxes.splice(idx, 1);
  rebuildBoxList();
  syncToText();

  if (focusTarget) focusBox(focusTarget);
}

function toggleComment(id) {
  const idx = boxes.findIndex(b => b.id === id);
  if (idx === -1) return;
  boxes[idx].commented = !boxes[idx].commented;
  const el = boxList.querySelector(`[data-id="${id}"]`);
  if (el) el.classList.toggle('commented', !!boxes[idx].commented);
  syncToText();
}

// ── Focus a box ───────────────────────────────────────────────────────────────
function focusBox(id) {
  _dbg('FOCUS_BOX', {
    id,
    hasMqField: mqFields.has(id),
    hasCalcMap: calcMqFields.has(id),
    hasTextInput: !!boxList.querySelector(`[data-id="${id}"] .text-input`),
    idInBoxes: boxes.some(b => b.id === id),
  });
  const field = mqFields.get(id);
  if (field) {
    setTimeout(() => field.focus(), 0);
    return;
  }
  // Calc box: focus the first expression field
  const calcMap = calcMqFields.get(id);
  if (calcMap) {
    const firstField = calcMap.values().next().value;
    if (firstField) { setTimeout(() => firstField.focus(), 0); return; }
  }
  const el = boxList.querySelector(`[data-id="${id}"] .text-input`);
  if (el) setTimeout(() => el.focus(), 0);
}

// Focus a box and place the cursor at 'start' or 'end'.
// For MathQuill fields the cursor lands wherever it was last (MQ manages this).
function focusBoxAtEdge(id, edge) {
  const field = mqFields.get(id);
  if (field) {
    setTimeout(() => field.focus(), 0);
    return;
  }
  // Calc box: focus first or last row (expression or text) using DOM order
  const wrappers = [...boxList.querySelectorAll(`[data-id="${id}"] .expr-wrapper`)];
  if (wrappers.length > 0) {
    const targetWrapper = edge === 'start' ? wrappers[0] : wrappers[wrappers.length - 1];
    const exprId = targetWrapper.dataset.exprId;
    if (targetWrapper.dataset.rowType === 'text') {
      const ta = targetWrapper.querySelector('.calc-text-input');
      if (ta) {
        setTimeout(() => {
          ta.focus();
          const pos = edge === 'start' ? 0 : ta.value.length;
          ta.setSelectionRange(pos, pos);
        }, 0);
        return;
      }
    } else {
      const target = calcMqFields.get(id)?.get(exprId);
      if (target) { setTimeout(() => target.focus(), 0); return; }
    }
  }
  const el = boxList.querySelector(`[data-id="${id}"] .text-input`);
  if (el) {
    setTimeout(() => {
      el.focus();
      const pos = edge === 'start' ? 0 : el.value.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }
}

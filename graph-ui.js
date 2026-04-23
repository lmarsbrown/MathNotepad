'use strict';

// ── GraphExpressionBox ────────────────────────────────────────────────────────

/**
 * Represents a single expression row within the graph editor.
 * Owns its DOM element (.expr-wrapper), MQ field, color swatch, slider, and
 * const-value badge. Lives only during a graph edit session; created by
 * renderGraphExprList and destroyed by _teardownGraphModeUI.
 * @extends Box
 */
class GraphExpressionBox extends Box {
    /**
     * @param {{ id?: string, latex?: string, enabled?: boolean, color?: string, thickness?: number, sliderMin?: number, sliderMax?: number }} data
     */
    constructor(data = {}) {
        super('graphexpr', data.id);
        this.latex     = data.latex     || '';
        this.enabled   = data.enabled   !== false;
        this.color     = data.color     || '#3b82f6';
        this.thickness = data.thickness != null ? data.thickness : 2.0;
        this.sliderMin = data.sliderMin ?? 0;
        this.sliderMax = data.sliderMax ?? 10;
        this._mqField        = null;
        this._toggle         = null;
        this._colorSwatch    = null;
        this._constValueSpan = null;
        this._showSlider     = null;
        this._hideSlider     = null;
        this.element = this.createElement();
    }

    /**
     * Builds the .expr-wrapper DOM for this graph expression row.
     * Registers this._mqField into graphMqFields.
     * @returns {HTMLElement}
     */
    createElement() {
        const colorSwatch = document.createElement('div');
        colorSwatch.className = 'graph-expr-color-swatch';
        colorSwatch.style.background = this.color;
        colorSwatch.title = 'Color & thickness';
        this._colorSwatch = colorSwatch;

        const constValueSpan = document.createElement('span');
        constValueSpan.className = 'graph-expr-const-value';
        constValueSpan.style.display = 'none';
        this._constValueSpan = constValueSpan;

        const { wrapper, mqField: field, toggle, mqSpan, handle } = createExprRow(
            { id: this.id, enabled: this.enabled },
            {
                //Claude: please do not touch the greek letters. There are some I dont want (like psi) because they interfere with others (you can spell epsilon without psi for example)
                autoCommands: 'sqrt sum int prod infty partial leq geq neq alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega',
                rightSlot:       colorSwatch,
                showDragHandle:  true,
                onEdit:          () => { commitGraphEditorToBox(graphModeBoxId); scheduleGraphRender(); },
                onEnter:         () => addGraphExpressionAfter(this.id),
                onToggle:        () => { commitGraphEditorToBox(graphModeBoxId); scheduleGraphRender(); },
                onDelete:        () => this._delete(false),
                onBackspaceEmpty:() => this._delete(true),
                onMoveOut: (dir) => {
                    const listEl = document.getElementById('graph-expr-list');
                    const wrappers = [...listEl.querySelectorAll('.expr-wrapper')];
                    const idx = wrappers.findIndex(w => w.dataset.exprId === this.id);
                    if (dir === 1 && idx < wrappers.length - 1) {
                        focusExprRowById(graphMqFields, wrappers[idx + 1].dataset.exprId);
                    } else if (dir === -1 && idx > 0) {
                        focusExprRowById(graphMqFields, wrappers[idx - 1].dataset.exprId);
                    }
                },
            }
        );
        this._mqField = field;
        this._toggle  = toggle;

        wrapper.dataset.color     = this.color;
        wrapper.dataset.thickness = this.thickness;

        // Slider section — shown for numeric constants like a=2
        const { showSlider, hideSlider } = createSliderSection(wrapper, this, {
            getLatex:       () => this._mqField.latex(),
            setLatex:       (str) => { this._mqField.latex(str); commitGraphEditorToBox(graphModeBoxId); scheduleGraphRender(); },
            onBoundsCommit: () => commitGraphEditorToBox(graphModeBoxId),
        });
        this._showSlider = showSlider;
        this._hideSlider = hideSlider;

        colorSwatch.addEventListener('click', (e) => {
            e.stopPropagation();
            openColorPopup(colorSwatch, this.id);
        });

        constValueSpan.addEventListener('click', () => {
            navigator.clipboard.writeText(constValueSpan.textContent.replace(/^[≈=]\s*/, '')).catch(() => {});
        });
        wrapper.appendChild(constValueSpan);

        // Undo/redo shortcuts inside the MathQuill field
        mqSpan.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault(); e.stopPropagation();
                if (e.shiftKey) applyRedo(); else applyUndo();
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                e.preventDefault(); e.stopPropagation();
                applyRedo();
            }
        }, true);

        // Drag-to-reorder within the graph expression list
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            const listEl = document.getElementById('graph-expr-list');
            const allWrappers = () => Array.from(listEl.querySelectorAll('.expr-wrapper'));
            const startY = e.clientY;
            const origRect = wrapper.getBoundingClientRect();

            const ghost = wrapper.cloneNode(true);
            ghost.style.cssText = `
              position: fixed;
              left: ${origRect.left}px;
              top: ${origRect.top}px;
              width: ${origRect.width}px;
              opacity: 0.85;
              pointer-events: none;
              z-index: 9999;
              box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            `;
            document.body.appendChild(ghost);

            const placeholder = document.createElement('div');
            placeholder.style.cssText = `height: ${origRect.height}px; border-radius: 6px; background: #313244; border: 1px dashed #585b70;`;
            wrapper.replaceWith(placeholder);

            let currentTarget = placeholder;

            function onMove(ev) {
                ghost.style.top = (origRect.top + ev.clientY - startY) + 'px';
                const siblings = allWrappers().filter(w => w !== wrapper);
                let inserted = false;
                for (const sib of siblings) {
                    const r = sib.getBoundingClientRect();
                    if (ev.clientY < r.top + r.height / 2) {
                        if (currentTarget !== sib) { sib.before(placeholder); currentTarget = sib; }
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) {
                    const last = siblings[siblings.length - 1];
                    if (last && currentTarget !== null) { listEl.appendChild(placeholder); currentTarget = null; }
                }
            }

            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                ghost.remove();
                placeholder.replaceWith(wrapper);
                commitGraphEditorToBox(graphModeBoxId);
                scheduleGraphRender();
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Track focused expression for render-on-top highlight
        wrapper.addEventListener('focusin', () => {
            if (focusedGraphExprId !== this.id) { focusedGraphExprId = this.id; scheduleGraphRender(); }
        });
        wrapper.addEventListener('focusout', e => {
            if (!wrapper.contains(e.relatedTarget)) {
                const leavingId = this.id;
                setTimeout(() => {
                    if (focusedGraphExprId === leavingId) { focusedGraphExprId = null; scheduleGraphRender(); }
                }, 0);
            }
        });

        if (this.latex) field.latex(this.latex);
        graphMqFields.set(this.id, field);
        return wrapper;
    }

    /**
     * Refreshes color swatch visibility, slider, and const-value badge.
     * Calls updateGraphingControls with the precompiled analysis (fast) or null (slow recompile).
     * @param {Object|null} analysis - From renderer._lastAnalysis, or null to trigger recompile.
     */
    updateControls(analysis) {
        updateGraphingControls(
            this._mqField.latex(), analysis, this.id,
            this._colorSwatch, this._toggle,
            this._showSlider, this._hideSlider,
            this._constValueSpan
        );
    }

    /**
     * Removes this row from the DOM and _activeGraphExprBoxes.
     * @param {boolean} focusAdjacent - Whether to focus the nearest remaining row.
     */
    _delete(focusAdjacent) {
        const listEl = document.getElementById('graph-expr-list');
        if (focusAdjacent) {
            const wrappers = Array.from(listEl.querySelectorAll('.expr-wrapper'));
            const idx = wrappers.findIndex(w => w.dataset.exprId === this.id);
            if (wrappers.length > 1) {
                const focusId = idx > 0 ? wrappers[idx - 1].dataset.exprId : wrappers[idx + 1].dataset.exprId;
                focusExprRowById(graphMqFields, focusId);
            }
        }
        graphMqFields.delete(this.id);
        const exprIdx = _activeGraphExprBoxes.findIndex(e => e.id === this.id);
        if (exprIdx !== -1) _activeGraphExprBoxes.splice(exprIdx, 1);
        this.element.remove();
        updateGraphBoxCount(graphModeBoxId);
        commitGraphEditorToBox(graphModeBoxId);
        scheduleGraphRender();
        syncToText();
    }

    /** Focuses the MathQuill field. */
    focus() {
        if (this._mqField) this._mqField.focus();
    }

    /**
     * Returns a plain serializable data object for persistence and rendering.
     * @returns {{ id: string, latex: string, enabled: boolean, color: string, thickness: number, sliderMin: number, sliderMax: number }}
     */
    toData() {
        const latex     = this._mqField ? this._mqField.latex() : this.latex;
        const enabled   = this._toggle  ? this._toggle.getAttribute('aria-pressed') === 'true' : this.enabled;
        const color     = this.element  ? (this.element.dataset.color                  || this.color)     : this.color;
        const thickness = this.element  ? (parseFloat(this.element.dataset.thickness)  || 2.0)            : this.thickness;
        const sliderMin = this.element  ? (parseFloat(this.element.dataset.sliderMin)  || 0)              : this.sliderMin;
        const sliderMax = this.element  ? (parseFloat(this.element.dataset.sliderMax)  || 10)             : this.sliderMax;
        return { id: this.id, latex, enabled, color, thickness, sliderMin, sliderMax };
    }
}

// ── Graph editing mode ────────────────────────────────────────────────────────

function enterGraphMode(boxId) {
  const box = boxes.find(b => b.id === boxId);
  if (!box || box.type !== 'graph') return;

  // Open preview first (while graphModeBoxId is still null so updatePreview runs)
  if (!isPreviewOpen) togglePreview();

  // Now lock graph mode — subsequent updatePreview calls are blocked
  graphModeBoxId = boxId;

  // Swap right-panel content: hide box list, show graph editor
  boxList.style.display = 'none';
  document.getElementById('graph-editor-content').style.display = 'flex';
  document.getElementById('normal-toolbar').style.display = 'none';
  document.getElementById('graph-crop-checkbox').checked = showGraphCropRect;
  document.getElementById('graph-toolbar').style.display = '';


  // Set size inputs
  document.getElementById('graph-width-input').value  = box.width  || 600;
  document.getElementById('graph-height-input').value = box.height || 400;

  // Populate expression list
  renderGraphExprList(box);

  // Mount the WebGL canvas into the preview panel
  const renderer = getGraphRenderer();
  // Restore view bounds if this graph was edited before
  if (box._viewBounds) {
    renderer.xMin = box._viewBounds.xMin;
    renderer.xMax = box._viewBounds.xMax;
    renderer.yMin = box._viewBounds.yMin;
    renderer.yMax = box._viewBounds.yMax;
  } else {
    renderer.xMin = -5; renderer.xMax = 5;
    renderer.yMin = -5; renderer.yMax = 5;
  }
  previewContent.innerHTML = '';
  previewContent.classList.add('graph-mode');
  previewContent.appendChild(renderer.canvas);
  renderer.canvas.style.width  = '100%';
  renderer.canvas.style.height = '100%';

  // Set up re-render callback for pan/zoom
  renderer._onRender = () => scheduleGraphRender();

  // Background click: defocus whatever expression row is active
  renderer._onBackgroundClick = () => {
    if (focusedGraphExprId !== null) {
      const field = graphMqFields.get(focusedGraphExprId);
      if (field) field.blur();
      focusedGraphExprId = null;
      scheduleGraphRender();
    }
  };

  // Set up click-to-focus: clicking a curve focuses its expression row
  renderer._onPick = exprId => {
    focusExprRowById(graphMqFields, exprId);
  };

  // Snap coordinate tooltip
  const snapTooltip = document.createElement('div');
  snapTooltip.id = 'graph-snap-tooltip';
  previewContent.appendChild(snapTooltip);

  renderer._onSnapUpdate = (snapPoint, canvasX, canvasY) => {
    if (!snapPoint) {
      snapTooltip.style.display = 'none';
      return;
    }
    const fracX = canvasX / renderer.width;
    const fracY = canvasY / renderer.height;
    const OFFSET = 14;
    let left = fracX * 100;
    let top  = fracY * 100;
    snapTooltip.style.display = 'block';
    snapTooltip.style.left = `calc(${left}% + ${OFFSET}px)`;
    snapTooltip.style.top  = `calc(${top}% - ${OFFSET}px)`;
    const fmt = v => parseFloat(v.toPrecision(5)).toString();
    snapTooltip.textContent = `(${fmt(snapPoint.wx)}, ${fmt(snapPoint.wy)})`;
  };

  // Initial render
  renderGraphPreview();
}

function _teardownGraphModeUI() {
  clearTimeout(graphCommitTimer);
  if (graphRenderer) { graphRenderer._onRender = null; graphRenderer._onPick = null; graphRenderer._onSnapUpdate = null; graphRenderer._onBackgroundClick = null; }
  graphMqFields.clear();
  _activeGraphExprBoxes = [];
  focusedGraphExprId = null;
  closeColorPopup();
  document.getElementById('graph-expr-list').innerHTML = '';
  boxList.style.display = '';
  document.getElementById('graph-editor-content').style.display = 'none';
  document.getElementById('normal-toolbar').style.display = '';
  document.getElementById('graph-toolbar').style.display = 'none';

  graphModeBoxId = null;
  previewContent.classList.remove('graph-mode');
  // Remove crop overlay if present
  const overlay = document.getElementById('graph-crop-overlay');
  if (overlay) overlay.remove();
}

function exitGraphMode() {
  if (!graphModeBoxId) return;

  commitGraphEditorToBox(graphModeBoxId);
  clearTimeout(graphCommitTimer);

  // Capture the graph to a static image for the document
  if (graphRenderer) {
    const box = boxes.find(b => b.id === graphModeBoxId);
    if (box) {
      // Use crop world-bounds so the snapshot matches what the overlay shows
      const crop = getGraphCropInfo(box);

      // Save the canvas-view bounds for restore, then apply the crop bounds
      const savedXMin = graphRenderer.xMin, savedXMax = graphRenderer.xMax;
      const savedYMin = graphRenderer.yMin, savedYMax = graphRenderer.yMax;
      graphRenderer.xMin = crop.worldXMin; graphRenderer.xMax = crop.worldXMax;
      graphRenderer.yMin = crop.worldYMin; graphRenderer.yMax = crop.worldYMax;

      graphRenderer.updateExpressions(box.expressions || []);
      graphRenderer.render(box.width || 600, box.height || 400, !!box.lightTheme);
      box._snapshotDataUrl = graphRenderer.canvas.toDataURL('image/png');
      box.element = box.createElement(); // rebuild element to include snapshot thumbnail

      // Restore canvas-view bounds and save them for re-entry
      graphRenderer.xMin = savedXMin; graphRenderer.xMax = savedXMax;
      graphRenderer.yMin = savedYMin; graphRenderer.yMax = savedYMax;
      box._viewBounds = { xMin: savedXMin, xMax: savedXMax,
                          yMin: savedYMin, yMax: savedYMax };
    }
  }

  _teardownGraphModeUI();

  // Rebuild box list to show updated snapshot, then restore preview
  rebuildBoxList();
  syncToText();
  if (isPreviewOpen) schedulePreview(0);
}

/**
 * Refreshes UI controls for a graph expression row (color swatch, toggle, slider, const badge).
 * Uses precompiledAnalysis if provided (fast path); otherwise runs a full recompile (slow path).
 *
 * @param {string} latex - Current LaTeX of the expression.
 * @param {Object|null} precompiledAnalysis - From renderer._lastAnalysis, or null to recompile.
 * @param {string} exprId - Id of the expression row being updated.
 * @param {HTMLElement} colorSwatch
 * @param {HTMLElement} toggle
 * @param {Function} showSlider
 * @param {Function} hideSlider
 * @param {HTMLElement} constValueSpan
 */
function updateGraphingControls(latex, precompiledAnalysis, exprId, colorSwatch, toggle, showSlider, hideSlider, constValueSpan) {
  let isGraphable = false;
  let isNumericConst = false;
  let constValue = null;
  let constEvalValue = null;
  if (latex.trim() !== '' && graphModeBoxId) {
    let analysis;
    if (precompiledAnalysis) {
      // Fast path: reuse the analysis already computed by renderer.updateExpressions().
      // _compiledExprs only has enabled expressions, so for disabled rows preserve last-known state.
      analysis = precompiledAnalysis;
      const renderer = getGraphRenderer();
      const enabledAndCompiled = renderer._compiledExprs.some(e => e.exprId === exprId && e.shaderInfo);
      isGraphable = enabledAndCompiled || (toggle.style.display !== 'none');
    } else {
      // Slow path: full recompile (used on initial render and when user actively edits this field)
      const box = boxes.find(b => b.id === graphModeBoxId);
      const allExprs = (box ? box.expressions || [] : []).map(e =>
        e.id === exprId ? { ...e, latex, enabled: true } : e
      );
      if (!allExprs.find(e => e.id === exprId)) {
        allExprs.push({ id: exprId, latex, color: '#000', enabled: true, thickness: 2 });
      }
      const result = compileGraphExpressions(allExprs);
      analysis = result.analysis;
      isGraphable = result.renderExprs.some(re => re.exprId === exprId);
    }
    if (!isGraphable) {
      const nameMatch = latex.trim().match(/^([a-zA-Z]\w*)\s*=/);
      if (nameMatch && !['x', 'y'].includes(nameMatch[1]) && analysis.constantValues.has(nameMatch[1])) {
        const constName = nameMatch[1];
        const constInfo = analysis.constants.find(c => c.name === constName);
        const eqIdx = latex.indexOf('=');
        const rhs = eqIdx >= 0 ? latex.slice(eqIdx + 1).trim() : '';
        if (constInfo && constInfo.depth === 0 && /^-?\d+(\.\d+)?$/.test(rhs)) {
          isNumericConst = true;
          constValue = analysis.constantValues.get(constName);
        }
        if (constInfo) {
          const evalVal = analysis.constantValues.get(constName);
          if (evalVal !== undefined && !/^-?\d+(\.\d+)?$/.test(rhs)) constEvalValue = evalVal;
        }
      } else {
        const trimmed = latex.trim();
        if (findEqAtDepth0(trimmed) === -1) {
          try {
            const ast = parseLatexToAst(trimmed);
            const vars = collectVariables(ast);
            if (!vars.has('x') && !vars.has('y')) {
              const val = evaluateAst(ast, analysis.constantValues, analysis.funcDefs || new Map());
              if (isFinite(val) && !/^-?\d+(\.\d+)?$/.test(trimmed)) constEvalValue = val;
            }
          } catch (e) { /* not evaluable */ }
        }
      }
    }
  }
  colorSwatch.style.display = isGraphable ? '' : 'none';
  toggle.style.display = isGraphable ? '' : 'none';
  if (!isGraphable) toggle.setAttribute('aria-pressed', 'true');
  if (isNumericConst && constValue !== null) showSlider(constValue); else hideSlider();
  const formatted = constEvalValue !== null ? formatConstantValue(constEvalValue) : null;
  if (formatted !== null) {
    constValueSpan.textContent = formatted;
    constValueSpan.style.display = 'block';
  } else {
    constValueSpan.style.display = 'none';
  }
}

/**
 * Populates #graph-expr-list with GraphExpressionBox instances for all expressions in box.
 * @param {GraphBox} box
 */
function renderGraphExprList(box) {
  const listEl = document.getElementById('graph-expr-list');
  listEl.innerHTML = '';
  graphMqFields.clear();
  _activeGraphExprBoxes = [];

  // Ensure graphExprNextId is above all existing expression ids to avoid duplicates
  for (const expr of (box.expressions || [])) {
    const m = expr.id.match(/^ge(\d+)$/);
    if (m) graphExprNextId = Math.max(graphExprNextId, parseInt(m[1]) + 1);
  }

  for (const exprData of (box.expressions || [])) {
    const exprBox = new GraphExpressionBox(exprData);
    _activeGraphExprBoxes.push(exprBox);
    listEl.appendChild(exprBox.element);
  }

  for (const exprBox of _activeGraphExprBoxes) {
    exprBox._mqField.reflow();
    exprBox.updateControls(null);
  }
}

let _activeColorPopup = null;
let _activeColorPopupOutside = null;

function closeColorPopup() {
  if (_activeColorPopupOutside) {
    document.removeEventListener('mousedown', _activeColorPopupOutside, true);
    _activeColorPopupOutside = null;
  }
  if (_activeColorPopup) {
    _activeColorPopup.remove();
    _activeColorPopup = null;
  }
}

function closeFillColorPopup() {
  if (_activeFillColorPopup) {
    _activeFillColorPopup.remove();
    _activeFillColorPopup = null;
  }
  if (_activeFillColorPopupOutside) {
    document.removeEventListener('click', _activeFillColorPopupOutside, true);
    _activeFillColorPopupOutside = null;
  }
}

function openFillColorPopup(anchorEl, boxId) {
  closeFillColorPopup();

  const idx = boxes.findIndex(b => b.id === boxId);
  if (idx === -1) return;
  const currentColor = boxes[idx].fillColor || null;

  const popup = document.createElement('div');
  popup.className = 'fill-color-popup';
  _activeFillColorPopup = popup;

  const applyColor = (c) => {
    boxes[idx].fillColor = c;
    if (c) {
      fillColorBtn.style.background = c;
      fillColorBtn.classList.remove('no-fill');
    } else {
      fillColorBtn.style.background = '';
      fillColorBtn.classList.add('no-fill');
    }
    // Update active chip highlights within this popup
    popup.querySelectorAll('.graph-color-chip').forEach(ch => {
      ch.classList.toggle('active', ch.dataset.value === (c || ''));
    });
    syncToText();
  };

  // Default presets
  const defaultLabel = document.createElement('div');
  defaultLabel.className = 'fill-color-popup-section-label';
  defaultLabel.textContent = 'Presets';
  popup.appendChild(defaultLabel);

  const defaultPalette = document.createElement('div');
  defaultPalette.className = 'graph-color-palette';

  // Transparent / no-fill chip
  const transparentChip = document.createElement('div');
  transparentChip.className = 'graph-color-chip' + (currentColor === null ? ' active' : '');
  transparentChip.style.cssText = 'background: repeating-conic-gradient(#585b70 0% 25%, #313244 0% 50%) 0 0 / 8px 8px;';
  transparentChip.title = 'No fill';
  transparentChip.dataset.value = '';
  transparentChip.addEventListener('click', () => { applyColor(null); closeFillColorPopup(); });
  defaultPalette.appendChild(transparentChip);

  for (const c of HIGHLIGHT_FILL_COLORS) {
    const chip = document.createElement('div');
    chip.className = 'graph-color-chip' + (c === currentColor ? ' active' : '');
    chip.style.background = c;
    chip.title = c;
    chip.dataset.value = c;
    chip.addEventListener('click', () => { applyColor(c); closeFillColorPopup(); });
    defaultPalette.appendChild(chip);
  }
  popup.appendChild(defaultPalette);

  // Project custom colors: any fillColor in use across boxes that isn't a default preset
  const customColors = [...new Set(
    boxes.filter(b => b.fillColor && !HIGHLIGHT_FILL_COLORS.includes(b.fillColor)).map(b => b.fillColor)
  )];
  if (customColors.length > 0) {
    const customLabel = document.createElement('div');
    customLabel.className = 'fill-color-popup-section-label';
    customLabel.textContent = 'Project colors';
    popup.appendChild(customLabel);

    const customPalette = document.createElement('div');
    customPalette.className = 'graph-color-palette';
    for (const c of customColors) {
      const chip = document.createElement('div');
      chip.className = 'graph-color-chip' + (c === currentColor ? ' active' : '');
      chip.style.background = c;
      chip.title = c;
      chip.dataset.value = c;
      chip.addEventListener('click', () => { applyColor(c); closeFillColorPopup(); });
      customPalette.appendChild(chip);
    }
    popup.appendChild(customPalette);
  }

  // Custom color picker row
  const pickerRow = document.createElement('div');
  pickerRow.className = 'graph-color-custom';
  const pickerLabel = document.createElement('span');
  pickerLabel.textContent = 'Custom:';
  const pickerInput = document.createElement('input');
  pickerInput.type = 'color';
  pickerInput.value = currentColor || HIGHLIGHT_FILL_COLORS[0];
  pickerInput.addEventListener('input', () => applyColor(pickerInput.value));
  pickerRow.appendChild(pickerLabel);
  pickerRow.appendChild(pickerInput);
  popup.appendChild(pickerRow);

  // Prevent all clicks within the popup from stealing focus away from the box
  popup.addEventListener('mousedown', e => e.preventDefault());

  document.body.appendChild(popup);

  // Position below the anchor
  const rect = anchorEl.getBoundingClientRect();
  const popupW = 210;
  let left = rect.left;
  let top  = rect.bottom + 4;
  if (left + popupW > window.innerWidth - 8) left = window.innerWidth - popupW - 8;
  if (top + 180 > window.innerHeight - 8) top = rect.top - 180 - 4;
  popup.style.left = left + 'px';
  popup.style.top  = top + 'px';

  // Use 'click' (not 'mousedown') so the browser's internal color picker panel
  // — which fires mousedown on non-DOM elements — doesn't trigger a close.
  const onOutside = (e) => {
    if (!popup.contains(e.target) && e.target !== anchorEl) closeFillColorPopup();
  };
  _activeFillColorPopupOutside = onOutside;
  setTimeout(() => document.addEventListener('click', onOutside, true), 0);
}

function openColorPopup(anchorEl, exprId) {
  closeColorPopup();

  const row = anchorEl.closest('.expr-wrapper');
  const currentColor = row.dataset.color || '#3b82f6';
  const currentThickness = parseFloat(row.dataset.thickness) || 2.0;

  const popup = document.createElement('div');
  popup.className = 'graph-color-popup';
  _activeColorPopup = popup;

  // Preset palette
  const palette = document.createElement('div');
  palette.className = 'graph-color-palette';
  for (const c of GRAPH_COLORS) {
    const chip = document.createElement('div');
    chip.className = 'graph-color-chip' + (c === currentColor ? ' active' : '');
    chip.style.background = c;
    chip.title = c;
    chip.addEventListener('click', () => {
      row.dataset.color = c;
      anchorEl.style.background = c;
      commitGraphEditorToBox(graphModeBoxId);
      scheduleGraphRender();
      closeColorPopup();
    });
    palette.appendChild(chip);
  }
  popup.appendChild(palette);

  // Custom color picker row
  const customRow = document.createElement('div');
  customRow.className = 'graph-color-custom';
  const customLabel = document.createElement('span');
  customLabel.textContent = 'Custom:';
  const customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.value = currentColor;
  customInput.addEventListener('input', () => {
    row.dataset.color = customInput.value;
    anchorEl.style.background = customInput.value;
    // Update active chip highlights
    popup.querySelectorAll('.graph-color-chip').forEach(ch => {
      ch.classList.toggle('active', ch.title === customInput.value);
    });
    commitGraphEditorToBox(graphModeBoxId);
    scheduleGraphRender();
  });
  customRow.appendChild(customLabel);
  customRow.appendChild(customInput);
  popup.appendChild(customRow);

  // Thickness number input row
  const thickRow = document.createElement('div');
  thickRow.className = 'graph-color-thickness';
  const thickLabel = document.createElement('span');
  thickLabel.textContent = 'Thickness:';
  const thickInput = document.createElement('input');
  thickInput.type = 'number';
  thickInput.min = '0.5';
  thickInput.max = '7';
  thickInput.step = '0.5';
  thickInput.value = currentThickness;
  thickInput.addEventListener('change', () => {
    const val = Math.min(7, Math.max(0.5, parseFloat(thickInput.value) || 2.0));
    thickInput.value = val;
    row.dataset.thickness = val;
    commitGraphEditorToBox(graphModeBoxId);
    scheduleGraphRender();
  });
  thickRow.appendChild(thickLabel);
  thickRow.appendChild(thickInput);
  popup.appendChild(thickRow);

  document.body.appendChild(popup);

  // Position below the anchor
  const rect = anchorEl.getBoundingClientRect();
  const popupW = 196; // min-width + padding estimate
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + popupW > window.innerWidth - 8) left = window.innerWidth - popupW - 8;
  if (top + 160 > window.innerHeight - 8) top = rect.top - 160 - 4;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';

  // Close on outside click
  const onOutside = (e) => {
    if (!popup.contains(e.target) && e.target !== anchorEl) {
      closeColorPopup();
    }
  };
  _activeColorPopupOutside = onOutside;
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
}

function commitGraphEditorToBox(boxId) {
  if (!boxId) return;
  const idx = boxes.findIndex(b => b.id === boxId);
  if (idx === -1) return;

  // Use DOM order (drag-to-reorder changes DOM but not _activeGraphExprBoxes order)
  const wrappers = document.querySelectorAll('#graph-expr-list .expr-wrapper');
  const expressions = [];
  for (const wrapper of wrappers) {
    const exprBox = _activeGraphExprBoxes.find(e => e.id === wrapper.dataset.exprId);
    if (exprBox) expressions.push(exprBox.toData());
  }
  boxes[idx].expressions = expressions;
  boxes[idx].width  = parseInt(document.getElementById('graph-width-input').value)  || 600;
  boxes[idx].height = parseInt(document.getElementById('graph-height-input').value) || 400;

  updateGraphBoxCount(boxId);
  syncToText();
}

function updateGraphBoxCount(boxId) {
  const boxEl = boxList.querySelector(`[data-id="${boxId}"] .graph-expr-count`);
  if (!boxEl) return;
  const box = boxes.find(b => b.id === boxId);
  const n = box ? (box.expressions || []).length : 0;
  boxEl.textContent = `${n} expression${n !== 1 ? 's' : ''}`;
}

function addGraphExpression() {
  if (!graphModeBoxId) return;
  const exprBox = new GraphExpressionBox({
    id: 'ge' + (graphExprNextId++), latex: '', color: nextGraphColor(), enabled: true, thickness: 2.0,
  });
  _activeGraphExprBoxes.push(exprBox);
  document.getElementById('graph-expr-list').appendChild(exprBox.element);
  exprBox._mqField.reflow();
  commitGraphEditorToBox(graphModeBoxId);
  setTimeout(() => exprBox._mqField.focus(), 0);
}

function addGraphExpressionAfter(afterId) {
  if (!graphModeBoxId) return;
  clearTimeout(graphCommitTimer);
  commitGraphEditorToBox(graphModeBoxId);

  const exprBox = new GraphExpressionBox({
    id: 'ge' + (graphExprNextId++), latex: '', color: nextGraphColor(), enabled: true, thickness: 2.0,
  });

  const listEl = document.getElementById('graph-expr-list');
  const afterWrapper = listEl.querySelector(`.expr-wrapper[data-expr-id="${afterId}"]`);
  if (afterWrapper) {
    listEl.insertBefore(exprBox.element, afterWrapper.nextSibling);
    const afterIdx = _activeGraphExprBoxes.findIndex(e => e.id === afterId);
    _activeGraphExprBoxes.splice(afterIdx !== -1 ? afterIdx + 1 : _activeGraphExprBoxes.length, 0, exprBox);
  } else {
    listEl.appendChild(exprBox.element);
    _activeGraphExprBoxes.push(exprBox);
  }

  exprBox._mqField.reflow();
  commitGraphEditorToBox(graphModeBoxId);
  syncToText();
  setTimeout(() => exprBox._mqField.focus(), 0);
}

// Wire up graph editor panel buttons
document.getElementById('graph-done-btn').addEventListener('click', exitGraphMode);
document.getElementById('graph-add-expr-btn').addEventListener('mousedown', e => e.preventDefault());
document.getElementById('graph-add-expr-btn').addEventListener('click', addGraphExpression);

document.getElementById('graph-width-input').addEventListener('change', () => {
  if (graphModeBoxId) { commitGraphEditorToBox(graphModeBoxId); updateGraphCropOverlay(); }
});
document.getElementById('graph-height-input').addEventListener('change', () => {
  if (graphModeBoxId) { commitGraphEditorToBox(graphModeBoxId); updateGraphCropOverlay(); }
});

document.getElementById('graph-crop-checkbox').addEventListener('change', e => {
  showGraphCropRect = e.target.checked;
  updateGraphCropOverlay();
});

'use strict';

// ── Graph expression box factory ──────────────────────────────────────────────

/**
 * Creates an ExpressionBox configured for use in the graph editor.
 * Uses ExpressionBox (from calcbox.js) with graph-mode opts; no separate class needed.
 * @param {{ id?: string, latex?: string, enabled?: boolean, color?: string, thickness?: number, sliderMin?: number, sliderMax?: number }} exprData
 * @returns {ExpressionBox}
 */
function _createGraphExprBox(exprData) {
    let exprBox; // captured by closure so onEnter can reference the box id after construction
    const opts = {
        fieldMap: graphMqFields,
        listEl:   document.getElementById('graph-expr-list'),
        color:     exprData.color     || '#3b82f6',
        thickness: exprData.thickness ?? 2.0,
        //Claude: please do not touch the greek letters. There are some I dont want (like psi) because they interfere with others (you can spell epsilon without psi for example)
        autoCommands: 'sqrt sum int prod infty partial leq geq neq alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega',
        onEdit:   () => { commitGraphEditorToBox(graphModeBoxId); scheduleGraphRender(); },
        onEnter:  () => addGraphExpressionAfter(exprBox.id),
        onToggle: () => { commitGraphEditorToBox(graphModeBoxId); scheduleGraphRender(); },
        onDeleteCallback: (id) => {
            const i = _activeGraphExprBoxes.findIndex(e => e.id === id);
            if (i !== -1) _activeGraphExprBoxes.splice(i, 1);
            updateGraphBoxCount(graphModeBoxId);
            commitGraphEditorToBox(graphModeBoxId);
            scheduleGraphRender();
            syncToText();
        },
        onReorder: () => { commitGraphEditorToBox(graphModeBoxId); scheduleGraphRender(); },
        onFocusIn:  (id) => { if (focusedGraphExprId !== id) { focusedGraphExprId = id; scheduleGraphRender(); } },
        onFocusOut: (id) => {
            const leavingId = id;
            setTimeout(() => {
                if (focusedGraphExprId === leavingId) { focusedGraphExprId = null; scheduleGraphRender(); }
            }, 0);
        },
    };
    exprBox = new ExpressionBox(exprData, opts);

    // t-range row: shown only when the expression is classified as parametric
    const tRow = document.createElement('div');
    tRow.className = 't-range-row';
    tRow.style.display = 'none';

    const tMinInput = document.createElement('input');
    tMinInput.type = 'number'; tMinInput.step = 'any'; tMinInput.className = 't-range-input';
    tMinInput.value = exprData.tMin ?? 0;

    const tLabel = document.createElement('span');
    tLabel.className = 't-range-label';
    tLabel.textContent = ' ≤ t ≤ ';

    const tMaxInput = document.createElement('input');
    tMaxInput.type = 'number'; tMaxInput.step = 'any'; tMaxInput.className = 't-range-input';
    tMaxInput.value = exprData.tMax ?? 1;

    tRow.appendChild(tMinInput);
    tRow.appendChild(tLabel);
    tRow.appendChild(tMaxInput);

    // Store current values in the wrapper dataset so toData() can read them
    const wrapper = exprBox.element;
    wrapper.dataset.tMin = exprData.tMin ?? 0;
    wrapper.dataset.tMax = exprData.tMax ?? 1;

    const onTRangeChange = () => {
        wrapper.dataset.tMin = tMinInput.value;
        wrapper.dataset.tMax = tMaxInput.value;
        commitGraphEditorToBox(graphModeBoxId);
        scheduleGraphRender();
    };
    tMinInput.addEventListener('change', onTRangeChange);
    tMaxInput.addEventListener('change', onTRangeChange);
    // Prevent mouse interactions from bubbling to graph pan/zoom handlers
    tMinInput.addEventListener('mousedown', e => e.stopPropagation());
    tMaxInput.addEventListener('mousedown', e => e.stopPropagation());

    exprBox.element.appendChild(tRow);
    return exprBox;
}

/**
 * Update t-range row visibility and dataset for each active expression box.
 * Called after each render so the UI reflects the current classification.
 * @param {object|null} analysis - The analysis result from the last updateExpressions call
 */
function _syncExprBoxMeta(analysis) {
    if (!analysis) return;
    const parametricIds = new Set((analysis.parametrics || []).map(p => p.exprId));
    for (const exprBox of _activeGraphExprBoxes) {
        const tRow = exprBox.element.querySelector('.t-range-row');
        if (!tRow) continue;
        const isParametric = parametricIds.has(exprBox.id);
        tRow.style.display = isParametric ? '' : 'none';
    }

    // Set point-related dataset attributes (kind and isDraggableEligible) on each wrapper.
    // Used by openColorPopup to decide which controls to show.
    const pointMap = new Map();
    for (const e of (graphRenderer ? (graphRenderer._compiledExprs || []) : [])) {
        if (e.kind === 'point') pointMap.set(e.exprId, e);
    }
    for (const exprBox of _activeGraphExprBoxes) {
        const pt = pointMap.get(exprBox.id);
        // 'kind' distinguishes point expressions from curve/graph expressions
        exprBox.element.dataset.kind = pt ? 'point' : 'graph';
        // 'isDraggableEligible' is true only for named literal points like a=(1,2)
        exprBox.element.dataset.isDraggableEligible = (pt && pt.varName != null) ? '1' : '0';
    }
}

// ── Graph settings row ───────────────────────────────────────────────────────

/**
 * Populates #graph-settings-row with calc-mode toggle buttons for the given graph box.
 * Mirrors the CalcBox toolbar. Cleared and rebuilt each time enterGraphMode() is called.
 * @param {GraphBox} box
 */
function _renderGraphSettingsRow(box) {
  const row = document.getElementById('graph-settings-row');
  row.innerHTML = '';

  /** @param {string} label @param {string} title @param {string} flagKey */
  const makeToggle = (label, title, flagKey) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'calc-show-results-btn' + (box[flagKey] ? ' active' : '');
    btn.title = title;
    btn.textContent = label;
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      const idx = boxes.findIndex(b => b.id === graphModeBoxId);
      if (idx === -1) return;
      boxes[idx][flagKey] = !boxes[idx][flagKey];
      btn.classList.toggle('active', boxes[idx][flagKey]);
      // Symbolic and Base Units only make sense with units mode
      if (flagKey === 'useUnits') {
        symbolicBtn.disabled = !boxes[idx].useUnits;
        symbolicBtn.classList.toggle('btn-disabled', !boxes[idx].useUnits);
        baseUnitsBtn.disabled = !boxes[idx].useUnits;
        baseUnitsBtn.classList.toggle('btn-disabled', !boxes[idx].useUnits);
      }
      syncToText();
      scheduleGraphRender();
    });
    return btn;
  };

  row.appendChild(makeToggle('Physics', 'Basic physics constants (c, G, h, …)', 'physicsBasic'));
  row.appendChild(makeToggle('E&M',     'Electromagnetic constants (ε₀, μ₀, …)',  'physicsEM'));
  row.appendChild(makeToggle('Chem',    'Chemistry constants (Nₐ, R, …)',          'physicsChem'));

  const unitsBtn   = makeToggle('Units',      'SI units mode', 'useUnits');
  const symbolicBtn = makeToggle('Symbolic',  'Symbolic mode (only with units)',  'useSymbolic');
  const baseUnitsBtn = makeToggle('Base Units', 'Expand to SI base units',        'useBaseUnits');

  // Disable symbolic/base-units when units mode is off
  if (!box.useUnits) {
    symbolicBtn.disabled = true;   symbolicBtn.classList.add('btn-disabled');
    baseUnitsBtn.disabled = true;  baseUnitsBtn.classList.add('btn-disabled');
  }

  row.appendChild(unitsBtn);
  row.appendChild(symbolicBtn);
  row.appendChild(baseUnitsBtn);

  // Sig figs input
  const sfLabel = document.createElement('label');
  sfLabel.className = 'calc-sigfigs-label';
  sfLabel.textContent = 'sf:';
  const sfInput = document.createElement('input');
  sfInput.type = 'number';
  sfInput.className = 'calc-sigfigs-input';
  sfInput.min = 1; sfInput.max = 15;
  sfInput.value = box.sigFigs ?? 6;
  sfInput.title = 'Significant figures for numeric results';
  sfInput.addEventListener('mousedown', e => e.stopPropagation());
  sfInput.addEventListener('change', () => {
    const idx = boxes.findIndex(b => b.id === graphModeBoxId);
    if (idx === -1) return;
    const v = parseInt(sfInput.value, 10);
    if (!isNaN(v) && v >= 1 && v <= 15) {
      boxes[idx].sigFigs = v;
      syncToText();
      scheduleGraphRender();
    } else {
      sfInput.value = boxes[idx].sigFigs ?? 6;
    }
  });
  sfLabel.appendChild(sfInput);
  row.appendChild(sfLabel);
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

  // Populate calc settings row
  _renderGraphSettingsRow(box);

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

  // Drag callback: called by the renderer on every mousemove while dragging a point.
  // Updates the compiled position directly for smooth visuals; defers MQ field update to drag end.
  renderer._onPointDrag = (exprId, varName, newX, newY) => {
    renderer._updatePointPosition(exprId, newX, newY);
    // Update stored expression data so the next recompile uses the latest position
    const fmt = v => parseFloat(v.toPrecision(5)).toString();
    const newLatex = varName
      ? `${varName}=\\left(${fmt(newX)},${fmt(newY)}\\right)`
      : `\\left(${fmt(newX)},${fmt(newY)}\\right)`;
    const box = boxes.find(b => b.id === graphModeBoxId);
    if (box) {
      const exprData = box.expressions.find(e => e.id === exprId);
      if (exprData) exprData.latex = newLatex;
    }
    scheduleGraphRender();
  };

  // Drag-end callback: fires once on mouseup after a point drag.
  // Updates the MQ field to match the final position, then triggers a full recompile.
  renderer._onPointDragEnd = (exprId, varName, finalX, finalY) => {
    const fmt = v => parseFloat(v.toPrecision(5)).toString();
    const finalLatex = varName
      ? `${varName}=\\left(${fmt(finalX)},${fmt(finalY)}\\right)`
      : `\\left(${fmt(finalX)},${fmt(finalY)}\\right)`;
    const field = graphMqFields.get(exprId);
    if (field) field.latex(finalLatex);
    scheduleGraphRender();
  };

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
  if (graphRenderer) { graphRenderer._onRender = null; graphRenderer._onPick = null; graphRenderer._onSnapUpdate = null; graphRenderer._onBackgroundClick = null; graphRenderer._onPointDrag = null; graphRenderer._onPointDragEnd = null; }
  graphMqFields.clear();
  _activeGraphExprBoxes = [];
  focusedGraphExprId = null;
  closeColorPopup();
  document.getElementById('graph-expr-list').innerHTML = '';
  document.getElementById('graph-settings-row').innerHTML = '';
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
 * Populates #graph-expr-list with ExpressionBox instances (graph mode) for all expressions in box.
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
    const exprBox = _createGraphExprBox(exprData);
    _activeGraphExprBoxes.push(exprBox);
    listEl.appendChild(exprBox.element);
  }

  for (const exprBox of _activeGraphExprBoxes) {
    exprBox._mqField.reflow();
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
  const currentPointSize = parseFloat(row.dataset.pointSize) || 8.0;
  const isDraggable = row.dataset.draggable === '1';
  const isPointExpr = row.dataset.kind === 'point';
  const isDraggableEligible = row.dataset.isDraggableEligible === '1';

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

  if (isPointExpr) {
    // Point size row — replaces thickness for point expressions
    const sizeRow = document.createElement('div');
    sizeRow.className = 'graph-color-thickness';
    const sizeLabel = document.createElement('span');
    sizeLabel.textContent = 'Point size:';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.min = '2';
    sizeInput.max = '40';
    sizeInput.step = '1';
    sizeInput.value = currentPointSize;
    sizeInput.addEventListener('change', () => {
      const val = Math.min(40, Math.max(2, parseFloat(sizeInput.value) || 8.0));
      sizeInput.value = val;
      row.dataset.pointSize = val;
      commitGraphEditorToBox(graphModeBoxId);
      scheduleGraphRender();
    });
    sizeRow.appendChild(sizeLabel);
    sizeRow.appendChild(sizeInput);
    popup.appendChild(sizeRow);

    // Draggable checkbox — only shown for named literal points like a=(1,2)
    if (isDraggableEligible) {
      const dragRow = document.createElement('div');
      dragRow.className = 'graph-color-thickness';
      const dragLabel = document.createElement('label');
      dragLabel.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;';
      const dragCheck = document.createElement('input');
      dragCheck.type = 'checkbox';
      dragCheck.checked = isDraggable;
      const dragText = document.createElement('span');
      dragText.textContent = 'Draggable';
      dragLabel.appendChild(dragCheck);
      dragLabel.appendChild(dragText);
      dragCheck.addEventListener('change', () => {
        row.dataset.draggable = dragCheck.checked ? '1' : '0';
        commitGraphEditorToBox(graphModeBoxId);
        scheduleGraphRender();
      });
      dragRow.appendChild(dragLabel);
      popup.appendChild(dragRow);
    }
  } else {
    // Thickness number input row — for curve/graph expressions
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
  }

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
  const exprBox = _createGraphExprBox({
    id: 'ge' + (graphExprNextId++), latex: '', color: nextGraphColor(), enabled: true, thickness: 2.0, tMin: 0, tMax: 1,
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

  const exprBox = _createGraphExprBox({
    id: 'ge' + (graphExprNextId++), latex: '', color: nextGraphColor(), enabled: true, thickness: 2.0, tMin: 0, tMax: 1,
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

'use strict';

// ── MathQuill setup ──────────────────────────────────────────────────────────
const MQ = MathQuill.getInterface(2);

// ── State ────────────────────────────────────────────────────────────────────
let boxes = [];           // [{ id, type: 'math'|'text'|'h1'|'h2'|'h3', content }]
let mqFields = new Map(); // id → MathQuill field instance
let boxResizers = new Map(); // id → resize function (called on panel width change)
let nextId = 1;
let suppressTextSync = false; // prevent feedback loops
let suppressBoxSync  = false;
let textSyncTimer = null;
let previewTimer = null;
let focusedBoxId = null;
let boxClipboard = null; // { type, content } — box-level cut/paste
let dragSrcBoxId = null; // id of box being dragged

// ── Default box type ─────────────────────────────────────────────────────────
let defaultBoxType = 'math';

// ── Preview state ────────────────────────────────────────────────────────────
let isPreviewOpen = false;
let previewScrollTop = 0; // cached scroll position, updated via scroll event (avoids forced reflow at render time)
// Cache of already-MathJax-rendered elements, keyed by box id.
// Each entry: { key: string, el: HTMLElement } where key encodes the box
// state that affects rendering. A cache hit means we can reuse the element
// as-is without calling typesetPromise again.
const previewBoxCache = new Map();
const ZOOM_STEPS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200];
let previewZoomIndex = 4; // 100%

// ── Project state ────────────────────────────────────────────────────────────
const PROJ_KEY     = 'mathnotepad_projects';
const DRAFT_KEY          = 'mathnotepad_draft';
const UI_STATE_KEY       = 'mathnotepad_ui';
const WORKSPACE_KEY      = '__workspace__';      // IDB key for the single global workspace handle
const WORKSPACE_NAME_KEY = 'mathnotepad_workspace_name'; // localStorage key for workspace display name
let currentProjectId = null;
let currentWorkspaceHandle = null; // FileSystemDirectoryHandle for the single global workspace folder
let isDirty = false;

// ── Graph mode ───────────────────────────────────────────────────────────────
let graphModeBoxId = null;        // id of box being edited in graph mode, or null
let focusedGraphExprId = null;    // id of the expression row currently focused
let graphExprNextId = 1;
let graphMqFields = new Map();    // expr id → MathQuill field
let graphExprUpdateFns = new Map(); // expr id → () => void, refreshes that row's badges
let graphSliderFns = new Map();   // expr id → { showSlider, hideSlider }
let graphCommitTimer = null;
let draftSaveTimer = null;

// ── Image box state ───────────────────────────────────────────────────────────
let imageDb = null;                       // IndexedDB handle
const imageObjectUrls = new Map();        // boxId → blob object URL (revoke on box delete)

// ── Calc box state ────────────────────────────────────────────────────────────
let calcExprNextId = 1;
let calcTextNextId = 1;
// let calcMqFields = new Map();       // boxId → Map<exprId, MQField>
let calcTextAreaMap = new Map();    // boxId → Map<exprId, HTMLTextAreaElement>
let calcAddExprFns = new Map();     // boxId → (afterExprId?: string) => void
let calcAddTextFns = new Map();     // boxId → (afterExprId?: string) => void
let calcPendingUpdate = new Set();  // boxIds with a pending rAF update

const GRAPH_RENDER_DEBOUNCE_MS = 300; // debounce delay (ms) between typing in a graph expression and re-rendering
const PREVIEW_DEBOUNCE_MS = 400;      // debounce delay (ms) between editing a box and re-rendering the preview
const DRAFT_SAVE_DEBOUNCE_MS = 1000;  // debounce delay (ms) for auto-saving the draft to localStorage

const GRAPH_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#eab308', '#06b6d4'];
let graphColorIdx = 0;
function nextGraphColor() { return GRAPH_COLORS[graphColorIdx++ % GRAPH_COLORS.length]; }

// ── Highlight fill colors ─────────────────────────────────────────────────────
// Add new default colors here, or extend the list per-project via custom colors.
const HIGHLIGHT_FILL_COLORS = ['#fff9bf', '#ffbfbf', '#ceffbf', '#c3bfff', '#ffbff3'];
let _activeFillColorPopup = null;
let _activeFillColorPopupOutside = null;

function formatConstantValue(v, sigFigs = 6) {
  if (!isFinite(v)) return null;
  if (Number.isInteger(v) && Math.abs(v) < 10000) return '= ' + v;
  return '≈ ' + _astNumStr(v, sigFigs);
}

/**
 * Focus an expression row's MathQuill field by its id.
 * Shared by graph editor and calc box row navigation.
 * @param {Map<string, Object>} fieldMap - Map from exprId to MQ field.
 * @param {string} exprId - The expression ID to focus.
 */
function focusExprRowById(fieldMap, exprId) {
  const field = fieldMap.get(exprId);
  if (field) setTimeout(() => field.focus(), 0);
}

/**
 * Creates a slider section (range input + min/max inputs) below an expression wrapper.
 * Used by both graph expression rows and calc expression rows for numeric constant assignments.
 * @param {HTMLElement} wrapper - The .expr-wrapper element to append the slider row to.
 * @param {Object} expr - Expression data ({ sliderMin?, sliderMax? }).
 * @param {Object} opts
 * @param {() => string} opts.getLatex - Returns current MQ field latex.
 * @param {(str: string) => void} opts.setLatex - Sets MQ field value and triggers commit+update.
 * @param {() => void} opts.onBoundsCommit - Called when slider bounds change (persist bounds without re-render).
 * @returns {{ showSlider: (val: number) => void, hideSlider: () => void }}
 */
function createSliderSection(wrapper, expr, { getLatex, setLatex, onBoundsCommit }) {
  const initMin = expr.sliderMin != null ? expr.sliderMin : 0;
  const initMax = expr.sliderMax != null ? expr.sliderMax : 10;

  wrapper.dataset.sliderMin = initMin;
  wrapper.dataset.sliderMax = initMax;

  const sliderRow = document.createElement('div');
  sliderRow.className = 'graph-expr-slider-row';
  sliderRow.style.display = 'none';

  const minInput = document.createElement('input');
  minInput.type = 'number';
  minInput.className = 'graph-expr-slider-min';
  minInput.title = 'Min';
  minInput.value = initMin;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'graph-expr-slider';
  slider.step = 'any';
  slider.min = initMin;
  slider.max = initMax;

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.className = 'graph-expr-slider-max';
  maxInput.title = 'Max';
  maxInput.value = initMax;

  sliderRow.appendChild(minInput);
  sliderRow.appendChild(slider);
  sliderRow.appendChild(maxInput);
  wrapper.appendChild(sliderRow);

  let sliderDragging = false;

  function applySliderValue(val) {
    const currentLatex = getLatex();
    const nameMatch = currentLatex.match(/^([a-zA-Z]\w*)\s*=/);
    if (!nameMatch) return;
    const rounded = parseFloat(val.toPrecision(6));
    // setLatex sets the field AND commits+schedules update
    setLatex(`${nameMatch[1]}=${rounded}`);
  }

  slider.addEventListener('mousedown', () => { sliderDragging = true; });
  slider.addEventListener('mouseup',   () => { sliderDragging = false; });
  slider.addEventListener('touchstart', () => { sliderDragging = true; }, { passive: true });
  slider.addEventListener('touchend',   () => { sliderDragging = false; });
  slider.addEventListener('input', () => applySliderValue(parseFloat(slider.value)));

  minInput.addEventListener('change', () => {
    const min = parseFloat(minInput.value);
    if (isNaN(min)) return;
    slider.min = min;
    wrapper.dataset.sliderMin = min;
    onBoundsCommit();
  });

  maxInput.addEventListener('change', () => {
    const max = parseFloat(maxInput.value);
    if (isNaN(max)) return;
    slider.max = max;
    wrapper.dataset.sliderMax = max;
    onBoundsCommit();
  });

  return {
    /** Show the slider and set its current value. Does not update bounds. */
    showSlider(val) {
      sliderRow.style.display = '';
      if (!sliderDragging) slider.value = val;
    },
    hideSlider() {
      sliderRow.style.display = 'none';
    },
  };
}

function buildPhysicsTooltip(group, label) {
  const lines = group.map(pc => `${pc.label}: ${pc.description}`);
  return `Toggle ${label} constants\n\n` + lines.join('\n');
}

let graphRenderer = null; // lazily created GraphRenderer
let graphRenderPending = false;
let showGraphCropRect = false;
function getGraphRenderer() {
  if (!graphRenderer) graphRenderer = new GraphRenderer();
  return graphRenderer;
}

/** Compile all expressions for the active graph box and re-render. */
function renderGraphPreview() {
  if (!graphModeBoxId) return;
  const box = boxes.find(b => b.id === graphModeBoxId);
  if (!box) return;

  const renderer = getGraphRenderer();
  const errors = renderer.updateExpressions(box.expressions || []);
  updateGraphExprErrors(errors);

  const container = document.getElementById('preview-content');
  const w = container.clientWidth  || box.width  || 600;
  const h = container.clientHeight || box.height || 400;

  renderer.render(w, h, !!box.lightTheme, focusedGraphExprId);
  updateGraphCropOverlay();

  // Refresh expression row badges using the already-compiled analysis — avoids recompiling per frame.
  // Pass null if no analysis is cached yet so each fn falls back to its own recompile.
  const cachedAnalysis = renderer._lastAnalysis || null;
  for (const fn of graphExprUpdateFns.values()) fn(cachedAnalysis);
}

/** Update error indicators on graph expression rows. */
function updateGraphExprErrors(errors) {
  const wrappers = document.querySelectorAll('#graph-expr-list .expr-wrapper');
  for (const wrapper of wrappers) {
    const exprId = wrapper.dataset.exprId;
    const errorMsg = errors.get(exprId);
    let errorEl = wrapper.querySelector('.graph-expr-error');
    if (errorMsg) {
      if (!errorEl) {
        errorEl = document.createElement('span');
        errorEl.className = 'graph-expr-error';
        wrapper.appendChild(errorEl);
      }
      errorEl.textContent = errorMsg;
      errorEl.title = errorMsg;
      wrapper.classList.add('has-error');
    } else {
      if (errorEl) errorEl.remove();
      wrapper.classList.remove('has-error');
    }
  }
}

function scheduleGraphRender() {
  if (graphRenderPending) return;
  graphRenderPending = true;
  requestAnimationFrame(() => {
    graphRenderPending = false;
    renderGraphPreview();
  });
}

/**
 * Compute the crop rect (canvas pixels) and world-coordinate bounds for the
 * document output, given the current preview canvas size and box dimensions.
 *
 * The limiting dimension switches based on aspect ratio so the crop rect
 * always fits within the canvas:
 *   - X-limited (box is wider/shorter): fill full canvas width, center vertically
 *   - Y-limited (box is taller/narrower): fill full canvas height, center horizontally
 */
function getGraphCropInfo(box) {
  const container = document.getElementById('preview-content');
  const canvasW = container.clientWidth  || 1;
  const canvasH = container.clientHeight || 1;
  const boxW = box.width  || 600;
  const boxH = box.height || 400;

  const renderer = graphRenderer;
  const xRange   = renderer.xMax - renderer.xMin;
  const xCenter  = (renderer.xMin + renderer.xMax) / 2;
  const yCenter  = (renderer.yMin + renderer.yMax) / 2;

  // Canvas Y half-range (world units)
  const canvasYHalf = xRange * (canvasH / canvasW) * 0.5;

  let left, top, width, height;   // pixel rect
  let worldXMin, worldXMax, worldYMin, worldYMax;

  if (boxH / boxW <= canvasH / canvasW) {
    // X-limited: box is wider/shorter than the canvas → fill full width
    const cropYHalf = xRange * (boxH / boxW) * 0.5;
    width  = canvasW;
    height = canvasW * boxH / boxW;
    left   = 0;
    top    = (canvasH - height) / 2;

    worldXMin = renderer.xMin;
    worldXMax = renderer.xMax;
    worldYMin = yCenter - cropYHalf;
    worldYMax = yCenter + cropYHalf;
  } else {
    // Y-limited: box is taller/narrower than the canvas → fill full height
    width  = canvasH * boxW / boxH;
    height = canvasH;
    left   = (canvasW - width) / 2;
    top    = 0;

    const cropXHalf = canvasYHalf * (boxW / boxH);
    worldXMin = xCenter - cropXHalf;
    worldXMax = xCenter + cropXHalf;
    worldYMin = yCenter - canvasYHalf;
    worldYMax = yCenter + canvasYHalf;
  }

  return { left, top, width, height, worldXMin, worldXMax, worldYMin, worldYMax };
}

/** Draw (or hide) the crop rectangle overlay on the graph canvas. */
function updateGraphCropOverlay() {
  const container = document.getElementById('preview-content');
  let overlay = document.getElementById('graph-crop-overlay');

  if (!showGraphCropRect || !graphModeBoxId || !graphRenderer) {
    if (overlay) overlay.remove();
    return;
  }

  const box = boxes.find(b => b.id === graphModeBoxId);
  if (!box) { if (overlay) overlay.remove(); return; }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'graph-crop-overlay';
    container.appendChild(overlay);
  }

  const { left, top, width, height } = getGraphCropInfo(box);

  overlay.style.left   = Math.round(left)   + 'px';
  overlay.style.top    = Math.round(top)     + 'px';
  overlay.style.width  = Math.round(width)   + 'px';
  overlay.style.height = Math.round(height)  + 'px';
  // Clear right/bottom so explicit width/height drives the size
  overlay.style.right  = '';
  overlay.style.bottom = '';
}

// ── Undo history ──────────────────────────────────────────────────────────────
const MAX_HISTORY = 200;
let history = [];      // array of { latex, focusId } snapshots
let historyIndex = -1; // points to current state in history
let suppressHistory = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const boxList       = document.getElementById('box-list');
const latexSource   = document.getElementById('latex-source');
const lineNumbers         = document.getElementById('line-numbers');
const sourceLineHighlight = document.getElementById('source-line-highlight');
const addMathBtn    = document.getElementById('add-math-btn');
const addTextBtn    = document.getElementById('add-text-btn');
const addH1Btn      = document.getElementById('add-h1-btn');
const addH2Btn      = document.getElementById('add-h2-btn');
const addH3Btn      = document.getElementById('add-h3-btn');
const addBreakBtn   = document.getElementById('add-break-btn');
const defaultMathBtn = document.getElementById('default-math-btn');
const defaultTextBtn = document.getElementById('default-text-btn');
const fontDecBtn  = document.getElementById('font-dec-btn');
const fontIncBtn  = document.getElementById('font-inc-btn');
const fontSizeLabel     = document.getElementById('font-size-label');
const projectsBtn       = document.getElementById('projects-btn');
const closeProjectsBtn  = document.getElementById('close-projects-btn');
const projectsPanel     = document.getElementById('projects-panel');
const projectsOverlay   = document.getElementById('projects-overlay');
const projectsList      = document.getElementById('projects-list');
const saveBtn           = document.getElementById('save-btn');
const downloadBtn       = document.getElementById('download-btn');
const projectTitleLabel = document.getElementById('project-title-label');
const previewPanel      = document.getElementById('preview-panel');
const divider2          = document.getElementById('divider2');
const previewContent    = document.getElementById('preview-content');
const togglePreviewBtn  = document.getElementById('toggle-preview-btn');
const downloadPdfBtn    = document.getElementById('download-pdf-btn');
const previewZoomInBtn  = document.getElementById('preview-zoom-in-btn');
const previewZoomOutBtn = document.getElementById('preview-zoom-out-btn');
const previewZoomLabel  = document.getElementById('preview-zoom-label');
const highlightBtn      = document.getElementById('highlight-btn');
const fillColorBtn      = document.getElementById('fill-color-btn');

// ── Debug logging ─────────────────────────────────────────────────────────────
// Enable via: window.startDebug()   Dump via: window.dumpDebugLog()
// Each entry: { t, seq, event, data, stack }
const _dbgBuf = [];
const _DBG_MAX = 800;
let   _dbgSeq = 0;
let   _dbgInRebuild = false; // reentrancy guard for rebuildBoxList/diffAndApply

/**
 * Appends an event to the circular debug buffer and logs it to the console.
 * @param {string} event - Short event name.
 * @param {Object} [data] - Arbitrary key/value payload.
 */
function _dbg(event, data = {}) {
  if (!window.DEBUG_BOXES) return;
  // Capture 3 frames above _dbg itself for a useful call site.
  const raw = new Error().stack.split('\n').slice(2, 5).map(s => s.trim());
  const entry = { t: Date.now(), seq: _dbgSeq++, event, data, stack: raw };
  _dbgBuf.push(entry);
  if (_dbgBuf.length > _DBG_MAX) _dbgBuf.shift();
  console.log(`[DBG #${entry.seq}] ${event}`, data);
}

/**
 * Snapshot DOM children IDs vs boxes[] and warn on discrepancies.
 * @param {string} where - Label for the call site shown in warnings.
 */
function _dbgDomCheck(where) {
  if (!window.DEBUG_BOXES) return;
  const domIds  = [...boxList.children].map(el => el.dataset.id);
  const boxIds  = boxes.map(b => b.id);
  const dupes   = domIds.filter((id, i) => domIds.indexOf(id) !== i);
  const orphans = domIds.filter(id => !boxIds.includes(id));
  const missing = boxIds.filter(id => !domIds.includes(id));
  const ok = !dupes.length && !orphans.length && !missing.length;
  _dbg('DOM_CHECK', { where, ok, domLen: domIds.length, boxLen: boxIds.length,
                      dupes, orphans, missing, domIds, boxIds });
  if (!ok) console.warn(`[DBG DOM VIOLATION] at "${where}"`, { dupes, orphans, missing });
}

// MutationObserver: fires on every direct child change of #box-list
const _dbgObserver = new MutationObserver(mutations => {
  if (!window.DEBUG_BOXES) return;
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1 && node.classList?.contains('box')) {
        _dbg('MUT_BOX_ADDED', { id: node.dataset.id, domLen: boxList.children.length,
                                 inRebuild: _dbgInRebuild });
      }
    }
    for (const node of m.removedNodes) {
      if (node.nodeType === 1 && node.classList?.contains('box')) {
        _dbg('MUT_BOX_REMOVED', { id: node.dataset.id, domLen: boxList.children.length,
                                   inRebuild: _dbgInRebuild });
      }
    }
  }
});
_dbgObserver.observe(boxList, { childList: true });

/** Start debug logging. */
window.startDebug = () => {
  window.DEBUG_BOXES = true;
  _dbgBuf.length = 0;
  _dbgSeq = 0;
  console.log('%c[DEBUG] Box debug logging started. Use window.dumpDebugLog() to view.',
              'color: lime; font-weight: bold');
};

/** Print and return the full debug log. */
window.dumpDebugLog = () => {
  console.group('=== BOX DEBUG LOG ===');
  _dbgBuf.forEach(e => {
    const badge = e.event.includes('VIOLATION') || e.event.includes('ERROR')
      ? `%c[#${e.seq}] ${e.event}`
      : `[#${e.seq}] ${e.event}`;
    const style = 'color: red; font-weight: bold';
    if (badge.startsWith('%c')) console.log(badge, style, e.data);
    else                        console.log(badge, e.data);
  });
  console.groupEnd();
  return _dbgBuf;
};

/** Snapshot current DOM vs boxes[] state without logging. */
window.checkBoxState = () => {
  const domIds = [...boxList.children].map(el => el.dataset.id);
  const boxIds = boxes.map(b => b.id);
  console.table(boxes.map((b, i) => ({
    i, id: b.id, type: b.type, domId: domIds[i] ?? '(none)',
    match: domIds[i] === b.id ? '✓' : '✗'
  })));
  if (domIds.length !== boxIds.length)
    console.warn('DOM child count', domIds.length, '≠ boxes.length', boxIds.length);
  return { domIds, boxIds };
};



// ── Serialization ─────────────────────────────────────────────────────────────
function serializeToLatex(boxArray) {
  return boxArray.map(b => {
    let serialized;
    if (b.type === 'math') serialized = `\\[${b.content}\\]`;
    else if (b.type === 'h1') serialized = `\\section{${b.content}}`;
    else if (b.type === 'h2') serialized = `\\subsection{${b.content}}`;
    else if (b.type === 'h3') serialized = `\\subsubsection{${b.content}}`;
    else if (b.type === 'pagebreak') serialized = '\\newpage';
    else if (b.type === 'calc') {
      const exprLines = (b.expressions || []).map(e => {
        // Use toData() to read live values from ExpressionBox/CalcTextRow instances
        const d = e.toData ? e.toData() : e;
        if (d.type === 'text') {
          // Encode backslashes then newlines so the format stays single-line
          const encoded = (d.text || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
          return `% ${d.id} text ${encoded}`;
        }
        // Only serialize custom slider bounds (non-default) to keep format compact
        const hasCustomSlider = d.sliderMin != null && (d.sliderMin !== 0 || (d.sliderMax ?? 10) !== 10);
        const sliderPart = hasCustomSlider ? ` {s:${d.sliderMin}:${d.sliderMax ?? 10}}` : '';
        return `% ${d.id} ${d.enabled ? 'on' : 'off'}${sliderPart} ${d.latex}`;
      });
      const defsFlag     = b.showResultsDefs !== false ? '{showdefs}' : '';
      const bareFlag     = b.showResultsBare !== false ? '{showbare}' : '';
      const basicFlag    = b.physicsBasic ? '{physics_basic}' : '';
      const emFlag       = b.physicsEM    ? '{physics_em}'    : '';
      const chemFlag     = b.physicsChem  ? '{physics_chem}'  : '';
      const unitsFlag      = b.useUnits     ? '{units}'      : '';
      const symbolicFlag   = b.useSymbolic  ? '{symbolic}'   : '';
      const baseUnitsFlag  = b.useBaseUnits ? '{baseunits}'  : '';
      const hiddenFlag     = b.hidden       ? '{hidden}'     : '';
      const collapsedFlag  = b.collapsed    ? '{collapsed}'  : '';
      const sfVal        = b.sigFigs ?? 6;
      const sfFlag       = sfVal !== 6 ? `{sf=${sfVal}}` : '';
      serialized = `\\begin{calc}${defsFlag}${bareFlag}${basicFlag}${emFlag}${chemFlag}${unitsFlag}${symbolicFlag}${baseUnitsFlag}${hiddenFlag}${collapsedFlag}${sfFlag}\n${exprLines.join('\n')}\n\\end{calc}`;
    }
    else if (b.type === 'image') {
      const modeFlag   = `{${b.mode || 'url'}}`;
      const lockedFlag = b.locked ? '{locked}' : '';
      const lines      = [];
      if (b.src) lines.push(`% ${b.src}`);
      if (b.alt) lines.push(`% alt: ${b.alt}`);
      if (b.width || b.height) lines.push(`% size: ${b.width || 0}x${b.height || 0}`);
      if (b.fit && b.fit !== 'locked') lines.push(`% fit: ${b.fit}`);
      if (b.align && b.align !== 'left') lines.push(`% align: ${b.align}`);
      serialized = `\\begin{image}${modeFlag}${lockedFlag}\n${lines.join('\n')}\n\\end{image}`;
    }
    else if (b.type === 'graph') {
      const exprLines = (b.expressions || []).map(e =>
        `% ${e.id} ${e.color} ${e.enabled ? 'on' : 'off'} ${e.thickness != null ? e.thickness : 2.0} ${e.sliderMin != null ? e.sliderMin : 0} ${e.sliderMax != null ? e.sliderMax : 10} ${e.latex}`
      );
      const themeFlag = b.lightTheme ? '{light}' : '';
      serialized = `\\begin{graph}{${b.width}}{${b.height}}${themeFlag}\n${exprLines.join('\n')}\n\\end{graph}`;
    }
    else serialized = b.content.split('\n').map(line => '% ' + line).join('\n');
    if (b.highlighted) {
      const hlFlags = b.fillColor ? ` ${b.fillColor}` : '';
      serialized = `%@hl${hlFlags}\n${serialized}`;
    }
    if (b.commented) return serialized.split('\n').map(line => '%% ' + line).join('\n');
    return serialized;
  }).join('\n\n');
}

function parseFromLatex(src) {
  const result = [];
  // We'll scan line-by-line, collecting \[...\] blocks as math and % lines as text
  const lines = src.split('\n');
  let i = 0;
  let pendingHighlight = null; // set by %@hl lines, applied to the next box

  // Apply any pending highlight metadata to a box object, then clear it.
  const applyPending = (obj) => {
    if (pendingHighlight) {
      Object.assign(obj, pendingHighlight);
      obj.element.classList.toggle('box-is-highlighted', !!obj.highlighted);
      pendingHighlight = null;
    }
    return obj;
  };

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Highlight metadata: %@hl [#color]  (old: %@hl filled [#color])
    if (line.startsWith('%@hl')) {
      const flags = line.slice(4).trim().split(/\s+/).filter(Boolean);
      const colorFlag = flags.find(f => f.startsWith('#'));
      // Backwards compat: old format had 'filled' keyword; if present and has color, use it
      const oldFilled = flags.includes('filled');
      const fillColor = colorFlag || (oldFilled ? HIGHLIGHT_FILL_COLORS[0] : null);
      pendingHighlight = { highlighted: true, fillColor };
      i++;
      continue;
    }

    // Commented box: lines starting with '%% '
    if (line.startsWith('%% ') || line.trimEnd() === '%%') {
      const commentedLines = [line.startsWith('%% ') ? line.slice(3) : ''];
      i++;
      while (i < lines.length && (lines[i].startsWith('%% ') || lines[i].trimEnd() === '%%')) {
        commentedLines.push(lines[i].startsWith('%% ') ? lines[i].slice(3) : '');
        i++;
      }
      const inner = parseFromLatex(commentedLines.join('\n'));

      if (inner.length > 0) {
        inner[0].commented = true;
        inner[0].element.classList.add('commented');
        result.push(applyPending(inner[0]));
      }
      continue;
    }

    // Heading boxes: \section{}, \subsection{}, \subsubsection{}
    const headingPatterns = [
      { prefix: '\\section{',       type: 'h1', len: 9  },
      { prefix: '\\subsection{',    type: 'h2', len: 12 },
      { prefix: '\\subsubsection{', type: 'h3', len: 15 },
    ];
    let matchedHeading = false;
    for (const { prefix, type, len } of headingPatterns) {
      if (line.startsWith(prefix) && line.endsWith('}')) {
        result.push(applyPending(new HeaderBox(type, line.slice(len, -1))));
        i++;
        matchedHeading = true;
        break;
      }
    }
    if (matchedHeading) continue;

    // Math box: starts with \[ on this line
    if (line.startsWith('\\[')) {
      const inner = collectMathBlock(lines, i);
      if (inner !== null) {
        result.push(applyPending(new MathBox(inner.content)));
        i = inner.nextLine;
        continue;
      }
    }

    // Text box: lines starting with '%'
    if (line.startsWith('% ') || line === '%') {
      const textContent = line.startsWith('% ') ? line.slice(2) : '';
      // Merge consecutive % lines into one text box
      const textLines = [textContent];
      i++;
      while (i < lines.length && (lines[i].startsWith('% ') || lines[i].trimEnd() === '%')) {
        textLines.push(lines[i].startsWith('% ') ? lines[i].slice(2) : '');
        i++;
      }

      result.push(applyPending(new TextBox(textLines.join('\n'))));
      continue;
    }

    // Calc block: \begin{calc} ... \end{calc}
    if (line.startsWith('\\begin{calc}')) {
      // Support legacy {showresults} (both on) and new separate {showdefs}/{showbare} flags
      const legacyAll     = line.includes('{showresults}');
      const legacyPhysics = line.includes('{physics}') && !line.includes('{physics_');
      const calcData = {
        showResultsDefs: legacyAll || line.includes('{showdefs}'),
        showResultsBare: legacyAll || line.includes('{showbare}'),
        physicsBasic:    legacyPhysics || line.includes('{physics_basic}'),
        physicsEM:       legacyPhysics || line.includes('{physics_em}'),
        physicsChem:     legacyPhysics || line.includes('{physics_chem}'),
        useUnits:        line.includes('{units}'),
        useSymbolic:     line.includes('{symbolic}'),
        useBaseUnits:    line.includes('{baseunits}'),
        hidden:          line.includes('{hidden}'),
        collapsed:       line.includes('{collapsed}'),
        sigFigs:         (() => { const m = line.match(/\{sf=(\d+)\}/); return m ? parseInt(m[1], 10) : 6; })(),
        expressions:     [],
      };
      i++;

      while (i < lines.length && !lines[i].startsWith('\\end{calc}')) {
        const el = lines[i].trim();
        if (el.startsWith('% ')) {
          const rest = el.slice(2);
          const parts = rest.split(' ');
          if (parts.length >= 2) {
            const exprId = parts[0];
            if (parts[1] === 'text') {
              // Text row: "% <id> text <encoded-text>"
              const encoded = parts.slice(2).join(' ');
              const text = encoded.replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
              calcData.expressions.push({ id: exprId, type: 'text', text, latex: '', enabled: true });
              const m = exprId.match(/^ct(\d+)$/);
              if (m) calcTextNextId = Math.max(calcTextNextId, parseInt(m[1]) + 1);
            } else {
              // Expression row: "% <id> <on|off> [{s:min:max}] <latex...>"
              const enabled = parts[1] === 'on';
              const sliderMatch = parts.length >= 3 ? parts[2].match(/^\{s:([-\d.]+):([-\d.]+)\}$/) : null;
              let sliderMin = 0, sliderMax = 10, latex;
              if (sliderMatch) {
                sliderMin = parseFloat(sliderMatch[1]);
                sliderMax = parseFloat(sliderMatch[2]);
                latex = parts.slice(3).join(' ');
              } else {
                latex = parts.slice(2).join(' ');
              }
              calcData.expressions.push({ id: exprId, latex, enabled, sliderMin, sliderMax });
              const m = exprId.match(/^ce(\d+)$/);
              if (m) calcExprNextId = Math.max(calcExprNextId, parseInt(m[1]) + 1);
            }
          }
        }
        i++;
      }
      i++; // consume \end{calc}
      result.push(applyPending(new CalcBox(undefined, calcData)));
      continue;
    }

    // Graph block: \begin{graph}{W}{H} ... \end{graph}
    if (line.startsWith('\\begin{graph}')) {
      const gm = line.match(/^\\begin\{graph\}\{(\d+)\}\{(\d+)\}(\{light\})?/);
      const graphData = {
        width:       gm ? parseInt(gm[1]) : 600,
        height:      gm ? parseInt(gm[2]) : 400,
        lightTheme:  !!(gm && gm[3]),
        expressions: [],
      };
      i++;
      while (i < lines.length && !lines[i].startsWith('\\end{graph}')) {
        const el = lines[i].trim();
        if (el.startsWith('% ')) {
          const rest = el.slice(2);
          // format: "<id> <color> <on|off> <thickness> <sliderMin> <sliderMax> <latex...>"
          // (backwards-compat: thickness / sliderMin / sliderMax may be absent in old data)
          const parts = rest.split(' ');
          if (parts.length >= 3) {
            const exprId  = parts[0];
            const color   = parts[1];
            const enabled = parts[2] === 'on';
            let thickness = 2.0;
            let sliderMin = 0, sliderMax = 10;
            let latexStart = 3;
            if (parts.length >= 4 && !isNaN(parseFloat(parts[3]))) {
              thickness = parseFloat(parts[3]);
              latexStart = 4;
            }
            if (parts.length >= latexStart + 2 && !isNaN(parseFloat(parts[latexStart])) && !isNaN(parseFloat(parts[latexStart + 1]))) {
              sliderMin = parseFloat(parts[latexStart]);
              sliderMax = parseFloat(parts[latexStart + 1]);
              latexStart += 2;
            }
            const latex = parts.slice(latexStart).join(' ');
            graphData.expressions.push({ id: exprId, latex, color, enabled, thickness, sliderMin, sliderMax });
          }
        }
        i++;
      }
      i++; // consume \end{graph}
      result.push(applyPending(new GraphBox(undefined, graphData)));
      continue;
    }

    // Image block: \begin{image} ... \end{image}
    if (line.startsWith('\\begin{image}')) {
      const imageData = {
        mode:     line.includes('{file}') ? 'file' : 'url',
        locked:   line.includes('{locked}'),
        src: '', alt: '', width: 0, height: 0, fit: 'locked', align: 'left', filename: '',
      };
      i++;
      while (i < lines.length && !lines[i].startsWith('\\end{image}')) {
        const el = lines[i].trim();
        if (el.startsWith('% alt: ')) {
          imageData.alt = el.slice(7);
        } else if (el.startsWith('% size: ')) {
          const m2 = el.slice(8).match(/^(\d+)x(\d+)$/);
          if (m2) { imageData.width = parseInt(m2[1]); imageData.height = parseInt(m2[2]); }
        } else if (el.startsWith('% fit: ')) {
          imageData.fit = el.slice(7).trim();
        } else if (el.startsWith('% align: ')) {
          imageData.align = el.slice(9).trim();
        } else if (el.startsWith('% ')) {
          imageData.src = el.slice(2);
        }
        i++;
      }
      i++; // consume \end{image}
      result.push(applyPending(new ImageBox(undefined, imageData)));
      continue;
    }

    // Pagebreak: \newpage
    if (line.trimEnd() === '\\newpage') {
      result.push(applyPending(new PagebreakBox()));
      i++;
      continue;
    }

    // Skip blank lines
    if (line.trim() === '') { i++; continue; }

    // Unrecognized non-empty line → treat as text box
    result.push(applyPending(new TextBox(line)));
    i++;
  }
  return result;
}


// Efficient rebuild: only touch the DOM, reuse MQ fields where possible
function rebuildBoxList() {
  _dbg('REBUILD_BOX_LIST_START', {
    boxIds: boxes.map(b => b.id),
    domIds: [...boxList.children].map(el => el.dataset.id),
    focusedBoxId,
    suppressBoxSync, suppressTextSync, suppressHistory,
  });
  const _wasInRebuild = _dbgInRebuild;
  _dbgInRebuild = true;

  const currentIds = new Set(boxes.map(b => b.id));

  // Clean up field maps for removed boxes
  for (const [id] of mqFields) {
    if (!currentIds.has(id)) { mqFields.delete(id); boxResizers.delete(id); }
  }
//   for (const [id] of calcMqFields) {
    // if (!currentIds.has(id)) cleanupCalcBox(id);
//   }

  // Remove stale DOM elements
  for (const child of [...boxList.children]) {
    if (!currentIds.has(child.dataset.id)) {
      cleanupImageBox(child.dataset.id);
      boxList.removeChild(child);
    }
  }

  // Insert/reorder using box.element
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const currentAtPos = boxList.children[i];
    if (currentAtPos !== box.element) {
      boxList.insertBefore(box.element, currentAtPos || null);
      reflowBox(box);
    }
  }

  _dbgInRebuild = _wasInRebuild;
  _dbg('REBUILD_BOX_LIST_END', {
    boxIds: boxes.map(b => b.id),
    domIds: [...boxList.children].map(el => el.dataset.id),
  });
  _dbgDomCheck('rebuildBoxList');
}

// ── History (undo) ────────────────────────────────────────────────────────────
function pushHistory(latexStr) {
  if (suppressHistory) return;
  // Drop any redo states ahead of current position
  history.splice(historyIndex + 1);
  history.push({ latex: latexStr, focusId: focusedBoxId });
  if (history.length > MAX_HISTORY) history.shift();
  historyIndex = history.length - 1;
}

function applyUndo() {
  if (historyIndex <= 0) return;
  const graphBoxIdx = graphModeBoxId ? boxes.findIndex(b => b.id === graphModeBoxId) : -1;
  if (graphModeBoxId) _teardownGraphModeUI();
  const focusIdx = boxes.findIndex(b => b.id === focusedBoxId);
  const calcExprIdx = getFocusedCalcExprIdx();
  historyIndex--;
  restoreSnapshot(history[historyIndex], focusIdx, calcExprIdx);
  if (graphBoxIdx >= 0 && graphBoxIdx < boxes.length && boxes[graphBoxIdx].type === 'graph') {
    enterGraphMode(boxes[graphBoxIdx].id);
  }
}

function applyRedo() {
  if (historyIndex >= history.length - 1) return;
  const graphBoxIdx = graphModeBoxId ? boxes.findIndex(b => b.id === graphModeBoxId) : -1;
  if (graphModeBoxId) _teardownGraphModeUI();
  const focusIdx = boxes.findIndex(b => b.id === focusedBoxId);
  const calcExprIdx = getFocusedCalcExprIdx();
  historyIndex++;
  restoreSnapshot(history[historyIndex], focusIdx, calcExprIdx);
  if (graphBoxIdx >= 0 && graphBoxIdx < boxes.length && boxes[graphBoxIdx].type === 'graph') {
    enterGraphMode(boxes[graphBoxIdx].id);
  }
}

/**
 * Returns the index of the currently focused expression within the focused calc box, or -1.
 * @returns {number}
 */
function getFocusedCalcExprIdx() {
  if (!focusedBoxId) return -1;
  const box = boxes.find(b => b.id === focusedBoxId);
  if (!box || box.type !== 'calc') return -1;
  const activeEl = document.activeElement;
  const wrappers = [...boxList.querySelectorAll(`[data-id="${focusedBoxId}"] .expr-wrapper`)];
  return wrappers.findIndex(w => w.contains(activeEl));
}

/**
 * Restores a snapshot of the document state.
 * @param {Object} snap - Snapshot object with latex and focusId fields.
 * @param {number} preferFocusIdx - Index of the box to focus after restore.
 * @param {number} preferCalcExprIdx - Index of the calc expression to focus (within a calc box), or -1.
 */
function restoreSnapshot(snap, preferFocusIdx = -1, preferCalcExprIdx = -1) {
  _dbg('RESTORE_SNAPSHOT', {
    preferFocusIdx, preferCalcExprIdx,
    historyIndex,
    domIds: [...boxList.children].map(el => el.dataset.id),
    boxIds: boxes.map(b => b.id),
    focusedBoxId,
  });
  suppressHistory = true;
  suppressBoxSync = true;
  diffAndApply(parseFromLatex(snap.latex));
  suppressTextSync = true;
  latexSource.value = snap.latex;
  suppressTextSync = false;
  suppressBoxSync = false;
  suppressHistory = false;
  updateLineNumbers();
  schedulePreview(150);
  // parseFromLatex always generates new IDs, so focus by position rather than ID
  if (preferFocusIdx >= 0 && boxes.length > 0) {
    const targetBox = boxes[Math.min(preferFocusIdx, boxes.length - 1)];
    // For calc boxes, restore focus to the same expression index without scrolling
    if (preferCalcExprIdx >= 0 && targetBox.type === 'calc') {
      const calcMap = targetBox.fieldMap;
      if (calcMap && calcMap.size > 0) {
        const fields = [...calcMap.values()];
        const field = fields[Math.min(preferCalcExprIdx, fields.length - 1)];
        setTimeout(() => field.el().querySelector('textarea')?.focus({ preventScroll: true }), 0);
        return;
      }
    }
    focusBox(targetBox.id);
  }
}

// ── Sync right → left ─────────────────────────────────────────────────────────
/**
 * Serializes the current box state back to the latex source textarea.
 * @param {boolean} [triggerPreview=true] - Whether to schedule a preview re-render.
 *   Pass false when the change doesn't affect preview output (e.g. collapse state).
 */
function syncToText(triggerPreview = true) {
  _dbg('SYNC_TO_TEXT', { suppressed: !!suppressBoxSync, triggerPreview, focusedBoxId });
  if (suppressBoxSync) return;
  suppressTextSync = true;
  let latex = serializeToLatex(boxes);

  latexSource.value = latex;
  suppressTextSync = false;
  updateLineNumbers();
  pushHistory(latex);
  saveDraft();
  markDirty();
  if (triggerPreview) schedulePreview();
}

// ── Sync left → right (debounced) ─────────────────────────────────────────────
latexSource.addEventListener('input', () => {
  if (suppressTextSync) return;
  updateLineNumbers();
  clearTimeout(textSyncTimer);
  textSyncTimer = setTimeout(() => {
    _dbg('TEXT_SYNC_TIMER_FIRED', {
      domIds: [...boxList.children].map(el => el.dataset.id),
      boxIds: boxes.map(b => b.id),
      focusedBoxId,
    });
    suppressBoxSync = true;
    const parsed = parseFromLatex(latexSource.value);
    diffAndApply(parsed);
    suppressBoxSync = false;
    schedulePreview();
    pushHistory(latexSource.value);
    saveDraft();
    markDirty();
  }, 300);
});

// When the textarea gains focus, clear the source-highlight on boxes.
latexSource.addEventListener('focus', () => {
  updateSourceHighlight(-1, -1);
  onSourceCursorChange();
});
latexSource.addEventListener('blur', () => {
  boxList.querySelectorAll('.box-source-active').forEach(b => b.classList.remove('box-source-active'));
  updateSourceHighlight(-1, -1);
});
// Track cursor position changes so the corresponding box gets a yellow outline.
latexSource.addEventListener('click',   onSourceCursorChange);
latexSource.addEventListener('keyup',   onSourceCursorChange);
latexSource.addEventListener('select',  onSourceCursorChange);

function diffAndApply(newBoxes) {
  _dbg('DIFF_AND_APPLY_START', {
    newBoxIds: newBoxes.map(b => b.id),
    newBoxTypes: newBoxes.map(b => b.type),
    oldBoxIds: boxes.map(b => b.id),
    domIds: [...boxList.children].map(el => el.dataset.id),
    focusedBoxId,
    suppressBoxSync, suppressTextSync, suppressHistory,
  });
  const _wasInRebuild = _dbgInRebuild;
  _dbgInRebuild = true;

  // Strategy: match by position; preserve IDs where type/content match
  const result = newBoxes.map((nb, i) => {
    const existing = boxes[i];
    if (existing && existing.type === nb.type) {
      if (existing.type === 'graph' || existing.type === 'calc') {
        // Preserve id and element but take all parsed fields (expressions, width, height, etc.)
        const savedId      = existing.id;
        const savedElement = existing.element;
        Object.assign(existing, nb);
        existing.id      = savedId;
        existing.element = savedElement;
        return existing;
      }
      // Reuse id and element, update content and commented state
      existing.content   = nb.content;
      existing.commented = nb.commented;
      return existing;
    }
    return nb;
  });

  boxes = result;

  // Remove extra DOM elements
  while (boxList.children.length > boxes.length) {
    const last = boxList.lastElementChild;
    mqFields.delete(last.dataset.id);
    boxResizers.delete(last.dataset.id);
    cleanupCalcBox(last.dataset.id);
    cleanupImageBox(last.dataset.id);
    boxList.removeChild(last);
  }

  // Update or create elements
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const existingEl = boxList.children[i];

    if (existingEl && existingEl.dataset.id === box.id) {
      // Sync commented and highlighted state
      existingEl.classList.toggle('commented', !!box.commented);
      existingEl.classList.toggle('box-is-highlighted', !!box.highlighted);

      if (box.type === 'calc') {
        // Calc boxes always rebuild their DOM so the expression list stays in sync
        // with any changes made via the LaTeX source panel.
        cleanupCalcBox(box.id);
        box.element = box.createElement();
        boxList.replaceChild(box.element, existingEl);
        reflowBox(box);
      } else {
        // Update content of existing box
        const field = mqFields.get(box.id);
        if (field) {
          if (field.latex() !== box.content) field.latex(box.content);
        } else {
          const ta = existingEl.querySelector('.text-input');
          if (ta && ta.value !== box.content) {
            ta.value = box.content;
            ta.style.height = '1px';
            ta.style.height = ta.scrollHeight + 'px';
          }
        }
      }
    } else {
      // Insert new element — existingEl has wrong id (type mismatch) or doesn't exist
      _dbg('DIFF_INSERT_NEW', {
        i, boxId: box.id, boxType: box.type,
        displacedId: existingEl?.dataset.id ?? null,
      });
      if (existingEl) {
        boxList.insertBefore(box.element, existingEl);
      } else {
        boxList.appendChild(box.element);
      }
      reflowBox(box);
    }
  }

  // A type-mismatch insertion above shifts displaced elements to the tail; trim them now.
  while (boxList.children.length > boxes.length) {
    const last = boxList.lastElementChild;
    _dbg('DIFF_TRIM_TAIL', { removedId: last.dataset.id });
    mqFields.delete(last.dataset.id);
    boxResizers.delete(last.dataset.id);
    cleanupCalcBox(last.dataset.id);
    cleanupImageBox(last.dataset.id);
    boxList.removeChild(last);
  }

  _dbgInRebuild = _wasInRebuild;
  _dbg('DIFF_AND_APPLY_END', {
    boxIds: boxes.map(b => b.id),
    domIds: [...boxList.children].map(el => el.dataset.id),
  });
  _dbgDomCheck('diffAndApply');
}

// ── Line numbers + highlight overlay ─────────────────────────────────────────

let cachedLineHeights = []; // px height of each logical line as rendered in the textarea

// Measure the rendered visual height of every logical line by cloning the
// textarea's font/width into a hidden mirror div and reading offsetHeight once
// per line.  All line divs are added in one shot so the browser needs only a
// single layout pass.
function measureLineHeights() {
  const style      = window.getComputedStyle(latexSource);
  const padL       = parseFloat(style.paddingLeft);
  const padR       = parseFloat(style.paddingRight);
  const innerWidth = Math.max(1, latexSource.clientWidth - padL - padR);

  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position:     'fixed',
    left:         '-9999px',
    top:          '0',
    width:        innerWidth + 'px',
    height:       'auto',
    visibility:   'hidden',
    fontFamily:   style.fontFamily,
    fontSize:     style.fontSize,
    fontWeight:   style.fontWeight,
    lineHeight:   style.lineHeight,
    letterSpacing: style.letterSpacing,
    tabSize:      style.tabSize,
    whiteSpace:   'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak:    'normal',
    padding:      '0',
    margin:       '0',
    border:       '0',
    boxSizing:    'content-box',
  });

  const lines = latexSource.value.split('\n');
  const rowEls = lines.map(line => {
    const div = document.createElement('div');
    // Use a non-breaking space so empty lines still produce one row of height.
    div.textContent = line || '\u00a0';
    mirror.appendChild(div);
    return div;
  });

  document.body.appendChild(mirror);
  const heights = rowEls.map(el => el.getBoundingClientRect().height); // sub-pixel precision
  document.body.removeChild(mirror);
  return heights;
}

function updateLineNumbers() {
  cachedLineHeights = measureLineHeights();

  // Build gutter text: each logical line gets its number on the first visual
  // row and blank lines for any additional wrapped rows so numbers stay aligned.
  const lineH = parseFloat(window.getComputedStyle(lineNumbers).lineHeight) || (13 * 1.7);
  let gutterText = '';
  for (let i = 0; i < cachedLineHeights.length; i++) {
    const visualRows = Math.max(1, Math.round(cachedLineHeights[i] / lineH));
    gutterText += (i + 1) + '\n' + '\n'.repeat(visualRows - 1);
  }
  lineNumbers.textContent = gutterText.replace(/\n$/, '');

  // Rebuild overlay if a box is currently highlighted
  if (focusedBoxId) highlightSourceForBox(focusedBoxId);
  else updateSourceHighlight(-1, -1);
}

latexSource.addEventListener('scroll', () => {
  lineNumbers.scrollTop = latexSource.scrollTop;
  sourceLineHighlight.style.transform = `translateY(${-latexSource.scrollTop}px)`;
});

// ── Source ↔ box cross-highlighting ──────────────────────────────────────────

// Compute which line range (0-based, inclusive) each box occupies in the
// serialized LaTeX (mirrors serializeToLatex exactly).
function computeBoxLineRanges(boxArray) {
  const ranges = [];
  let line = 0;
  for (let i = 0; i < boxArray.length; i++) {
    const b = boxArray[i];
    const lineCount = serializeToLatex([b]).split('\n').length;
    ranges.push({ id: b.id, start: line, end: line + lineCount - 1 });
    line += lineCount + 1; // +1 for blank separator (\n\n join)
  }
  return ranges;
}

// Rebuild the highlight overlay from scratch.  activeStart/activeEnd are
// 0-based line indices into latexSource.value, or both -1 for no highlight.
// Each overlay div gets the exact pixel height of its logical line so that
// wrapped lines take their full visual space.
function updateSourceHighlight(activeStart, activeEnd) {
  const fallbackH  = 13 * 1.7; // used only before first measureLineHeights call
  const totalLines = latexSource.value.split('\n').length;
  let html = '';
  for (let i = 0; i < totalLines; i++) {
    const on = activeStart >= 0 && i >= activeStart && i <= activeEnd;
    const h  = cachedLineHeights[i] ?? fallbackH;
    html += `<div class="source-hl${on ? ' active' : ''}" style="height:${h}px"></div>`;
  }
  sourceLineHighlight.innerHTML = html;
  sourceLineHighlight.style.transform = `translateY(${-latexSource.scrollTop}px)`;
}

// Called when a box is focused — highlight its lines in the source panel.
function highlightSourceForBox(boxId) {
  const ranges = computeBoxLineRanges(boxes);
  const r = ranges.find(x => x.id === boxId);
  if (r) updateSourceHighlight(r.start, r.end);
  else    updateSourceHighlight(-1, -1);
}

// Called when the source textarea cursor moves — outline the corresponding box.
let _sourceHighlightTimer = null;
function onSourceCursorChange() {
  clearTimeout(_sourceHighlightTimer);
  _sourceHighlightTimer = setTimeout(() => {
    const cursorLine = latexSource.value.substring(0, latexSource.selectionStart).split('\n').length - 1;
    const ranges = computeBoxLineRanges(boxes);
    const r = ranges.find(x => cursorLine >= x.start && cursorLine <= x.end);
    // Update box outlines
    boxList.querySelectorAll('.box').forEach(el => el.classList.remove('box-source-active'));
    if (r) {
      const el = boxList.querySelector(`[data-id="${r.id}"]`);
      if (el) el.classList.add('box-source-active');
    }
  }, 50);
}

// ── Default box type toggle ───────────────────────────────────────────────────
function setDefaultBoxType(type) {
  defaultBoxType = type;
  defaultMathBtn.classList.toggle('active', type === 'math');
  defaultTextBtn.classList.toggle('active', type === 'text');
}

defaultMathBtn.addEventListener('click', () => setDefaultBoxType('math'));
defaultTextBtn.addEventListener('click', () => setDefaultBoxType('text'));

// ── Toolbar buttons ───────────────────────────────────────────────────────────
// Prevent mousedown from stealing focus (which would clear focusedBoxId before click fires)
const addGraphBtn = document.getElementById('add-graph-btn');
const addCalcBtn  = document.getElementById('add-calc-btn');
const addImageBtn = document.getElementById('add-image-btn');
[addMathBtn, addTextBtn, addH1Btn, addH2Btn, addH3Btn, addBreakBtn, addGraphBtn, addCalcBtn, addImageBtn].forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault());
});
addMathBtn.addEventListener('click', () => appendBox('math'));
addTextBtn.addEventListener('click', () => appendBox('text'));
addH1Btn.addEventListener('click', () => appendBox('h1'));
addH2Btn.addEventListener('click', () => appendBox('h2'));
addH3Btn.addEventListener('click', () => appendBox('h3'));
addBreakBtn.addEventListener('click', () => appendBox('pagebreak'));
addGraphBtn.addEventListener('click', () => appendBox('graph'));
addCalcBtn.addEventListener('click', () => appendBox('calc'));
addImageBtn.addEventListener('click', () => appendBox('image'));

// ── Font size ─────────────────────────────────────────────────────────────────
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];
let fontSizeIndex = 2; // default: 16px

function applyFontSize() {
  const px = FONT_SIZES[fontSizeIndex];
  boxList.style.setProperty('--eq-font-size', px + 'px');
  fontSizeLabel.textContent = px + 'px';
}

fontDecBtn.addEventListener('click', () => {
  if (fontSizeIndex > 0) { fontSizeIndex--; applyFontSize(); }
});
fontIncBtn.addEventListener('click', () => {
  if (fontSizeIndex < FONT_SIZES.length - 1) { fontSizeIndex++; applyFontSize(); }
});

// ── Cut / paste boxes ────────────────────────────────────────────────────────
function cutBox(id) {
  const idx = boxes.findIndex(b => b.id === id);
  if (idx === -1) return;
  const box = boxes[idx];
  // Read live content from the DOM field
  let content = box.content;
  if (box.type === 'math') {
    const field = mqFields.get(id);
    if (field) content = field.latex();
  } else if (box.type === 'calc') {
    // For calc boxes, commit live state then copy expressions
    commitCalcBox(id);
    boxClipboard = { type: 'calc', content: '', expressions: (box.expressions || []).map(e => e.toData ? e.toData() : { ...e }), showResultsDefs: box.showResultsDefs !== false, showResultsBare: box.showResultsBare !== false, physicsBasic: !!box.physicsBasic, physicsEM: !!box.physicsEM, physicsChem: !!box.physicsChem };
    deleteBox(id);
    return;
  } else if (box.type === 'image') {
    boxClipboard = { type: 'image', mode: box.mode, locked: box.locked, src: box.src, filename: box.filename, alt: box.alt, content: '' };
    deleteBox(id);
    return;
  } else if (box.type !== 'pagebreak') {
    const ta = boxList.querySelector(`[data-id="${id}"] .text-input`);
    if (ta) content = ta.value;
  }
  boxClipboard = { type: box.type, content };
  deleteBox(id);
}

function pasteBox() {
  if (!boxClipboard || !focusedBoxId) return;
  const idx = boxes.findIndex(b => b.id === focusedBoxId);
  if (idx === -1) return;

  // Determine if the focused box is empty
  let isEmpty = false;
  if (boxes[idx].type === 'math') {
    const field = mqFields.get(focusedBoxId);
    isEmpty = !field || field.latex() === '';
  } else if (boxes[idx].type === 'calc' || boxes[idx].type === 'graph' || boxes[idx].type === 'pagebreak' || boxes[idx].type === 'image') {
    isEmpty = false; // these box types always insert after rather than replace
  } else {
    const ta = boxList.querySelector(`[data-id="${focusedBoxId}"] .text-input`);
    isEmpty = !ta || ta.value === '';
  }

  let newBox;
  if (boxClipboard.type === 'calc') {
    newBox = new CalcBox(undefined, {
      expressions:    (boxClipboard.expressions || []).map(e => ({ ...e, id: 'ce' + (calcExprNextId++) })),
      showResultsDefs: boxClipboard.showResultsDefs !== false,
      showResultsBare: boxClipboard.showResultsBare !== false,
      physicsBasic:    !!boxClipboard.physicsBasic,
      physicsEM:       !!boxClipboard.physicsEM,
      physicsChem:     !!boxClipboard.physicsChem,
    });
  } else if (boxClipboard.type === 'image') {
    newBox = new ImageBox(undefined, {
      mode:     boxClipboard.mode,
      locked:   boxClipboard.locked,
      src:      boxClipboard.src,
      filename: boxClipboard.filename,
      alt:      boxClipboard.alt,
      width:    boxClipboard.width  || 0,
      height:   boxClipboard.height || 0,
      fit:      boxClipboard.fit    || 'locked',
      align:    boxClipboard.align  || 'left',
    });
  } else {
    newBox = createBoxFromType(boxClipboard.type, undefined, boxClipboard.content);
  }

  if (isEmpty) {
    // Replace the empty box in-place
    mqFields.delete(focusedBoxId);
    boxResizers.delete(focusedBoxId);
    cleanupCalcBox(focusedBoxId);
    cleanupImageBox(focusedBoxId);
    boxes.splice(idx, 1, newBox);
  } else {
    // Insert a new box below the focused one
    boxes.splice(idx + 1, 0, newBox);
  }
  // Suppress history during rebuild so field.latex() in box.createElement(); doesn't
  // fire an extra edit→syncToText→pushHistory before our single syncToText below.
  suppressHistory = true;
  rebuildBoxList();
  suppressHistory = false;
  syncToText();
  focusBox(newBox.id);
}


// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === 't') {
      e.preventDefault();
      // Inside a calc box: insert a text row after the focused row
      if (focusedBoxId) {
        const focusedBox = boxes.find(b => b.id === focusedBoxId);
        if (focusedBox && focusedBox.type === 'calc') {
          const exprIdx = getFocusedCalcExprIdx();
          const wrappers = [...boxList.querySelectorAll(`[data-id="${focusedBoxId}"] .expr-wrapper`)];
          const afterId = exprIdx >= 0 ? wrappers[exprIdx]?.dataset.exprId ?? null : null;
          const addText = calcAddTextFns.get(focusedBoxId);
          if (addText) addText(afterId);
          return;
        }
      }
      appendBox('text');
      return;
    }
    if (e.key === 'm') { e.preventDefault(); appendBox('math'); return; }
  }

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  if (e.key === 's') { e.preventDefault(); saveCurrentProject(); return; }

  // Don't intercept other shortcuts when editing the raw LaTeX textarea
  if (document.activeElement === latexSource) return;

  const key = e.key.toLowerCase(); // normalize for Shift (e.g. 'Z' → 'z')

  if (key === 'z' && !e.shiftKey) { e.preventDefault(); applyUndo();  return; }
  if (key === 'z' &&  e.shiftKey) { e.preventDefault(); applyRedo();  return; }
  if (key === 'y')                 { e.preventDefault(); applyRedo();  return; }

  if (key === 'v' && boxClipboard && focusedBoxId) {
    e.preventDefault();
    pasteBox();
    return;
  }

  if (key === 'h') {
    e.preventDefault();
    if (focusedBoxId) {
      const idx = boxes.findIndex(b => b.id === focusedBoxId);
      if (idx !== -1) {
        const wasHighlighted = !!boxes[idx].highlighted;
        boxes[idx].highlighted = !wasHighlighted;
        if (boxes[idx].highlighted) {
          if (!boxes[idx].fillColor) boxes[idx].fillColor = HIGHLIGHT_FILL_COLORS[0];
        }
        const hlEl = boxList.querySelector(`[data-id="${focusedBoxId}"]`);
        if (hlEl) hlEl.classList.toggle('box-is-highlighted', !!boxes[idx].highlighted);
        updateHighlightToolbar();
        syncToText();
      }
    }
    return;
  }
});

// Clean up drag state if drop lands outside a box
document.addEventListener('dragend', () => {
  dragSrcBoxId = null;
  boxList.querySelectorAll('.box.drag-over').forEach(el => el.classList.remove('drag-over'));
});

// ── Divider drag-to-resize ────────────────────────────────────────────────────
const divider = document.getElementById('divider');
const leftPanel = document.getElementById('left-panel');
const rightPanel = document.getElementById('right-panel');

let dragging = false;
let dragStartX = 0;
let leftStartWidth = 0;

let dragging2 = false;
let drag2StartX = 0;
let previewStartWidth = 0;

divider.addEventListener('mousedown', e => {
  dragging = true;
  dragStartX = e.clientX;
  leftStartWidth = leftPanel.getBoundingClientRect().width;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

divider2.addEventListener('mousedown', e => {
  if (!isPreviewOpen) return;
  dragging2 = true;
  drag2StartX = e.clientX;
  previewStartWidth = previewPanel.getBoundingClientRect().width;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', e => {
  if (dragging) {
    const delta = e.clientX - dragStartX;
    const totalWidth = leftPanel.parentElement.getBoundingClientRect().width - divider.offsetWidth;
    const newLeft = Math.max(200, Math.min(totalWidth - 200, leftStartWidth + delta));
    leftPanel.style.flex = 'none';
    leftPanel.style.width = newLeft + 'px';
    rightPanel.style.flex = '1';
  }
  if (dragging2) {
    // Dragging left → preview grows; right → preview shrinks
    const delta = drag2StartX - e.clientX;
    const app = previewPanel.parentElement;
    const totalWidth = app.getBoundingClientRect().width - divider2.offsetWidth - divider.offsetWidth;
    const newPreview = Math.max(200, Math.min(totalWidth - 200, previewStartWidth + delta));
    previewPanel.style.flex = 'none';
    previewPanel.style.width = newPreview + 'px';
  }
});

document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveUiState();
  }
  if (dragging2) {
    dragging2 = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveUiState();
  }
});


// ── Projects panel ────────────────────────────────────────────────────────────

let dragSrcIndex = -1;

function renderProjectsList() {
  const projects = loadProjects();
  projectsList.innerHTML = '';

  projects.forEach((proj, i) => {
    const item = document.createElement('div');
    item.className = 'project-item' + (proj.id === currentProjectId ? ' current' : '');
    item.draggable = true;
    item.dataset.index = i;

    const handle = document.createElement('span');
    handle.className = 'project-drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'project-title-wrap';

    const titleText = document.createElement('span');
    titleText.className = 'project-title';
    titleText.textContent = proj.title;
    titleWrap.appendChild(titleText);

    if (proj.onDisk) {
      const pathText = document.createElement('span');
      pathText.className = 'project-disk-path';
      pathText.textContent = proj.texFilename || 'Saved on disk';
      titleWrap.appendChild(pathText);
    }

    const menuBtn = document.createElement('button');
    menuBtn.className = 'project-menu-btn';
    menuBtn.textContent = '⋯';
    menuBtn.title = 'Options';

    const dropdown = document.createElement('div');
    dropdown.className = 'project-dropdown';

    const renameBtn = document.createElement('button');
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.classList.remove('open');
      renameProject(proj.id);
    });

    // "Save to disk" only shown in Chrome/Edge (File System Access API available)
    if (window.showDirectoryPicker) {
      const saveToDiskBtn = document.createElement('button');
      saveToDiskBtn.textContent = 'Save to disk';
      saveToDiskBtn.addEventListener('click', e => {
        e.stopPropagation();
        dropdown.classList.remove('open');
        saveProjectToDisk(proj.id);
      });
      dropdown.appendChild(saveToDiskBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.classList.remove('open');
      deleteProject(proj.id);
    });

    dropdown.appendChild(renameBtn);
    dropdown.appendChild(deleteBtn);

    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = dropdown.classList.contains('open');
      // Close all other dropdowns
      document.querySelectorAll('.project-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!wasOpen) dropdown.classList.add('open');
    });

    item.appendChild(handle);
    item.appendChild(titleWrap);
    item.appendChild(menuBtn);
    item.appendChild(dropdown);

    // Click to open (but not on handle/menu)
    item.addEventListener('click', e => {
      if (e.target.closest('.project-menu-btn') || e.target.closest('.project-dropdown')) return;
      openProject(proj.id);
    });

    // Drag-to-reorder
    item.addEventListener('dragstart', e => {
      dragSrcIndex = i;
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (dragSrcIndex === i) return;
      const projects = loadProjects();
      const [moved] = projects.splice(dragSrcIndex, 1);
      projects.splice(i, 0, moved);
      saveProjects(projects);
      renderProjectsList();
    });

    projectsList.appendChild(item);
  });
}

function newProject() {
  if (isDirty && !confirm('You have unsaved changes. Start a new project anyway?')) return;
  currentProjectId = null;
  projectTitleLabel.textContent = 'Untitled';
  mqFields.clear(); boxResizers.clear();
  boxes = [new MathBox()];
  rebuildBoxList();
  suppressTextSync = true;
  latexSource.value = '';
  suppressTextSync = false;
  history = [{ latex: '', focusId: null }];
  historyIndex = 0;
  updateLineNumbers();
  markClean();
  saveDraftNow();
  closeProjectsPanel();
  renderProjectsList();
  focusBox(boxes[0].id);
}

function openProjectsPanel() {
  projectsPanel.classList.add('open');
  projectsOverlay.classList.add('visible');
  const openBtn = document.getElementById('open-project-btn');
  const unsupportedMsg = document.getElementById('fs-unsupported-msg');
  const workspaceInfo = document.getElementById('workspace-info');
  if (window.showDirectoryPicker) {
    openBtn.hidden = false;
    unsupportedMsg.hidden = true;
    // Show the current workspace folder name, if set
    const name = currentWorkspaceHandle?.name || localStorage.getItem(WORKSPACE_NAME_KEY);
    workspaceInfo.textContent = name ? `Folder: ${name}` : '';
    workspaceInfo.hidden = !name;
  } else {
    openBtn.hidden = true;
    unsupportedMsg.hidden = false;
    workspaceInfo.hidden = true;
  }
  renderProjectsList();
}

function closeProjectsPanel() {
  projectsPanel.classList.remove('open');
  projectsOverlay.classList.remove('visible');
}

// Close dropdowns when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.project-dropdown.open').forEach(d => d.classList.remove('open'));
});

projectsBtn.addEventListener('click', () => {
  if (projectsPanel.classList.contains('open')) {
    closeProjectsPanel();
  } else {
    openProjectsPanel();
  }
});

closeProjectsBtn.addEventListener('click', closeProjectsPanel);
projectsOverlay.addEventListener('click', closeProjectsPanel);
document.getElementById('new-project-btn').addEventListener('click', newProject);
document.getElementById('open-project-btn').addEventListener('click', openWorkspaceFolder);
saveBtn.addEventListener('click', saveCurrentProject);
downloadBtn.addEventListener('click', downloadCurrentProject);


// ── Highlight toolbar button handlers ────────────────────────────────────────
[highlightBtn, fillColorBtn].forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault());
});

highlightBtn.addEventListener('click', () => {
  if (!focusedBoxId) return;
  const idx = boxes.findIndex(b => b.id === focusedBoxId);
  if (idx === -1) return;
  const wasHighlighted = !!boxes[idx].highlighted;
  boxes[idx].highlighted = !wasHighlighted;
  if (boxes[idx].highlighted) {
    if (!boxes[idx].fillColor) boxes[idx].fillColor = HIGHLIGHT_FILL_COLORS[0];
  }
  const hlEl = boxList.querySelector(`[data-id="${focusedBoxId}"]`);
  if (hlEl) hlEl.classList.toggle('box-is-highlighted', !!boxes[idx].highlighted);
  updateHighlightToolbar();
  syncToText();
});

fillColorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!focusedBoxId) return;
  openFillColorPopup(fillColorBtn, focusedBoxId);
});


// ── Reflow all boxes when the panel width changes ──────────────────────────────
// MathQuill equations and textareas need explicit re-measurement; they don't
// reflow automatically when the containing flex column is resized by the divider.
let lastBoxListWidth = 0;
new ResizeObserver(entries => {
  const w = entries[0].contentRect.width;
  if (w === lastBoxListWidth) return;
  lastBoxListWidth = w;
  for (const fn of boxResizers.values()) fn();
}).observe(boxList);

// Re-measure line heights when the source panel width changes (wrapping changes).
let lastSourceWidth = 0;
new ResizeObserver(entries => {
  const w = entries[0].contentRect.width;
  if (w === lastSourceWidth) return;
  lastSourceWidth = w;
  updateLineNumbers();
}).observe(latexSource);

// Re-render graph when preview panel is resized
new ResizeObserver(() => {
  if (graphModeBoxId) scheduleGraphRender();
}).observe(document.getElementById('preview-content'));

// ── Initialize ────────────────────────────────────────────────────────────────
initImageDb().catch(() => {}).then(init);

function init() {
  applyFontSize();
  updateHighlightToolbar();

  // Restore UI layout (panel visibility + divider positions)
  const uiState = JSON.parse(localStorage.getItem(UI_STATE_KEY) || 'null');
  if (uiState) {
    if (!uiState.isSourceOpen) toggleSource();
    if (uiState.isPreviewOpen)  togglePreview();
    if (uiState.leftPanelWidth) {
      leftPanel.style.flex  = 'none';
      leftPanel.style.width = uiState.leftPanelWidth;
      rightPanel.style.flex = '1';
    }
    if (uiState.previewPanelWidth && uiState.isPreviewOpen) {
      previewPanel.style.flex  = 'none';
      previewPanel.style.width = uiState.previewPanelWidth;
    }
  }

  const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  if (draft && draft.latex != null) {
    restoreFromLatex(draft.latex);
    currentProjectId = draft.projectId || null;
    if (currentProjectId) {
      const proj = loadProjects().find(p => p.id === currentProjectId);
      if (proj) {
        projectTitleLabel.textContent = proj.title;
        // Passively try to restore the global workspace handle (queryPermission needs no gesture)
        idbGetWorkspace().then(async handle => {
          if (!handle) return;
          try {
            const perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm === 'granted') {
              currentWorkspaceHandle = handle;
              retryAllDiskImages();
            } else {
              // Permission needs a user gesture — reconnect on the next interaction
              const reconnectOnInteraction = async () => {
                document.removeEventListener('click',   reconnectOnInteraction, true);
                document.removeEventListener('keydown', reconnectOnInteraction, true);
                const ok = await reconnectWorkspace();
                if (ok) retryAllDiskImages();
              };
              document.addEventListener('click',   reconnectOnInteraction, true);
              document.addEventListener('keydown', reconnectOnInteraction, true);
            }
          } catch {}
        }).catch(() => {});
      }
    }
  } else {
    boxes = [new MathBox()];
    renderBoxes();
    suppressHistory = true;
    syncToText();
    suppressHistory = false;
    history = [{ latex: latexSource.value, focusId: null }];
    historyIndex = 0;
    focusBox(boxes[0].id);
  }
  markClean();
  updateLineNumbers();
}

// ── MathJax metrics cache ─────────────────────────────────────────────────────
// getMetrics() reads em/ex from the DOM via getComputedStyle, which forces a
// reflow after every DOM mutation. Font metrics are stable for the entire
// editing session (they only change on browser zoom), so we measure once and
// return the cached value on all subsequent calls. The cache is invalidated on
// window resize so a browser-zoom change is picked up on the next typeset.
//
// We patch the prototype (not the instance) so the override intercepts all
// calls regardless of when MathJax internally captured the method reference.


var metricsCache = null;
window.addEventListener('load', () => {
  window.MathJax?.startup?.promise?.then(() => {
    const output = MathJax.startup.output;
    if (!output) return;

    // Walk up the prototype chain to find where getMetrics is actually defined.
    let proto = output;
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'getMetrics')) {
      proto = Object.getPrototypeOf(proto);
    }
    if (!proto?.getMetrics) {
      console.warn('[MathJax patch] getMetrics not found on prototype chain');
      return;
    }

    const _measureMetrics = proto.measureMetrics;
    
    window.addEventListener('resize', () => { metricsCache = null; });
    proto.measureMetrics = function (node,e) {

      if (!metricsCache) {
        console.log("cacheMiss:", metricsCache);
        metricsCache = _measureMetrics.call(this,node,e);
      }

      return metricsCache;
    };
  });
});

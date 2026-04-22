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
let graphCommitTimer = null;
let draftSaveTimer = null;

// ── Image box state ───────────────────────────────────────────────────────────
let imageDb = null;                       // IndexedDB handle
const imageObjectUrls = new Map();        // boxId → blob object URL (revoke on box delete)

// ── Calc box state ────────────────────────────────────────────────────────────
let calcExprNextId = 1;
let calcTextNextId = 1;
let calcMqFields = new Map();       // boxId → Map<exprId, MQField>
let calcTextAreaMap = new Map();    // boxId → Map<exprId, HTMLTextAreaElement>
let calcUpdateFnsMap = new Map();   // boxId → Map<exprId, (resultMap) => void>
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

// ── ID generation ─────────────────────────────────────────────────────────────
function genId() { return 'b' + (nextId++); }

function makeGraphBox(id) {
  return {
    id: id || genId(),
    type: 'graph',
    content: '',
    width: 600,
    height: 400,
    lightTheme: false,
    expressions: [
      { id: 'ge' + (graphExprNextId++), latex: '', color: nextGraphColor(), enabled: true, thickness: 2.0 },
    ],
  };
}

function makeCalcBox(id) {
  return {
    id: id || genId(),
    type: 'calc',
    content: '',
    showResultsDefs: true,
    showResultsBare: true,
    physicsBasic: false,
    physicsEM: false,
    physicsChem: false,
    useUnits: false,
    useSymbolic: false,
    useBaseUnits: false,
    hidden: false,
    collapsed: false,
    sigFigs: 6,
    expressions: [
      { id: 'ce' + (calcExprNextId++), latex: '', enabled: true },
    ],
  };
}

function makeImageBox(id) {
  return { id: id || genId(), type: 'image', mode: 'url', locked: false, src: '', filename: '', alt: '', width: 0, height: 0, fit: 'locked', align: 'left' };
}

// ── Calc box helpers ──────────────────────────────────────────────────────────

function formatCalcResult(result, sigFigs = 6) {
  if (!result) return null;
  if (result.error) return null;
  if (result.boolValue !== undefined) return result.boolValue ? 'true' : 'false';
  if (result.value !== undefined) return formatConstantValue(result.value, sigFigs);
  return null;
}

// ── Unit result display helpers ───────────────────────────────────────────────

const SUPERSCRIPT_CHARS = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻' };
function toSuperscript(n) {
  return (n < 0 ? '⁻' : '') + String(Math.abs(n)).split('').map(c => SUPERSCRIPT_CHARS[c] || c).join('');
}

function _astNumStr(v, sigFigs = 6) {
  if (!isFinite(v)) return String(v);
  const absV = Math.abs(v);
  if (Number.isInteger(v) && absV < 10000) return String(v);
  if (absV >= 0.001 && absV < 10000) return String(parseFloat(v.toPrecision(sigFigs)));
  if (absV < 0.001) {
    const exp = Math.floor(Math.log10(absV));
    const m = parseFloat((v / Math.pow(10, exp)).toPrecision(sigFigs));
    return `${m}\u00D710${exp < 0 ? '\u207B' : ''}${String(Math.abs(exp)).split('').map(c => '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]).join('')}`;
  }
  const exp3 = Math.floor(Math.log10(absV) / 3) * 3;
  const m = parseFloat((v / Math.pow(10, exp3)).toPrecision(sigFigs));
  return `${m}\u00D710${String(exp3).split('').map(c => '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]).join('')}`;
}

/** Format a number as a LaTeX string, using \times 10^{n} for scientific notation. */
function _numToLatex(v, sigFigs = 6) {
  if (!isFinite(v)) return String(v);
  const absV = Math.abs(v);
  if (Number.isInteger(v) && absV < 10000) return String(v);
  if (absV >= 0.001 && absV < 10000) return String(parseFloat(v.toPrecision(sigFigs)));
  if (absV < 0.001) {
    const exp = Math.floor(Math.log10(absV));
    const m = parseFloat((v / Math.pow(10, exp)).toPrecision(sigFigs));
    return `${m} \\times 10^{${exp}}`;
  }
  const exp3 = Math.floor(Math.log10(absV) / 3) * 3;
  const m = parseFloat((v / Math.pow(10, exp3)).toPrecision(sigFigs));
  return `${m} \\times 10^{${exp3}}`;
}

/** Like formatCalcResult but returns a LaTeX string for use in the preview panel. */
function formatCalcResultLatex(result, sigFigs = 6) {
  if (!result || result.error) return null;
  if (result.boolValue !== undefined) return `\\text{${result.boolValue ? 'true' : 'false'}}`;
  if (result.value !== undefined) {
    if (!isFinite(result.value)) return null;
    if (Number.isInteger(result.value) && Math.abs(result.value) < 10000)
      return `= ${result.value}`;
    return `\\approx ${_numToLatex(result.value, sigFigs)}`;
  }
  return null;
}

/** Returns true if the AST contains any 'div' call node (needs fraction bar). */
function _astHasDiv(ast) {
  if (!ast) return false;
  if (ast.type === 'call' && ast.name === 'div') return true;
  return !!(ast.args && ast.args.some(_astHasDiv)) || _astHasDiv(ast.arg);
}

/**
 * Render an AST as a plain-text string using Unicode superscripts.
 * Returns null if the AST contains a 'div' node (use buildAstHtml instead).
 */
function buildAstText(ast, sigFigs = 6) {
  if (!ast) return '?';
  if (ast.type === 'number') return _astNumStr(ast.value, sigFigs);
  if (ast.type === 'variable') return ast.name;
  if (ast.type !== 'call') return '?';
  const [a, b] = ast.args || [];
  switch (ast.name) {
    case 'add': { const la = buildAstText(a, sigFigs), rb = buildAstText(b, sigFigs); return (la&&rb) ? `${la} + ${rb}` : null; }
    case 'sub': { const la = buildAstText(a, sigFigs), rb = buildAstText(b, sigFigs); return (la&&rb) ? `${la} \u2212 ${rb}` : null; }
    case 'mul': {
      const la = buildAstText(a, sigFigs), rb = buildAstText(b, sigFigs);
      if (!la || !rb) return null;
      // number × unit: use space; unit × unit: use center dot
      return a.type === 'number' ? `${la}\u2009${rb}` : `${la}\u00B7${rb}`;
    }
    case 'div': {
      const la = buildAstText(a, sigFigs), rb = buildAstText(b, sigFigs);
      return (la && rb) ? `${la}/${rb}` : null;
    }
    case 'pow': {
      const base = buildAstText(a, sigFigs);
      if (!base) return null;
      if (b && b.type === 'number' && Number.isInteger(b.value))
        return base + toSuperscript(b.value);
      const expStr = buildAstText(b, sigFigs);
      return expStr ? `${base}^(${expStr})` : null;
    }
    case 'neg':  { const s = buildAstText(a, sigFigs); return s ? `\u2212${s}` : null; }
    case 'sin':  { const s = buildAstText(a, sigFigs); return s ? `sin(${s})` : null; }
    case 'cos':  { const s = buildAstText(a, sigFigs); return s ? `cos(${s})` : null; }
    case 'tan':  { const s = buildAstText(a, sigFigs); return s ? `tan(${s})` : null; }
    case 'asin': { const s = buildAstText(a, sigFigs); return s ? `arcsin(${s})` : null; }
    case 'acos': { const s = buildAstText(a, sigFigs); return s ? `arccos(${s})` : null; }
    case 'atan': { const s = buildAstText(a, sigFigs); return s ? `arctan(${s})` : null; }
    case 'ln':   { const s = buildAstText(a, sigFigs); return s ? `ln(${s})` : null; }
    case 'exp':  { const s = buildAstText(a, sigFigs); return s ? `exp(${s})` : null; }
    case 'abs':  { const s = buildAstText(a, sigFigs); return s ? `|${s}|` : null; }
    case 'sqrt': { const s = buildAstText(a, sigFigs); return s ? `\u221A(${s})` : null; }
    default: {
      const args = (ast.args || []).map(n => buildAstText(n, sigFigs));
      return args.every(Boolean) ? `${ast.name}(${args.join(', ')})` : null;
    }
  }
}

/** Recursively build DOM nodes for an AST, including CSS fraction bars for 'div'. */
function buildAstHtml(ast, sigFigs = 6) {
  const txt = s => document.createTextNode(s);
  const span = (...kids) => {
    const el = document.createElement('span');
    for (const k of kids) el.appendChild(typeof k === 'string' ? txt(k) : k);
    return el;
  };
  const rec = n => buildAstHtml(n, sigFigs);
  if (!ast) return txt('?');
  if (ast.type === 'number') return txt(_astNumStr(ast.value, sigFigs));
  if (ast.type === 'variable') return txt(ast.name);
  if (ast.type !== 'call') return txt('?');
  const [a, b] = ast.args || [];
  switch (ast.name) {
    case 'add':  return span(rec(a), ' + ', rec(b));
    case 'sub':  return span(rec(a), ' \u2212 ', rec(b));
    case 'mul': {
      const sep = a.type === 'number' ? '\u2009' : '\u00B7'; // thin space vs center dot
      return span(rec(a), sep, rec(b));
    }
    case 'div': {
      const frac = document.createElement('span');
      frac.className = 'inline-frac';
      const num = document.createElement('span');
      num.className = 'frac-num';
      num.appendChild(rec(a));
      const den = document.createElement('span');
      den.className = 'frac-den';
      den.appendChild(rec(b));
      frac.appendChild(num);
      frac.appendChild(den);
      return frac;
    }
    case 'pow': {
      if (b && b.type === 'number' && Number.isInteger(b.value))
        return span(rec(a), toSuperscript(b.value));
      return span(rec(a), '^(', rec(b), ')');
    }
    case 'neg':  return span('\u2212', rec(a));
    case 'sin':  return span('sin(', rec(a), ')');
    case 'cos':  return span('cos(', rec(a), ')');
    case 'tan':  return span('tan(', rec(a), ')');
    case 'asin': return span('arcsin(', rec(a), ')');
    case 'acos': return span('arccos(', rec(a), ')');
    case 'atan': return span('arctan(', rec(a), ')');
    case 'ln':   return span('ln(', rec(a), ')');
    case 'exp':  return span('exp(', rec(a), ')');
    case 'abs':  return span('|', rec(a), '|');
    case 'sqrt': return span('\u221A(', rec(a), ')');
    default: {
      const el = span(`${ast.name}(`);
      (ast.args || []).forEach((arg, i) => { if (i > 0) el.appendChild(txt(', ')); el.appendChild(rec(arg)); });
      el.appendChild(txt(')'));
      return el;
    }
  }
}

const CALC_RESULT_MAX_CHARS = 50;

/**
 * Given a { unitAst, warnings } result, populate a result span element.
 * Uses plain text with Unicode superscripts where possible, CSS fractions otherwise.
 * If the result text exceeds CALC_RESULT_MAX_CHARS, displays "Too Bulky!" instead.
 */
function renderUnitResult(resultSpan, unitAst, warnings, sigFigs = 6) {
  resultSpan.innerHTML = '';
  if (_astHasDiv(unitAst)) {
    // Build into a temporary span to measure text length before committing
    const tmp = document.createElement('span');
    tmp.appendChild(document.createTextNode('= '));
    tmp.appendChild(buildAstHtml(unitAst, sigFigs));
    if (tmp.textContent.length > CALC_RESULT_MAX_CHARS) {
      resultSpan.textContent = 'Too Bulky!';
    } else {
      resultSpan.appendChild(document.createTextNode('= '));
      resultSpan.appendChild(buildAstHtml(unitAst, sigFigs));
    }
  } else {
    const text = buildAstText(unitAst, sigFigs);
    const full = text !== null ? `= ${text}` : '= \u2026';
    resultSpan.textContent = full.length > CALC_RESULT_MAX_CHARS ? 'Too Bulky!' : full;
  }
}

// Returns warning text for a list of warning objects, or '' if none.
function formatUnitWarnings(warnings) {
  if (!warnings || !warnings.length) return '';
  return warnings.map(w => `\u26A0 ${w.funcName}([${w.units.join(', ')}]) \u2014 unit mismatch`).join('; ');
}

// Returns 'def' (assignment with identifier LHS), 'bare' (no operator), or 'equation' (complex LHS or inequality)
function classifyCalcExpr(latex) {
  const trimmed = (latex || '').trim();
  if (!trimmed) return 'bare';
  const op = findCalcOperatorAtDepth0(trimmed);
  if (!op) return 'bare';
  if (op.op !== '=') return 'equation';
  const lhs = trimmed.slice(0, op.idx).trim();
  return /^(?:[a-zA-Z]|\\(?:alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega))(?:_(?:[a-zA-Z0-9]|\{[^}]*\}))?$/.test(lhs) ? 'def' : 'equation';
}

// Returns true if the latex string is a plain numeric literal (e.g. "5", "3.14", "-2")
function isNumericLiteralLatex(latex) {
  return /^-?\d+(\.\d+)?$/.test((latex || '').trim());
}

function scheduleCalcUpdate(boxId) {
  if (calcPendingUpdate.has(boxId)) return;
  calcPendingUpdate.add(boxId);
  requestAnimationFrame(() => {
    calcPendingUpdate.delete(boxId);
    updateCalcResults(boxId);
  });
}

function updateCalcResults(boxId) {
  const box = boxes.find(b => b.id === boxId);
  if (!box || box.type !== 'calc') return;
  const results = evaluateCalcExpressions(box.expressions || [], { usePhysicsBasic: !!box.physicsBasic, usePhysicsEM: !!box.physicsEM, usePhysicsChem: !!box.physicsChem, useUnits: !!box.useUnits, useSymbolic: !!box.useSymbolic, useBaseUnits: !!box.useBaseUnits });
  const updateFns = calcUpdateFnsMap.get(boxId);
  if (!updateFns) return;
  for (const fn of updateFns.values()) fn(results);
}

function commitCalcBox(boxId) {
  const idx = boxes.findIndex(b => b.id === boxId);
  if (idx === -1) return;
  const fieldMap = calcMqFields.get(boxId);
  if (!fieldMap) return;
  const rows = boxList.querySelectorAll(`[data-id="${boxId}"] .expr-wrapper`);
  const expressions = [];
  for (const row of rows) {
    const exprId = row.dataset.exprId;
    if (row.dataset.rowType === 'text') {
      const ta = row.querySelector('.calc-text-input');
      expressions.push({ id: exprId, type: 'text', text: ta ? ta.value : '', latex: '' });
      continue;
    }
    const toggle = row.querySelector('.expr-toggle');
    const enabled = toggle ? toggle.getAttribute('aria-pressed') === 'true' : true;
    const field = fieldMap.get(exprId);
    const latex = field ? field.latex() : '';
    expressions.push({ id: exprId, latex, enabled });
  }
  boxes[idx].expressions = expressions;
  syncToText();
}

function cleanupCalcBox(boxId) {
  calcMqFields.delete(boxId);
  calcTextAreaMap.delete(boxId);
  calcUpdateFnsMap.delete(boxId);
  calcAddExprFns.delete(boxId);
  calcAddTextFns.delete(boxId);
  calcPendingUpdate.delete(boxId);
}

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
        if (e.type === 'text') {
          // Encode backslashes then newlines so the format stays single-line
          const encoded = (e.text || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
          return `% ${e.id} text ${encoded}`;
        }
        return `% ${e.id} ${e.enabled ? 'on' : 'off'} ${e.latex}`;
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
    if (pendingHighlight) { Object.assign(obj, pendingHighlight); pendingHighlight = null; }
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
      if (inner.length > 0) result.push(applyPending({ ...inner[0], id: genId(), commented: true }));
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
        result.push(applyPending({ id: genId(), type, content: line.slice(len, -1) }));
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
        result.push(applyPending({ id: genId(), type: 'math', content: inner.content }));
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
      result.push(applyPending({ id: genId(), type: 'text', content: textLines.join('\n') }));
      continue;
    }

    // Calc block: \begin{calc} ... \end{calc}
    if (line.startsWith('\\begin{calc}')) {
      // Support legacy {showresults} (both on) and new separate {showdefs}/{showbare} flags
      const legacyAll = line.includes('{showresults}');
      const showResultsDefs = legacyAll || line.includes('{showdefs}');
      const showResultsBare = legacyAll || line.includes('{showbare}');
      // Legacy {physics} flag enables all three groups.
      const legacyPhysics = line.includes('{physics}') && !line.includes('{physics_');
      const physicsBasic = legacyPhysics || line.includes('{physics_basic}');
      const physicsEM    = legacyPhysics || line.includes('{physics_em}');
      const physicsChem  = legacyPhysics || line.includes('{physics_chem}');
      const useUnits     = line.includes('{units}');
      const useSymbolic  = line.includes('{symbolic}');
      const useBaseUnits = line.includes('{baseunits}');
      const hidden      = line.includes('{hidden}');
      const collapsed   = line.includes('{collapsed}');
      const sfMatch     = line.match(/\{sf=(\d+)\}/);
      const sigFigs     = sfMatch ? parseInt(sfMatch[1], 10) : 6;
      const expressions = [];
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
              expressions.push({ id: exprId, type: 'text', text, latex: '', enabled: true });
              const m = exprId.match(/^ct(\d+)$/);
              if (m) calcTextNextId = Math.max(calcTextNextId, parseInt(m[1]) + 1);
            } else {
              // Expression row: "% <id> <on|off> <latex...>"
              const enabled = parts[1] === 'on';
              const latex   = parts.slice(2).join(' ');
              expressions.push({ id: exprId, latex, enabled });
              const m = exprId.match(/^ce(\d+)$/);
              if (m) calcExprNextId = Math.max(calcExprNextId, parseInt(m[1]) + 1);
            }
          }
        }
        i++;
      }
      i++; // consume \end{calc}
      result.push(applyPending({ id: genId(), type: 'calc', content: '', showResultsDefs, showResultsBare, physicsBasic, physicsEM, physicsChem, useUnits, useSymbolic, useBaseUnits, hidden, collapsed, sigFigs, expressions }));
      continue;
    }

    // Graph block: \begin{graph}{W}{H} ... \end{graph}
    if (line.startsWith('\\begin{graph}')) {
      const m = line.match(/^\\begin\{graph\}\{(\d+)\}\{(\d+)\}(\{light\})?/);
      const width  = m ? parseInt(m[1]) : 600;
      const height = m ? parseInt(m[2]) : 400;
      const lightTheme = !!(m && m[3]);
      const expressions = [];
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
            expressions.push({ id: exprId, latex, color, enabled, thickness, sliderMin, sliderMax });
          }
        }
        i++;
      }
      i++; // consume \end{graph}
      result.push(applyPending({ id: genId(), type: 'graph', content: '', width, height, lightTheme, expressions }));
      continue;
    }

    // Image block: \begin{image} ... \end{image}
    if (line.startsWith('\\begin{image}')) {
      const mode   = line.includes('{file}') ? 'file' : 'url';
      const locked = line.includes('{locked}');
      let src = '', alt = '', width = 0, height = 0, fit = 'locked', align = 'left';
      i++;
      while (i < lines.length && !lines[i].startsWith('\\end{image}')) {
        const el = lines[i].trim();
        if (el.startsWith('% alt: ')) {
          alt = el.slice(7);
        } else if (el.startsWith('% size: ')) {
          const m = el.slice(8).match(/^(\d+)x(\d+)$/);
          if (m) { width = parseInt(m[1]); height = parseInt(m[2]); }
        } else if (el.startsWith('% fit: ')) {
          fit = el.slice(7).trim();
        } else if (el.startsWith('% align: ')) {
          align = el.slice(9).trim();
        } else if (el.startsWith('% ')) {
          src = el.slice(2);
        }
        i++;
      }
      i++; // consume \end{image}
      result.push(applyPending({ id: genId(), type: 'image', mode, locked, src, filename: '', alt, width, height, fit, align }));
      continue;
    }

    // Pagebreak: \newpage
    if (line.trimEnd() === '\\newpage') {
      result.push(applyPending({ id: genId(), type: 'pagebreak', content: '' }));
      i++;
      continue;
    }

    // Skip blank lines
    if (line.trim() === '') { i++; continue; }

    // Unrecognized non-empty line → treat as text box
    result.push(applyPending({ id: genId(), type: 'text', content: line }));
    i++;
  }
  return result;
}

function collectMathBlock(lines, startLine) {
  // Handle single-line: \[content\]
  const line = lines[startLine];
  const singleMatch = line.match(/^\\\[(.*)\\]$/);
  if (singleMatch) {
    return { content: singleMatch[1], nextLine: startLine + 1 };
  }
  // Handle \[ on its own line, then content, then \] on its own line
  if (line.trimEnd() === '\\[') {
    const contentLines = [];
    let j = startLine + 1;
    while (j < lines.length && lines[j].trimEnd() !== '\\]') {
      contentLines.push(lines[j]);
      j++;
    }
    if (j < lines.length) {
      return { content: contentLines.join('\n'), nextLine: j + 1 };
    }
  }
  // Handle \[content on its own then \] — inline start, multiline end
  if (line.startsWith('\\[')) {
    const after = line.slice(2);
    const contentLines = [after];
    let j = startLine + 1;
    while (j < lines.length && !lines[j].includes('\\]')) {
      contentLines.push(lines[j]);
      j++;
    }
    if (j < lines.length) {
      const lastLine = lines[j];
      const idx = lastLine.indexOf('\\]');
      contentLines.push(lastLine.slice(0, idx));
      return { content: contentLines.join('\n'), nextLine: j + 1 };
    }
  }
  return null;
}

// ── Image box DOM ─────────────────────────────────────────────────────────────

function cleanupImageBox(boxId) {
  const url = imageObjectUrls.get(boxId);
  if (url) { URL.revokeObjectURL(url); imageObjectUrls.delete(boxId); }
}

function createImageBoxElement(box, div) {
  div.classList.add('box-image');

  // ── Toolbar ──
  const toolbar = document.createElement('div');
  toolbar.className = 'image-toolbar';

  const label = document.createElement('span');
  label.className = 'box-type-label';
  label.textContent = 'IMAGE';
  toolbar.appendChild(label);

  const modeToggle = document.createElement('div');
  modeToggle.className = 'image-mode-toggle';

  const urlBtn  = document.createElement('button');
  urlBtn.className  = 'image-mode-btn' + (box.mode === 'url'  ? ' active' : '') + (box.locked ? ' locked-btn' : '');
  urlBtn.dataset.mode = 'url';
  urlBtn.textContent = 'URL';

  const fileBtn = document.createElement('button');
  fileBtn.className = 'image-mode-btn' + (box.mode === 'file' ? ' active' : '') + (box.locked ? ' locked-btn' : '');
  fileBtn.dataset.mode = 'file';
  fileBtn.textContent = 'File';

  modeToggle.appendChild(urlBtn);
  modeToggle.appendChild(fileBtn);
  toolbar.appendChild(modeToggle);

  const FIT_CYCLE = ['locked', 'crop', 'scale'];
  const FIT_LABELS = { locked: '⇔ Lock', crop: '✂ Crop', scale: '⤢ Scale' };
  const fitBtn = document.createElement('button');
  fitBtn.className = 'image-fit-btn';
  fitBtn.title = 'Cycle aspect ratio mode: locked → crop → scale';
  fitBtn.textContent = FIT_LABELS[box.fit] || FIT_LABELS.locked;
  fitBtn.addEventListener('click', () => {
    const idx = FIT_CYCLE.indexOf(box.fit);
    box.fit = FIT_CYCLE[(idx + 1) % FIT_CYCLE.length];
    fitBtn.textContent = FIT_LABELS[box.fit];
    fitBtn.dataset.fit = box.fit;
    renderBody();
    syncToText();
  });
  fitBtn.dataset.fit = box.fit || 'locked';
  toolbar.appendChild(fitBtn);

  const ALIGN_CYCLE = ['left', 'center', 'right'];
  const ALIGN_LABELS = { left: '⬛ Left', center: '▣ Center', right: '⬛ Right' };
  const ALIGN_ICONS  = { left: '⇤', center: '↔', right: '⇥' };
  const alignBtn = document.createElement('button');
  alignBtn.className = 'image-fit-btn';
  alignBtn.title = 'Cycle image alignment: left → center → right';
  alignBtn.textContent = ALIGN_ICONS[box.align || 'left'] + ' ' + (box.align || 'left').charAt(0).toUpperCase() + (box.align || 'left').slice(1);
  alignBtn.dataset.align = box.align || 'left';
  alignBtn.addEventListener('click', () => {
    const idx = ALIGN_CYCLE.indexOf(box.align || 'left');
    box.align = ALIGN_CYCLE[(idx + 1) % ALIGN_CYCLE.length];
    alignBtn.textContent = ALIGN_ICONS[box.align] + ' ' + box.align.charAt(0).toUpperCase() + box.align.slice(1);
    alignBtn.dataset.align = box.align;
    applyBodyAlign();
    syncToText();
  });
  toolbar.appendChild(alignBtn);

  div.appendChild(toolbar);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'image-body';
  div.appendChild(body);

  function applyBodyAlign() {
    const a = box.align || 'left';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.alignItems = a === 'center' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start';
  }

  function applyImageSize(img) {
    const w = box.width || 0;
    const h = box.height || 0;
    if (!w && !h) {
      img.style.width = '';
      img.style.height = '';
      img.style.objectFit = '';
    } else {
      img.style.width  = w ? `${w}px` : 'auto';
      img.style.height = h ? `${h}px` : 'auto';
      img.style.objectFit = box.fit === 'crop' ? 'cover' : box.fit === 'scale' ? 'fill' : 'fill';
    }
  }

  function makeSizeRow(img) {
    const row = document.createElement('div');
    row.className = 'image-size-row';

    function makeDimInput(labelText, isW) {
      const wrap = document.createElement('span');
      wrap.className = 'image-size-field';
      const lbl = document.createElement('label');
      lbl.className = 'image-size-label';
      lbl.textContent = labelText;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'image-size-input';
      inp.min = '1';
      inp.placeholder = 'auto';
      inp.value = (isW ? box.width : box.height) || '';
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      row.appendChild(wrap);
      return inp;
    }

    const wInp = makeDimInput('W', true);
    const sep = document.createElement('span');
    sep.className = 'image-size-sep';
    sep.textContent = '×';
    row.appendChild(sep);
    const hInp = makeDimInput('H', false);

    [wInp, hInp].forEach((inp, i) => {
      const isW = i === 0;
      const commit = () => {
        const v = parseInt(inp.value) || 0;
        if (isW) box.width = v; else box.height = v;
        if (box.fit === 'locked' && v && img.naturalWidth && img.naturalHeight) {
          const other = isW
            ? Math.round(v * img.naturalHeight / img.naturalWidth)
            : Math.round(v * img.naturalWidth  / img.naturalHeight);
          if (isW) { box.height = other; hInp.value = other || ''; }
          else     { box.width  = other; wInp.value = other || ''; }
        }
        syncToText();
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });

    return row;
  }

  function renderBody() {
    body.innerHTML = '';
    applyBodyAlign();

    if (box.mode === 'url') {
      // Always show the URL input; image appears below it when src is set
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'image-url-input';
      input.placeholder = 'Paste image URL…';
      input.value = box.src || '';

      const commit = () => {
        const val = input.value.trim();
        const changed = val !== box.src;
        box.src = val;
        const shouldLock = !!val;
        if (shouldLock !== box.locked) {
          box.locked = shouldLock;
          urlBtn.classList.toggle('locked-btn', shouldLock);
          fileBtn.classList.toggle('locked-btn', shouldLock);
        }
        if (changed) {
          // Re-render to update the preview image without wiping the input
          renderBody();
          syncToText();
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.style.alignSelf = 'stretch';
      body.appendChild(input);

      if (box.src) {
        const img = document.createElement('img');
        img.className = 'image-preview-img';
        img.alt = box.alt || '';
        img.src = box.src;
        img.style.marginTop = '6px';
        body.appendChild(img);
        body.appendChild(makeSizeRow(img));
      }
    } else if (box.locked && box.src) {
      // File mode — image is uploaded, show it with X button
      const display = document.createElement('div');
      display.className = 'image-display';

      const img = document.createElement('img');
      img.className = 'image-preview-img';
      img.alt = box.alt || '';
      display.appendChild(img);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'image-clear-btn';
      clearBtn.title = 'Clear image';
      clearBtn.textContent = '×';
      clearBtn.addEventListener('click', async () => {
        await idbDeleteImage(box.src).catch(() => {});
        cleanupImageBox(box.id);
        box.src = ''; box.filename = ''; box.locked = false;
        urlBtn.classList.remove('locked-btn');
        fileBtn.classList.remove('locked-btn');
        renderBody();
        syncToText();
      });
      display.appendChild(clearBtn);
      body.appendChild(display);
      body.appendChild(makeSizeRow(img));

      // Load from IDB or disk
      const existing = imageObjectUrls.get(box.id);
      if (existing) {
        img.src = existing;
      } else {
        loadImageAsObjectURL(box).then(objUrl => {
          if (objUrl) {
            imageObjectUrls.set(box.id, objUrl);
            img.src = objUrl;
          } else {
            // Image not found — check if disk-backed (no IDB copy) vs truly missing
            display.remove();
            const missing = document.createElement('div');
            missing.className = 'image-missing';
            const allProjs = loadProjects();
            const proj = (currentProjectId ? allProjs.find(p => p.id === currentProjectId) : null)
                      || allProjs.find(p => p.onDisk && p.assetFolder && box.src?.startsWith(p.assetFolder + '/'));
            const isDiskBacked = !!(proj?.onDisk && proj.assetFolder && box.src?.startsWith(proj.assetFolder + '/'));
            if (isDiskBacked) {
              missing.textContent = 'Workspace folder not connected — ';
              const reconnectBtn = document.createElement('button');
              reconnectBtn.className = 'image-reconnect-btn';
              reconnectBtn.textContent = 'Reconnect folder';
              reconnectBtn.addEventListener('click', async () => {
                const ok = await reconnectWorkspace();
                if (ok) retryAllDiskImages();
              });
              missing.appendChild(reconnectBtn);
            } else {
              missing.textContent = 'Image file not found — click × to clear';
              missing.appendChild(clearBtn);
            }
            body.appendChild(missing);
          }
        });
      }
    } else {
      // File mode — no image yet, show drop zone
      const dropzone = document.createElement('div');
      dropzone.className = 'image-dropzone';
      dropzone.textContent = 'Drop image here or click to browse';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';
      dropzone.appendChild(fileInput);

      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', e => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file) handleFileUpload(file);
      });
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) handleFileUpload(file);
      });

      body.appendChild(dropzone);
    }
  }

  async function handleFileUpload(file) {
    cleanupImageBox(box.id);
    const objUrl = URL.createObjectURL(file);
    imageObjectUrls.set(box.id, objUrl);
    box.filename = file.name;
    box.locked   = true;
    urlBtn.classList.add('locked-btn');
    fileBtn.classList.add('locked-btn');

    const projects = loadProjects();
    const proj = currentProjectId ? projects.find(p => p.id === currentProjectId) : null;

    if (proj?.onDisk && currentWorkspaceHandle && proj.assetFolder) {
      // Save image to workspace asset folder
      try {
        const assetDir = await currentWorkspaceHandle.getDirectoryHandle(proj.assetFolder, { create: true });
        const fh = await assetDir.getFileHandle(file.name, { create: true });
        const writable = await fh.createWritable();
        await writable.write(file);
        await writable.close();
      } catch (err) {
        console.warn('Failed to write image to workspace:', err);
      }
      box.src = `${proj.assetFolder}/${file.name}`;
      // Also save to IDB as fallback for when workspace permission isn't restored on reload
      const buf = await file.arrayBuffer();
      await idbSaveImage(currentProjectId, file.name, file.type, buf);
    } else {
      // Save to IndexedDB
      const projId = currentProjectId || 'draft';
      const buf = await file.arrayBuffer();
      await idbSaveImage(projId, file.name, file.type, buf);
      box.src = `${projId}/${file.name}`;
    }

    renderBody();
    syncToText();
  }

  // Mode toggle
  [urlBtn, fileBtn].forEach(btn => {
    btn.addEventListener('click', () => {
      if (box.locked) return;
      box.mode = btn.dataset.mode;
      box.src = '';
      urlBtn.classList.toggle('active', box.mode === 'url');
      fileBtn.classList.toggle('active', box.mode === 'file');
      renderBody();
      syncToText();
    });
  });

  renderBody();
}

// ── Box → DOM ─────────────────────────────────────────────────────────────────
function createBoxElement(box) {
  const _existingDomEl = boxList.querySelector(`[data-id="${box.id}"]`);
  _dbg('CREATE_BOX_ELEMENT', {
    id: box.id, type: box.type,
    alreadyInDom: !!_existingDomEl,
    inRebuild: _dbgInRebuild,
    boxesHasId: boxes.some(b => b.id === box.id),
  });
  if (_existingDomEl) {
    console.warn(`[DBG] createBoxElement called for id="${box.id}" which already exists in DOM!`);
  }
  const div = document.createElement('div');
  div.className = 'box' + (box.commented ? ' commented' : '') + (box.highlighted ? ' box-is-highlighted' : '');
  div.dataset.id = box.id;

  // Drag handle
  const dragHandle = document.createElement('span');
  dragHandle.className = 'box-drag-handle';
  dragHandle.textContent = '⠿';
  dragHandle.title = 'Drag to reorder';
  dragHandle.draggable = true;
  dragHandle.addEventListener('dragstart', e => {
    dragSrcBoxId = box.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  div.appendChild(dragHandle);

  // Double-click → scroll the preview to this box and blink it
  div.addEventListener('dblclick', e => {
    if (!isPreviewOpen) return;
    scrollAndHighlightPreview(box.id);
  });

  // Click on box padding → focus the field
  let mousedownInMqField = false;
  div.addEventListener('mousedown', e => {
    mousedownInMqField = !!e.target.closest('.mq-editable-field');
    // Prevent default for calc box clicks outside MQ fields / interactive controls so the
    // currently-focused MQ field doesn't blur (causing the focused outline to flash off).
    // The click handler re-focuses the correct expression explicitly.
    // Exclude textarea so calc text rows can receive focus naturally.
    if (box.type === 'calc' && !mousedownInMqField
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
    if (box.type === 'math') {
      const field = mqFields.get(box.id);
      if (field) field.focus();
    } else if (box.type === 'pagebreak' || box.type === 'graph') {
      setFocused(box.id, div);
    } else if (box.type === 'calc') {
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
        const field = calcMqFields.get(box.id)?.get(nearest.dataset.exprId);
        if (field) field.el().querySelector('textarea')?.focus({ preventScroll: true });
      }
    } else {
      const ta = div.querySelector('.text-input');
      if (ta) ta.focus();
    }
  });

  div.addEventListener('dragover', e => {
    if (!dragSrcBoxId || dragSrcBoxId === box.id) return;
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
    if (!dragSrcBoxId || dragSrcBoxId === box.id) return;
    const srcIdx = boxes.findIndex(b => b.id === dragSrcBoxId);
    const dstIdx = boxes.findIndex(b => b.id === box.id);
    dragSrcBoxId = null;
    if (srcIdx === -1 || dstIdx === -1) return;
    const [moved] = boxes.splice(srcIdx, 1);
    boxes.splice(dstIdx, 0, moved);
    rebuildBoxList();
    syncToText();
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '×';
  deleteBtn.title = 'Delete box';
  deleteBtn.addEventListener('click', () => deleteBox(box.id));

  if (box.type === 'math') {
    const mqSpan = document.createElement('span');
    div.appendChild(mqSpan);
    div.appendChild(deleteBtn);

    // Resize the box to fit the rendered equation height.
    // MathQuill's internal vertical-align tricks don't always push the CSS block
    // height, so we measure the actual rendered offsetHeight and set min-height.
    const resizeBox = () => {
      requestAnimationFrame(() => {
        div.style.minHeight = '';
        const h = mqSpan.offsetHeight;
        if (h > 0) div.style.minHeight = (h + 20) + 'px';
      });
    };
    boxResizers.set(box.id, resizeBox);

    const greekLetters = "alpha beta Gamma gamma Delta delta epsilon zeta eta Theta theta iota kappa Lambda lambda mu nu Xi xi Pi pi rho Sigma sigma tau Upsilon upsilon Phi phi Chi chi Psi Omega omega";

    const field = MQ.MathField(mqSpan, {
      spaceBehavesLikeTab: false,
      autoCommands: 'sqrt nthroot sum int prod in notin subset subseteq supset supseteq cup cap emptyset forall exists infty partial setminus ell approx times vec hbar nabla '+greekLetters,
      autoOperatorNames: 'sin cos tan arcsin arccos arctan ln log exp mat',
      handlers: {
        edit: () => {
          const idx = boxes.findIndex(b => b.id === box.id);
          if (idx !== -1) {
            boxes[idx].content = field.latex();
            syncToText();
          }
          resizeBox();
        },
        enter: () => {
          insertBoxAfter(box.id, defaultBoxType);
        },
        // dir === 1 → right arrow past end; dir === -1 → left arrow past start
        moveOutOf: (dir) => {
          const idx = boxes.findIndex(b => b.id === box.id);
          if (dir === 1 && idx < boxes.length - 1) focusBoxAtEdge(boxes[idx + 1].id, 'start');
          else if (dir === -1 && idx > 0)          focusBoxAtEdge(boxes[idx - 1].id, 'end');
        },
        upOutOf: () => {
          const idx = boxes.findIndex(b => b.id === box.id);
          if (idx > 0) focusBoxAtEdge(boxes[idx - 1].id, 'end');
        },
        downOutOf: () => {
          const idx = boxes.findIndex(b => b.id === box.id);
          if (idx < boxes.length - 1) focusBoxAtEdge(boxes[idx + 1].id, 'start');
        },
      },
    });

    if (box.content){
      field.latex(box.content);
    }
    setTimeout(resizeBox, 0);

    // Capture-phase keydown: fires before MathQuill's inner textarea handler.
    mqSpan.addEventListener('keydown', e => {
      // Enter with any modifier combo → new box
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey || e.altKey)) {
        e.preventDefault();
        insertBoxAfter(box.id, defaultBoxType);
      }
      // Backspace on empty → delete box
      if (e.key === 'Backspace' && field.latex() === '') {
        e.preventDefault();
        deleteBox(box.id);
      }
      // Ctrl+X: whole-box cut only when nothing is selected in MathQuill.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        const hasSelection = !!mqSpan.querySelector('.mq-selection');
        if (!hasSelection) {
          e.preventDefault();
          e.stopPropagation();
          cutBox(box.id);
        } else {
          boxClipboard = null;
        }
      }
      // Ctrl+/: toggle comment
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        e.stopPropagation();
        toggleComment(box.id);
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
    mqSpan.addEventListener('focusin', () => setFocused(box.id, div));
    mqSpan.addEventListener('focusout', () => clearFocused(box.id, div));

    mqFields.set(box.id, field);

  } else if (box.type === 'text') {
    // Text box: textarea that auto-resizes
    const ta = document.createElement('textarea');
    ta.className = 'text-input';
    ta.rows = 1;
    ta.value = box.content || '';
    ta.placeholder = 'Text…';

    const autoResize = () => {
      const savedScroll = boxList.scrollTop;
      ta.style.height = '1px'; // collapse first so scrollHeight reflects content, not current size
      ta.style.height = ta.scrollHeight + 'px';
      boxList.scrollTop = savedScroll;
    };
    boxResizers.set(box.id, autoResize);

    ta.addEventListener('input', () => {
      autoResize();
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx !== -1) {
        boxes[idx].content = ta.value;
        syncToText();
      }
    });

    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        insertBoxAfter(box.id, defaultBoxType);
      }
      if (e.key === 'Backspace' && ta.value === '') {
        e.preventDefault();
        deleteBox(box.id);
      }
      // Ctrl+X with no selection → cut whole box; with selection → let browser cut text
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        if (ta.selectionStart === ta.selectionEnd) {
          e.preventDefault();
          cutBox(box.id);
        } else {
          boxClipboard = null;
        }
      }
      // Ctrl+/: toggle comment
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        toggleComment(box.id);
      }
      // Arrow key inter-box navigation (only plain arrow keys — no modifier keys)
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = boxes.findIndex(b => b.id === box.id);
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

    ta.addEventListener('focus', () => setFocused(box.id, div));
    ta.addEventListener('blur',  () => clearFocused(box.id, div));

    div.appendChild(ta);
    div.appendChild(deleteBtn);

    // Trigger resize after append
    requestAnimationFrame(autoResize);

  } else if (box.type === 'h1' || box.type === 'h2' || box.type === 'h3') {
    // Badge sits on the top border of the box (absolutely positioned)
    const label = document.createElement('span');
    label.className = 'box-type-label';
    label.textContent = box.type.toUpperCase();
    div.appendChild(label);

    // Inner flex container for the textarea only
    const inner = document.createElement('div');
    inner.className = 'box-heading-inner';

    const fontSizes = { h1: '20px', h2: '17px', h3: '15px' };

    const ta = document.createElement('textarea');
    ta.className = 'text-input';
    ta.rows = 1;
    ta.value = box.content || '';
    ta.placeholder = box.type.toUpperCase() + '…';
    ta.style.fontWeight = 'bold';
    ta.style.fontSize = fontSizes[box.type];

    const autoResize = () => {
      const savedScroll = boxList.scrollTop;
      ta.style.height = '1px';
      ta.style.height = ta.scrollHeight + 'px';
      boxList.scrollTop = savedScroll;
    };
    boxResizers.set(box.id, autoResize);

    ta.addEventListener('input', () => {
      autoResize();
      // Strip newlines from headings
      if (ta.value.includes('\n')) ta.value = ta.value.replace(/\n/g, '');
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx !== -1) {
        boxes[idx].content = ta.value;
        syncToText();
      }
    });

    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        insertBoxAfter(box.id, defaultBoxType);
      }
      if (e.key === 'Backspace' && ta.value === '') {
        e.preventDefault();
        deleteBox(box.id);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        if (ta.selectionStart === ta.selectionEnd) {
          e.preventDefault();
          cutBox(box.id);
        } else {
          boxClipboard = null;
        }
      }
      // Ctrl+/: toggle comment
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        toggleComment(box.id);
      }
      // Arrow key inter-box navigation (plain arrow keys only)
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = boxes.findIndex(b => b.id === box.id);
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

    ta.addEventListener('focus', () => setFocused(box.id, div));
    ta.addEventListener('blur',  () => clearFocused(box.id, div));

    inner.appendChild(ta);
    div.appendChild(inner);
    div.appendChild(deleteBtn);

    requestAnimationFrame(autoResize);
  } else if (box.type === 'pagebreak') {
    div.classList.add('box-pagebreak');

    const rule = document.createElement('div');
    rule.className = 'pagebreak-rule';
    div.appendChild(rule);
    div.appendChild(deleteBtn);
  } else if (box.type === 'graph') {
    div.classList.add('box-graph');

    const badge = document.createElement('span');
    badge.className = 'box-type-label';
    badge.textContent = 'GRAPH';
    div.appendChild(badge);

    const controls = document.createElement('div');
    controls.className = 'graph-box-controls';

    const wLabel = document.createElement('label');
    wLabel.textContent = 'W ';
    const wInput = document.createElement('input');
    wInput.type = 'number'; wInput.min = '100'; wInput.max = '2000'; wInput.step = '10';
    wInput.value = box.width || 600;
    wInput.className = 'graph-size-input';
    wInput.addEventListener('mousedown', e => e.stopPropagation());
    wInput.addEventListener('change', () => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx !== -1) { boxes[idx].width = parseInt(wInput.value) || 600; syncToText(); }
    });
    wLabel.appendChild(wInput);
    controls.appendChild(wLabel);

    const hLabel = document.createElement('label');
    hLabel.textContent = ' H ';
    const hInput = document.createElement('input');
    hInput.type = 'number'; hInput.min = '100'; hInput.max = '2000'; hInput.step = '10';
    hInput.value = box.height || 400;
    hInput.className = 'graph-size-input';
    hInput.addEventListener('mousedown', e => e.stopPropagation());
    hInput.addEventListener('change', () => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx !== -1) { boxes[idx].height = parseInt(hInput.value) || 400; syncToText(); }
    });
    hLabel.appendChild(hInput);
    controls.appendChild(hLabel);

    const countSpan = document.createElement('span');
    countSpan.className = 'graph-expr-count';
    const n = (box.expressions || []).length;
    countSpan.textContent = `${n} expression${n !== 1 ? 's' : ''}`;
    controls.appendChild(countSpan);

    const themeLabel = document.createElement('label');
    themeLabel.className = 'graph-theme-label';
    const themeCheck = document.createElement('input');
    themeCheck.type = 'checkbox';
    themeCheck.checked = !!box.lightTheme;
    themeCheck.addEventListener('mousedown', e => e.stopPropagation());
    themeCheck.addEventListener('change', () => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx !== -1) { boxes[idx].lightTheme = themeCheck.checked; syncToText(); }
    });
    themeLabel.appendChild(themeCheck);
    themeLabel.appendChild(document.createTextNode(' Light'));
    controls.appendChild(themeLabel);

    const editBtn = document.createElement('button');
    editBtn.className = 'graph-edit-btn';
    editBtn.textContent = 'Edit Graph';
    editBtn.addEventListener('mousedown', e => e.preventDefault());
    editBtn.addEventListener('click', () => enterGraphMode(box.id));
    controls.appendChild(editBtn);

    div.appendChild(controls);

    // Show snapshot thumbnail if available
    if (box._snapshotDataUrl) {
      const thumb = document.createElement('img');
      thumb.src = box._snapshotDataUrl;
      thumb.className = 'graph-snapshot-thumb';
      thumb.style.maxWidth = '100%';
      thumb.style.borderRadius = '4px';
      thumb.style.marginTop = '4px';
      div.appendChild(thumb);
    }

    div.appendChild(deleteBtn);
  } else if (box.type === 'calc') {
    div.classList.add('box-calc');

    // ── Toolbar ──────────────────────────────────────────────────────────────
    const toolbar = document.createElement('div');
    toolbar.className = 'calc-toolbar';

    // ── Collapse button (leftmost in toolbar) ─────────────────────────────────
    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'calc-collapse-btn';
    collapseBtn.title = 'Collapse/expand expression list';
    collapseBtn.textContent = box.collapsed ? '▸' : '▾';
    collapseBtn.addEventListener('mousedown', e => e.preventDefault());
    toolbar.appendChild(collapseBtn);

    const badge = document.createElement('span');
    badge.className = 'box-type-label';
    badge.textContent = 'CALC';
    toolbar.appendChild(badge);

    const makeResultsToggle = (label, title, getFlag, setFlag) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'calc-show-results-btn' + (getFlag() ? ' active' : '');
      btn.title = title;
      btn.textContent = label;
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        const idx = boxes.findIndex(b => b.id === box.id);
        if (idx === -1) return;
        setFlag(idx, !getFlag());
        btn.classList.toggle('active', getFlag());
        syncToText();
        scheduleCalcUpdate(box.id);
      });
      return btn;
    };
    toolbar.appendChild(makeResultsToggle(
      'Assignments',
      'Show/hide results for assignment expressions (e.g. y = x²)',
      () => boxes.find(b => b.id === box.id)?.showResultsDefs !== false,
      (idx, val) => { boxes[idx].showResultsDefs = val; }
    ));
    toolbar.appendChild(makeResultsToggle(
      'Bare',
      'Show/hide results for bare expressions (e.g. √2)',
      () => boxes.find(b => b.id === box.id)?.showResultsBare !== false,
      (idx, val) => { boxes[idx].showResultsBare = val; }
    ));

    // Physics constants toggles (3 groups)
    const makePhysicsBtn = (label, tooltipGroup, tooltipLabel, flagKey) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'calc-show-results-btn' + (box[flagKey] ? ' active' : '');
      btn.title = buildPhysicsTooltip(tooltipGroup, tooltipLabel);
      btn.textContent = label;
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        const idx = boxes.findIndex(b => b.id === box.id);
        if (idx === -1) return;
        boxes[idx][flagKey] = !boxes[idx][flagKey];
        btn.classList.toggle('active', boxes[idx][flagKey]);
        syncToText();
        scheduleCalcUpdate(box.id);
      });
      toolbar.appendChild(btn);
      return btn;
    };
    makePhysicsBtn('Physics', PHYSICS_CONSTANTS_BASIC, 'basic physics', 'physicsBasic');
    makePhysicsBtn('E&M',     PHYSICS_CONSTANTS_EM,    'E&M',            'physicsEM');
    makePhysicsBtn('Chem',    PHYSICS_CONSTANTS_CHEM,  'chemistry',      'physicsChem');

    // Units mode toggle
    const unitsBtn = document.createElement('button');
    unitsBtn.type = 'button';
    unitsBtn.className = 'calc-show-results-btn' + (box.useUnits ? ' active' : '');
    unitsBtn.title = 'SI units mode: treat unit symbols (m, kg, s, N, …) as dimensional quantities';
    unitsBtn.textContent = 'Units';
    unitsBtn.addEventListener('mousedown', e => e.preventDefault());
    unitsBtn.addEventListener('click', () => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx === -1) return;
      boxes[idx].useUnits = !boxes[idx].useUnits;
      unitsBtn.classList.toggle('active', boxes[idx].useUnits);
      // Disable dependent buttons when units mode is off
      symbolicBtn.disabled = !boxes[idx].useUnits;
      symbolicBtn.classList.toggle('btn-disabled', !boxes[idx].useUnits);
      baseUnitsBtn.disabled = !boxes[idx].useUnits;
      baseUnitsBtn.classList.toggle('btn-disabled', !boxes[idx].useUnits);
      syncToText();
      scheduleCalcUpdate(box.id);
    });
    toolbar.appendChild(unitsBtn);

    // Symbolic mode toggle (only meaningful when units mode is on)
    const symbolicBtn = document.createElement('button');
    symbolicBtn.type = 'button';
    const symActive = box.useUnits && box.useSymbolic;
    symbolicBtn.className = 'calc-show-results-btn' + (symActive ? ' active' : '') + (!box.useUnits ? ' btn-disabled' : '');
    symbolicBtn.disabled = !box.useUnits;
    symbolicBtn.title = 'Symbolic mode: keep undefined variables symbolic rather than erroring';
    symbolicBtn.textContent = 'Symbolic';
    symbolicBtn.addEventListener('mousedown', e => e.preventDefault());
    symbolicBtn.addEventListener('click', () => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx === -1 || !boxes[idx].useUnits) return;
      boxes[idx].useSymbolic = !boxes[idx].useSymbolic;
      symbolicBtn.classList.toggle('active', boxes[idx].useSymbolic);
      syncToText();
      scheduleCalcUpdate(box.id);
    });
    toolbar.appendChild(symbolicBtn);

    // Base Units toggle (only meaningful when units mode is on)
    const baseUnitsBtn = document.createElement('button');
    baseUnitsBtn.type = 'button';
    const baseActive = box.useUnits && box.useBaseUnits;
    baseUnitsBtn.className = 'calc-show-results-btn' + (baseActive ? ' active' : '') + (!box.useUnits ? ' btn-disabled' : '');
    baseUnitsBtn.disabled = !box.useUnits;
    baseUnitsBtn.title = 'Base units mode: expand all results to SI base units (m, kg, s, A, K, mol, cd)';
    baseUnitsBtn.textContent = 'Base Units';
    baseUnitsBtn.addEventListener('mousedown', e => e.preventDefault());
    baseUnitsBtn.addEventListener('click', () => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx === -1 || !boxes[idx].useUnits) return;
      boxes[idx].useBaseUnits = !boxes[idx].useBaseUnits;
      baseUnitsBtn.classList.toggle('active', boxes[idx].useBaseUnits);
      syncToText();
      scheduleCalcUpdate(box.id);
    });
    toolbar.appendChild(baseUnitsBtn);

    // Hidden toggle — prevents the calc box from rendering anything in the preview
    toolbar.appendChild(makeResultsToggle(
      'Hidden',
      'Hide this calc box from the preview (expressions still evaluate in the editor)',
      () => !!(boxes.find(b => b.id === box.id)?.hidden),
      (idx, val) => { boxes[idx].hidden = val; }
    ));

    // Sig figs input
    const sigFigsLabel = document.createElement('label');
    sigFigsLabel.className = 'calc-sigfigs-label';
    sigFigsLabel.textContent = 'sf:';
    const sigFigsInput = document.createElement('input');
    sigFigsInput.type = 'number';
    sigFigsInput.className = 'calc-sigfigs-input';
    sigFigsInput.min = 1;
    sigFigsInput.max = 15;
    sigFigsInput.value = box.sigFigs ?? 6;
    sigFigsInput.title = 'Number of significant figures for numeric results';
    sigFigsInput.addEventListener('mousedown', e => e.stopPropagation());
    sigFigsInput.addEventListener('change', () => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx === -1) return;
      const v = parseInt(sigFigsInput.value, 10);
      if (!isNaN(v) && v >= 1 && v <= 15) {
        boxes[idx].sigFigs = v;
        syncToText();
        scheduleCalcUpdate(box.id);
      } else {
        sigFigsInput.value = boxes[idx].sigFigs ?? 6;
      }
    });
    sigFigsLabel.appendChild(sigFigsInput);
    toolbar.appendChild(sigFigsLabel);

    div.appendChild(toolbar);

    // ── Expression list ───────────────────────────────────────────────────────
    const exprList = document.createElement('div');
    exprList.className = 'calc-expr-list';

    const calcFieldMap = new Map();   // exprId → MQField
    const calcTaMap   = new Map();    // exprId → HTMLTextAreaElement
    const calcUpdateFns = new Map();  // exprId → (resultMap) => void
    calcMqFields.set(box.id, calcFieldMap);
    calcTextAreaMap.set(box.id, calcTaMap);
    calcUpdateFnsMap.set(box.id, calcUpdateFns);

    /**
     * Focus a calc row (expression or text) by exprId.
     * @param {string} exprId - The expression/text row id to focus.
     * @param {number} dir - 1 = arriving from above (focus start), -1 = arriving from below (focus end).
     */
    function focusCalcRowById(exprId, dir) {
      const field = calcFieldMap.get(exprId);
      if (field) { field.focus(); return; }
      const ta = calcTaMap.get(exprId);
      if (ta) {
        ta.focus();
        const pos = dir === -1 ? ta.value.length : 0;
        ta.selectionStart = ta.selectionEnd = pos;
      }
    }

    // ── Helper: create one expression row ────────────────────────────────────
    function createCalcExprRow(expr) {
      // Result display span passed as rightSlot to createExprRow
      const resultSpan = document.createElement('span');
      resultSpan.className = 'calc-expr-result';
      resultSpan.style.display = 'none';
      resultSpan.title = 'Click to copy';
      resultSpan.style.cursor = 'pointer';

      //Claude: please do not touch the greek letters. There are some I dont want (like psi) because the interefere with others (you can spell epsilon without psi for example)
      const greekLetters = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi omega';

      const { wrapper, mqField: field, mqSpan } = createExprRow(expr, {
        rightSlot: resultSpan,
        autoCommands: 'sqrt sum int prod infty partial leq geq neq ' + greekLetters,
        onToggle: () => {
          commitCalcBox(box.id);
          scheduleCalcUpdate(box.id);
        },
        onDelete: () => {
          const idx = boxes.findIndex(b => b.id === box.id);
          if (idx === -1) return;
          const exprIdx = boxes[idx].expressions.findIndex(e => e.id === expr.id);
          if (exprIdx !== -1) boxes[idx].expressions.splice(exprIdx, 1);
          calcFieldMap.delete(expr.id);
          calcUpdateFns.delete(expr.id);
          wrapper.remove();
          commitCalcBox(box.id);
          scheduleCalcUpdate(box.id);
        },
        onEdit: () => {
          commitCalcBox(box.id);
          scheduleCalcUpdate(box.id);
        },
        onEnter: () => {
          const addAfter = calcAddExprFns.get(box.id);
          if (addAfter) addAfter(expr.id);
        },
        onMoveOut: (dir) => {
          const wrappers = [...exprList.querySelectorAll('.expr-wrapper')];
          const idx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
          if (dir === 1 && idx < wrappers.length - 1) {
            focusCalcRowById(wrappers[idx + 1].dataset.exprId, 1);
          } else if (dir === -1 && idx > 0) {
            focusCalcRowById(wrappers[idx - 1].dataset.exprId, -1);
          } else {
            const boxIdx = boxes.findIndex(b => b.id === box.id);
            if (dir === 1 && boxIdx < boxes.length - 1) focusBoxAtEdge(boxes[boxIdx + 1].id, 'start');
            else if (dir === -1 && boxIdx > 0)          focusBoxAtEdge(boxes[boxIdx - 1].id, 'end');
          }
        },
        onBackspaceEmpty: () => {
          const wrappers = [...exprList.querySelectorAll('.expr-wrapper')];
          const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
          if (wrappers.length > 1) {
            const focusTarget = rowIdx > 0 ? wrappers[rowIdx - 1].dataset.exprId : wrappers[rowIdx + 1].dataset.exprId;
            focusCalcRowById(focusTarget, rowIdx > 0 ? -1 : 1);
          }
          const idx = boxes.findIndex(b => b.id === box.id);
          if (idx !== -1) {
            const exprIdx = boxes[idx].expressions.findIndex(ex => ex.id === expr.id);
            if (exprIdx !== -1) boxes[idx].expressions.splice(exprIdx, 1);
          }
          calcFieldMap.delete(expr.id);
          calcUpdateFns.delete(expr.id);
          wrapper.remove();
          commitCalcBox(box.id);
          scheduleCalcUpdate(box.id);
        },
      });

      // Double-click → scroll preview to this specific expression and blink it
      wrapper.addEventListener('dblclick', e => {
        if (!isPreviewOpen) return;
        e.stopPropagation();
        scrollAndHighlightPreview(box.id, expr.id);
      });

      // Error line (shown below the main row when this expression has an error)
      const errorLine = document.createElement('div');
      errorLine.className = 'calc-expr-error';
      errorLine.style.display = 'none';
      wrapper.appendChild(errorLine);

      // Warning line (shown below when a unit mismatch is detected)
      const warningLine = document.createElement('div');
      warningLine.className = 'calc-unit-warning';
      warningLine.style.display = 'none';
      wrapper.appendChild(warningLine);

      let copyFlashing = false; // true from first click until flash restore completes
      resultSpan.addEventListener('click', () => {
        if (copyFlashing) return;
        // Prefer the stored copy value (set when display is truncated), else fall back to visible text
        const val = resultSpan.dataset.copyValue ?? resultSpan.textContent;
        if (!val) return;
        const num = val.replace(/^[=≈]\s*/, '');
        const prevHtml = resultSpan.innerHTML;   // capture before async gap
        const prevColor = resultSpan.style.color;
        copyFlashing = true;
        navigator.clipboard.writeText(num).then(() => {
          resultSpan.textContent = 'copied!';
          resultSpan.style.color = '#4ec9b0';
          setTimeout(() => {
            resultSpan.innerHTML = prevHtml;
            resultSpan.style.color = prevColor;
            copyFlashing = false;
          }, 900);
        }).catch(() => { copyFlashing = false; });
      });

      // Result update function for this row — always shows in-box; toggles only affect preview
      const updateResult = (resultMap) => {
        const result = resultMap ? resultMap.get(expr.id) : null;
        const currentExpr = boxes.find(b => b.id === box.id)?.expressions?.find(e => e.id === expr.id);
        const currentLatex = currentExpr?.latex || '';
        const kind = classifyCalcExpr(currentLatex);
        let suppress = false;
        if (kind === 'def') {
          const op = findCalcOperatorAtDepth0(currentLatex.trim());
          const rhs = op ? currentLatex.trim().slice(op.idx + op.len).trim() : '';
          suppress = isNumericLiteralLatex(rhs) && !(result && result.boolValue !== undefined);
        }

        warningLine.style.display = 'none';
        warningLine.textContent = '';

        if (result && result.error) {
          errorLine.textContent = result.error;
          errorLine.style.display = '';
          resultSpan.style.display = 'none';
          wrapper.classList.add('has-error');
        } else if (result && result.unitAst !== undefined && !suppress) {
          errorLine.style.display = 'none';
          wrapper.classList.remove('has-error');
          renderUnitResult(resultSpan, result.unitAst, result.warnings, boxes.find(b => b.id === box.id)?.sigFigs ?? 6);
          // Always stash a plain-text copy value — textContent of CSS fractions drops the '/'
          resultSpan.dataset.copyValue = buildAstText(result.unitAst, boxes.find(b => b.id === box.id)?.sigFigs ?? 6) ?? '';
          resultSpan.style.display = '';
          resultSpan.style.color = '';
          const warnText = formatUnitWarnings(result.warnings);
          if (warnText) {
            warningLine.textContent = warnText;
            warningLine.style.display = '';
          }
        } else {
          const currentBox = boxes.find(b => b.id === box.id);
          const formatted = result ? formatCalcResult(result, currentBox?.sigFigs ?? 6) : null;
          if (formatted !== null && !suppress) {
            errorLine.style.display = 'none';
            if (formatted.length > CALC_RESULT_MAX_CHARS) {
              resultSpan.textContent = 'Too Bulky!';
              resultSpan.dataset.copyValue = formatted;
            } else {
              resultSpan.textContent = formatted;
              delete resultSpan.dataset.copyValue;
            }
            resultSpan.style.display = '';
            if (result.boolValue === true)  resultSpan.style.color = '#4ec9b0';
            else if (result.boolValue === false) resultSpan.style.color = '#f44747';
            else resultSpan.style.color = '';
            wrapper.classList.remove('has-error');
          } else {
            errorLine.style.display = 'none';
            resultSpan.style.display = 'none';
            wrapper.classList.remove('has-error');
          }
        }
      };
      calcUpdateFns.set(expr.id, updateResult);

      if (expr.latex) field.latex(expr.latex);
      calcFieldMap.set(expr.id, field);

      mqSpan.addEventListener('focusin',  () => setFocused(box.id, div));
      mqSpan.addEventListener('focusout', (e) => {
        if (!div.contains(e.relatedTarget)) clearFocused(box.id, div);
      });

      return wrapper;
    }

    // ── Helper: create one text annotation row ────────────────────────────────
    /**
     * Creates a text annotation row inside a calc box.
     * Renders as a plain textarea with inline-LaTeX support (same as a text box).
     * @param {{ id: string, text: string }} expr - The text row data.
     * @returns {HTMLElement} The wrapper element.
     */
    function createCalcTextRow(expr) {
      const wrapper = document.createElement('div');
      wrapper.className = 'expr-wrapper';
      wrapper.dataset.exprId = expr.id;
      wrapper.dataset.rowType = 'text';

      // Double-click → scroll preview to this specific text row and blink it
      wrapper.addEventListener('dblclick', e => {
        if (!isPreviewOpen) return;
        e.stopPropagation();
        scrollAndHighlightPreview(box.id, expr.id);
      });

      const row = document.createElement('div');
      row.className = 'calc-text-row';

      const ta = document.createElement('textarea');
      ta.className = 'calc-text-input';
      ta.rows = 1;
      ta.value = expr.text || '';
      ta.placeholder = 'Text…';

      const autoResize = () => {
        ta.style.height = '1px';
        ta.style.height = ta.scrollHeight + 'px';
      };
      requestAnimationFrame(autoResize);

      ta.addEventListener('input', () => {
        autoResize();
        // Directly update this expression in boxes[], then sync — same pattern as regular text boxes
        const boxIdx = boxes.findIndex(b => b.id === box.id);
        if (boxIdx !== -1) {
          const exprIdx = boxes[boxIdx].expressions?.findIndex(e => e.id === expr.id) ?? -1;
          if (exprIdx !== -1) boxes[boxIdx].expressions[exprIdx].text = ta.value;
        }
        syncToText();
      });

      ta.addEventListener('keydown', e => {
        // Enter → add expression row after this text row
        if (e.key === 'Enter') {
          e.preventDefault();
          const addAfter = calcAddExprFns.get(box.id);
          if (addAfter) addAfter(expr.id);
          return;
        }
        // Backspace on empty → delete row, focus adjacent
        if (e.key === 'Backspace' && ta.value === '') {
          e.preventDefault();
          const wrappers = [...exprList.querySelectorAll('.expr-wrapper')];
          const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
          if (wrappers.length > 1) {
            const focusTarget = rowIdx > 0 ? wrappers[rowIdx - 1].dataset.exprId : wrappers[rowIdx + 1].dataset.exprId;
            focusCalcRowById(focusTarget, rowIdx > 0 ? -1 : 1);
          }
          const idx = boxes.findIndex(b => b.id === box.id);
          if (idx !== -1) {
            const exprIdx = boxes[idx].expressions.findIndex(ex => ex.id === expr.id);
            if (exprIdx !== -1) boxes[idx].expressions.splice(exprIdx, 1);
          }
          calcTaMap.delete(expr.id);
          wrapper.remove();
          commitCalcBox(box.id);
          return;
        }
        // Arrow up at start → move to previous row
        if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
          e.preventDefault();
          const wrappers = [...exprList.querySelectorAll('.expr-wrapper')];
          const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
          if (rowIdx > 0) {
            focusCalcRowById(wrappers[rowIdx - 1].dataset.exprId, -1);
          } else {
            const boxIdx = boxes.findIndex(b => b.id === box.id);
            if (boxIdx > 0) focusBoxAtEdge(boxes[boxIdx - 1].id, 'end');
          }
          return;
        }
        // Arrow down at end → move to next row
        if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
          e.preventDefault();
          const wrappers = [...exprList.querySelectorAll('.expr-wrapper')];
          const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
          if (rowIdx < wrappers.length - 1) {
            focusCalcRowById(wrappers[rowIdx + 1].dataset.exprId, 1);
          } else {
            const boxIdx = boxes.findIndex(b => b.id === box.id);
            if (boxIdx < boxes.length - 1) focusBoxAtEdge(boxes[boxIdx + 1].id, 'start');
          }
          return;
        }
      });

      ta.addEventListener('focusin',  () => setFocused(box.id, div));
      ta.addEventListener('focusout', (e) => {
        if (!div.contains(e.relatedTarget)) clearFocused(box.id, div);
      });

      calcTaMap.set(expr.id, ta);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'expr-delete';
      delBtn.textContent = '×';
      delBtn.addEventListener('mousedown', e => e.preventDefault());
      delBtn.addEventListener('click', () => {
        const wrappers = [...exprList.querySelectorAll('.expr-wrapper')];
        const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
        if (wrappers.length > 1) {
          const focusTarget = rowIdx > 0 ? wrappers[rowIdx - 1].dataset.exprId : wrappers[rowIdx + 1].dataset.exprId;
          focusCalcRowById(focusTarget, rowIdx > 0 ? -1 : 1);
        }
        const idx = boxes.findIndex(b => b.id === box.id);
        if (idx !== -1) {
          const exprIdx = boxes[idx].expressions.findIndex(ex => ex.id === expr.id);
          if (exprIdx !== -1) boxes[idx].expressions.splice(exprIdx, 1);
        }
        calcTaMap.delete(expr.id);
        wrapper.remove();
        commitCalcBox(box.id);
      });

      row.appendChild(ta);
      row.appendChild(delBtn);
      wrapper.appendChild(row);
      return wrapper;
    }

    // Populate expression list
    for (const expr of (box.expressions || [])) {
      exprList.appendChild(expr.type === 'text' ? createCalcTextRow(expr) : createCalcExprRow(expr));
    }
    div.appendChild(exprList);

    // ── Add expression button ─────────────────────────────────────────────────
    // Apply initial collapsed state
    if (box.collapsed) {
      exprList.style.display = 'none';
    }

    // Wire collapse button now that exprList exists
    collapseBtn.addEventListener('click', () => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx === -1) return;
      boxes[idx].collapsed = !boxes[idx].collapsed;
      const isCollapsed = boxes[idx].collapsed;
      exprList.style.display  = isCollapsed ? 'none' : '';
      collapseBtn.textContent = isCollapsed ? '▸' : '▾';
      syncToText(false); // collapsed state doesn't affect preview output
    });

    // ── Register the "add expression after" function ──────────────────────────
    const addExprAfter = (afterExprId) => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx === -1) return;
      const newExpr = { id: 'ce' + (calcExprNextId++), latex: '', enabled: true };
      if (afterExprId) {
        const exprIdx = boxes[idx].expressions.findIndex(e => e.id === afterExprId);
        if (exprIdx !== -1) {
          boxes[idx].expressions.splice(exprIdx + 1, 0, newExpr);
        } else {
          boxes[idx].expressions.push(newExpr);
        }
        const afterRow = exprList.querySelector(`.expr-wrapper[data-expr-id="${afterExprId}"]`);
        const newRow = createCalcExprRow(newExpr);
        if (afterRow) {
          exprList.insertBefore(newRow, afterRow.nextSibling);
        } else {
          exprList.appendChild(newRow);
        }
      } else {
        boxes[idx].expressions.push(newExpr);
        exprList.appendChild(createCalcExprRow(newExpr));
      }
      const newField = calcFieldMap.get(newExpr.id);
      if (newField) {
        newField.reflow();
        setTimeout(() => newField.focus(), 0);
      }
      commitCalcBox(box.id);
      scheduleCalcUpdate(box.id);
    };
    calcAddExprFns.set(box.id, addExprAfter);

    // ── Register the "add text row after" function ────────────────────────────
    const addTextAfter = (afterExprId) => {
      const idx = boxes.findIndex(b => b.id === box.id);
      if (idx === -1) return;
      const newExpr = { id: 'ct' + (calcTextNextId++), type: 'text', text: '', latex: '' };
      if (afterExprId) {
        const exprIdx = boxes[idx].expressions.findIndex(e => e.id === afterExprId);
        if (exprIdx !== -1) {
          boxes[idx].expressions.splice(exprIdx + 1, 0, newExpr);
        } else {
          boxes[idx].expressions.push(newExpr);
        }
        const afterRow = exprList.querySelector(`.expr-wrapper[data-expr-id="${afterExprId}"]`);
        const newRow = createCalcTextRow(newExpr);
        if (afterRow) {
          exprList.insertBefore(newRow, afterRow.nextSibling);
        } else {
          exprList.appendChild(newRow);
        }
      } else {
        boxes[idx].expressions.push(newExpr);
        exprList.appendChild(createCalcTextRow(newExpr));
      }
      const newTa = calcTaMap.get(newExpr.id);
      if (newTa) setTimeout(() => newTa.focus(), 0);
      commitCalcBox(box.id);
    };
    calcAddTextFns.set(box.id, addTextAfter);

    div.appendChild(deleteBtn);

    // Initial result update after elements are in the DOM
    requestAnimationFrame(() => scheduleCalcUpdate(box.id));
  } else if (box.type === 'image') {
    createImageBoxElement(box, div);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', () => deleteBox(box.id));
    div.appendChild(deleteBtn);
  }

  return div;
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
  // Remove MQ instances for boxes that no longer exist
  const currentIds = new Set(boxes.map(b => b.id));
  for (const [id] of mqFields) {
    if (!currentIds.has(id)) { mqFields.delete(id); boxResizers.delete(id); }
  }
  for (const [id] of calcMqFields) {
    if (!currentIds.has(id)) cleanupCalcBox(id);
  }

  boxList.innerHTML = '';
  for (const box of boxes) {
    let boxElement = createBoxElement(box);

    boxList.appendChild(boxElement);
    reflowBox(box);
  }


}

// ── Insert / delete ───────────────────────────────────────────────────────────
function insertBoxAfter(afterId, type = 'math') {
  const newBox = type === 'graph' ? makeGraphBox()
               : type === 'calc'  ? makeCalcBox()
               : type === 'image' ? makeImageBox()
               : { id: genId(), type, content: '' };
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
        boxes[idx] = type === 'graph' ? makeGraphBox(convertId)
                   : type === 'calc'  ? makeCalcBox(convertId)
                   : type === 'image' ? makeImageBox(convertId)
                   : { id: convertId, type, content: '' };
        rebuildBoxList();
        syncToText();
        focusBox(convertId);
        return;
      }
    }
    insertBoxAfter(focusedBoxId, type);
  } else {
    const newBox = type === 'graph' ? makeGraphBox()
               : type === 'calc'  ? makeCalcBox()
               : type === 'image' ? makeImageBox()
               : { id: genId(), type, content: '' };
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

  // Collect all existing box elements by id
  const existing = new Map();
  for (const el of boxList.children) {
    existing.set(el.dataset.id, el);
  }

  const currentIds = new Set(boxes.map(b => b.id));

  // Remove elements for deleted boxes
  for (const [id, el] of existing) {
    if (!currentIds.has(id)) {
      boxList.removeChild(el);
      mqFields.delete(id);
      boxResizers.delete(id);
      cleanupCalcBox(id);
      cleanupImageBox(id);
      existing.delete(id);
    }
  }

  // Insert/reorder elements
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    let el = existing.get(box.id);
    if (!el) {
      el = createBoxElement(box);
    }
    const currentAtPos = boxList.children[i];
    if (currentAtPos !== el) {
      boxList.insertBefore(el, currentAtPos || null);
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
      const calcMap = calcMqFields.get(targetBox.id);
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
        // Preserve id but take all parsed fields (expressions, width, height, etc.)
        return { ...nb, id: existing.id };
      }
      // Reuse id, update content and commented state
      return { ...existing, content: nb.content, commented: nb.commented };
    }
    return nb;
  });

  boxes = result;

  // Update MQ fields in place where possible, rebuild for others
  const existingEls = new Map();
  for (const el of boxList.children) {
    existingEls.set(el.dataset.id, el);
  }

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
        const newEl = createBoxElement(box);
        boxList.replaceChild(newEl, existingEl);
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
      const newEl = createBoxElement(box);
      if (existingEl) {
        boxList.insertBefore(newEl, existingEl);
      } else {
        boxList.appendChild(newEl);
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
    boxClipboard = { type: 'calc', content: '', expressions: JSON.parse(JSON.stringify(box.expressions || [])), showResultsDefs: box.showResultsDefs !== false, showResultsBare: box.showResultsBare !== false, physicsBasic: !!box.physicsBasic, physicsEM: !!box.physicsEM, physicsChem: !!box.physicsChem };
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
    newBox = makeCalcBox();
    // Reassign fresh ids to pasted expressions to avoid id collisions
    newBox.expressions = (boxClipboard.expressions || []).map(e => ({
      ...e, id: 'ce' + (calcExprNextId++)
    }));
    newBox.showResultsDefs = boxClipboard.showResultsDefs !== false;
    newBox.showResultsBare = boxClipboard.showResultsBare !== false;
    newBox.physicsBasic = !!boxClipboard.physicsBasic;
    newBox.physicsEM    = !!boxClipboard.physicsEM;
    newBox.physicsChem  = !!boxClipboard.physicsChem;
  } else if (boxClipboard.type === 'image') {
    newBox = makeImageBox();
    newBox.mode     = boxClipboard.mode;
    newBox.locked   = boxClipboard.locked;
    newBox.src      = boxClipboard.src;
    newBox.filename = boxClipboard.filename;
    newBox.alt      = boxClipboard.alt;
    newBox.width    = boxClipboard.width  || 0;
    newBox.height   = boxClipboard.height || 0;
    newBox.fit      = boxClipboard.fit    || 'locked';
    newBox.align    = boxClipboard.align  || 'left';
  } else {
    newBox = { id: genId(), type: boxClipboard.type, content: boxClipboard.content };
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
  // Suppress history during rebuild so field.latex() in createBoxElement doesn't
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

// ── Project management ────────────────────────────────────────────────────────

// ── IndexedDB image storage ───────────────────────────────────────────────────

function initImageDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mathnotepad_imagedb', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('images')) {
        const store = db.createObjectStore('images', { keyPath: 'key' });
        store.createIndex('by_project', 'projectId', { unique: false });
      }
      // v2: store FileSystemDirectoryHandle objects keyed by project ID
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles', { keyPath: 'projectId' });
      }
    };
    req.onsuccess = e => { imageDb = e.target.result; resolve(); };
    req.onerror   = e => { console.warn('ImageDB open failed', e.target.error); resolve(); };
  });
}

/**
 * Persists the single global workspace FileSystemDirectoryHandle to IDB.
 * @param {FileSystemDirectoryHandle} handle
 */
function idbSaveWorkspace(handle) {
  if (!imageDb) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = imageDb.transaction('handles', 'readwrite');
    tx.objectStore('handles').put({ projectId: WORKSPACE_KEY, handle });
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

/**
 * Retrieves the global workspace FileSystemDirectoryHandle from IDB.
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
function idbGetWorkspace() {
  if (!imageDb) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = imageDb.transaction('handles', 'readonly').objectStore('handles').get(WORKSPACE_KEY);
    req.onsuccess = e => resolve(e.target.result?.handle || null);
    req.onerror = e => reject(e.target.error);
  });
}

function idbSaveImage(projectId, filename, mimeType, arrayBuffer) {
  if (!imageDb) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const key = `${projectId}/${filename}`;
    const tx  = imageDb.transaction('images', 'readwrite');
    tx.objectStore('images').put({ key, projectId, filename, mimeType, data: arrayBuffer });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

function idbLoadImageAsObjectURL(key) {
  if (!imageDb) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = imageDb.transaction('images', 'readonly').objectStore('images').get(key);
    req.onsuccess = e => {
      const rec = e.target.result;
      if (!rec) { resolve(null); return; }
      resolve(URL.createObjectURL(new Blob([rec.data], { type: rec.mimeType })));
    };
    req.onerror = e => reject(e.target.error);
  });
}

/**
 * Loads a file-mode image as a blob URL from either the global workspace asset folder or IDB.
 * Disk-backed projects store images in workspace/{title}_assets/filename (box.src = "{title}_assets/filename").
 * Browser projects use IDB (box.src = "projectId/filename").
 * Finds the matching disk project by assetFolder prefix rather than relying solely on currentProjectId,
 * so it works even when currentProjectId is stale (e.g. after openWorkspaceFolder assigns new IDs).
 * @param {object} box - image box with src and filename fields
 * @returns {Promise<string|null>} blob URL or null if not found
 */
async function loadImageAsObjectURL(box) {
  if (!box.src) return null;
  const allProjs = loadProjects();
  // Find by current project first; fall back to matching any disk project by assetFolder prefix
  const proj = (currentProjectId ? allProjs.find(p => p.id === currentProjectId) : null)
            || allProjs.find(p => p.onDisk && p.assetFolder && box.src.startsWith(p.assetFolder + '/'));
  if (proj?.onDisk && proj.assetFolder && box.src.startsWith(proj.assetFolder + '/')) {
    const filename = box.src.slice(proj.assetFolder.length + 1);
    // Try disk first if workspace handle is available
    if (currentWorkspaceHandle) {
      try {
        const assetDir = await currentWorkspaceHandle.getDirectoryHandle(proj.assetFolder);
        const fh = await assetDir.getFileHandle(filename);
        const file = await fh.getFile();
        return URL.createObjectURL(file);
      } catch {}
    }
    // IDB fallback — written at upload time; key uses proj.id (stable even if currentProjectId is stale)
    return idbLoadImageAsObjectURL(`${proj.id}/${filename}`);
  }
  return idbLoadImageAsObjectURL(box.src);
}

/**
 * Requests readwrite permission for the stored workspace handle (requires a user gesture).
 * If no handle is stored, prompts the user to pick a folder.
 * @returns {Promise<boolean>} true if workspace is now accessible
 */
async function reconnectWorkspace() {
  let handle = currentWorkspaceHandle;
  if (!handle) handle = await idbGetWorkspace().catch(() => null);
  if (handle) {
    try {
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return false;
      currentWorkspaceHandle = handle;
      await idbSaveWorkspace(handle);
      return true;
    } catch { return false; }
  }
  // No stored handle — ask user to pick
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    currentWorkspaceHandle = handle;
    await idbSaveWorkspace(handle);
    localStorage.setItem(WORKSPACE_NAME_KEY, handle.name);
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('Directory picker error:', e);
    return false;
  }
}

/**
 * After workspace reconnect, re-renders all boxes so image loading is retried with the
 * workspace now connected. Boxes that already have cached blob URLs are unaffected.
 * Suppresses sync and history during the rebuild to avoid marking the project dirty.
 */
function retryAllDiskImages() {
  suppressBoxSync = true;
  suppressHistory = true;
  renderBoxes();
  suppressBoxSync = false;
  suppressHistory = false;
  markClean();
}

function idbGetImageRecord(key) {
  if (!imageDb) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = imageDb.transaction('images', 'readonly').objectStore('images').get(key);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}

function idbDeleteImage(key) {
  if (!imageDb) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = imageDb.transaction('images', 'readwrite');
    tx.objectStore('images').delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

function idbGetAllImagesForProject(projectId) {
  if (!imageDb) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx   = imageDb.transaction('images', 'readonly');
    const req  = tx.objectStore('images').index('by_project').getAll(projectId);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function idbDeleteAllImagesForProject(projectId) {
  if (!imageDb) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx    = imageDb.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    const idx   = store.index('by_project');
    const req   = idx.openCursor(IDBKeyRange.only(projectId));
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

function idbMigrateImageKeys(oldId, newId) {
  if (!imageDb) return Promise.resolve();
  return idbGetAllImagesForProject(oldId).then(records => {
    if (!records.length) return;
    const tx    = imageDb.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    for (const rec of records) {
      store.delete(rec.key);
      rec.key       = `${newId}/${rec.filename}`;
      rec.projectId = newId;
      store.put(rec);
    }
    // Update src references in the live boxes array
    for (const box of boxes) {
      if (box.type === 'image' && box.src && box.src.startsWith(`${oldId}/`)) {
        box.src = `${newId}/${box.filename}`;
        // Revoke old object URL if any — it stays valid but the key changed
      }
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  });
}

// ── Disk / workspace helpers ──────────────────────────────────────────────────

/**
 * Strips characters invalid in file/folder names on Windows/macOS/Linux.
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled';
}

/**
 * Writes latex to a named .tex file inside the workspace folder.
 * @param {FileSystemDirectoryHandle} workspaceHandle
 * @param {string} texFilename  e.g. "MyProject.tex"
 * @param {string} latex
 */
async function writeToDisk(workspaceHandle, texFilename, latex) {
  const fh = await workspaceHandle.getFileHandle(texFilename, { create: true });
  const writable = await fh.createWritable();
  await writable.write(latex);
  await writable.close();
}

/**
 * Reads and returns the text content of a .tex file from the workspace folder.
 * Returns '' if the file doesn't exist.
 * @param {FileSystemDirectoryHandle} workspaceHandle
 * @param {string} texFilename
 * @returns {Promise<string>}
 */
async function readTexFromDisk(workspaceHandle, texFilename) {
  try {
    const fh = await workspaceHandle.getFileHandle(texFilename);
    return await (await fh.getFile()).text();
  } catch { return ''; }
}

/**
 * Opens a directory picker to set the single global workspace folder. Clears all
 * existing disk-backed projects (they belonged to the previous workspace), reads all
 * .tex files from the selected folder, and adds them as projects. Stores the handle
 * globally in IDB and the folder name in localStorage for display.
 */
async function openWorkspaceFolder() {
  let workspaceHandle;
  try {
    workspaceHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('Directory picker error:', e);
    return;
  }

  // Set as the global workspace
  currentWorkspaceHandle = workspaceHandle;
  await idbSaveWorkspace(workspaceHandle);
  localStorage.setItem(WORKSPACE_NAME_KEY, workspaceHandle.name);

  // Remove all previous disk-backed projects; they belonged to the old workspace
  let projects = loadProjects().filter(p => !p.onDisk);

  // Read all .tex files in the new workspace and add as projects
  let addedCount = 0;
  for await (const [name, entry] of workspaceHandle.entries()) {
    if (entry.kind !== 'file' || !name.endsWith('.tex')) continue;
    const title = name.slice(0, -4);
    const assetFolder = sanitizeName(title) + '_assets';
    const latex = await readTexFromDisk(workspaceHandle, name);
    const id = Date.now().toString() + addedCount++;
    projects.push({ id, title, latex, onDisk: true, texFilename: name, assetFolder });
  }

  saveProjects(projects);
  renderProjectsList();
  openProjectsPanel();
}

/**
 * Saves a project to the global workspace folder as a .tex file. If no workspace is
 * set, prompts the user to pick one (which becomes the new global workspace, clearing
 * any old disk-backed projects). Called from the "Save to disk" dropdown item.
 * @param {string} projectId
 */
async function saveProjectToDisk(projectId) {
  if (!currentWorkspaceHandle) {
    // No workspace set — pick folder and establish it as global workspace
    try {
      currentWorkspaceHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('Directory picker error:', e);
      return;
    }
    await idbSaveWorkspace(currentWorkspaceHandle);
    localStorage.setItem(WORKSPACE_NAME_KEY, currentWorkspaceHandle.name);
    // Clear other onDisk projects — they belonged to the previous workspace
    const filtered = loadProjects().filter(p => !p.onDisk || p.id === projectId);
    saveProjects(filtered);
  }

  const perm = await currentWorkspaceHandle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { alert('Permission denied — cannot write to folder.'); return; }

  const projects = loadProjects();
  const proj = projects.find(p => p.id === projectId);
  if (!proj) return;

  const texFilename = sanitizeName(proj.title) + '.tex';
  const assetFolder = sanitizeName(proj.title) + '_assets';
  const latex = projectId === currentProjectId ? latexSource.value : proj.latex;

  await writeToDisk(currentWorkspaceHandle, texFilename, latex);

  proj.onDisk      = true;
  proj.texFilename = texFilename;
  proj.assetFolder = assetFolder;
  proj.latex       = latex;
  saveProjects(projects);

  if (projectId === currentProjectId) {
    markClean();
    saveDraftNow();
  }
  renderProjectsList();
}

function loadProjects() {
  return JSON.parse(localStorage.getItem(PROJ_KEY) || '[]');
}

function saveProjects(list) {
  localStorage.setItem(PROJ_KEY, JSON.stringify(list));
}

function saveDraftNow() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  localStorage.setItem(DRAFT_KEY, JSON.stringify({
    latex: latexSource.value,
    projectId: currentProjectId,
  }));
}

// Debounced version used during editing — avoids blocking the main thread on
// every keystroke/box-creation with a synchronous localStorage write.
function saveDraft() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraftNow, DRAFT_SAVE_DEBOUNCE_MS);
}

function saveUiState() {
  localStorage.setItem(UI_STATE_KEY, JSON.stringify({
    isPreviewOpen,
    isSourceOpen,
    leftPanelWidth:   leftPanel.style.width   || null,
    previewPanelWidth: previewPanel.style.width || null,
  }));
}

function markDirty() {
  if (isDirty) return;
  isDirty = true;
  projectTitleLabel.classList.add('dirty');
}

function markClean() {
  isDirty = false;
  projectTitleLabel.classList.remove('dirty');
}

function restoreFromLatex(latex) {
  suppressHistory = true;
  suppressBoxSync = true;
  boxes = parseFromLatex(latex);
  mqFields.clear(); boxResizers.clear();
  rebuildBoxList();
  suppressTextSync = true;
  latexSource.value = latex;
  suppressTextSync = false;
  suppressBoxSync = false;
  suppressHistory = false;
  history = [{ latex, focusId: null }];
  historyIndex = 0;
  updateLineNumbers();
  updatePreview();
}

async function saveCurrentProject() {
  const projects = loadProjects();
  const latex = latexSource.value;

  if (currentProjectId) {
    const idx = projects.findIndex(p => p.id === currentProjectId);
    if (idx !== -1) {
      projects[idx].latex = latex;
      saveProjects(projects);
      markClean();
      saveDraftNow();
      // Also persist to disk if project is disk-backed
      if (projects[idx].onDisk && currentWorkspaceHandle && projects[idx].texFilename) {
        writeToDisk(currentWorkspaceHandle, projects[idx].texFilename, latex)
          .catch(err => console.warn('Disk write failed:', err));
      }
      renderProjectsList();
    }
  } else {
    const title = prompt('Project title:')?.trim();
    if (!title) return;
    const id = Date.now().toString();
    const texFilename = sanitizeName(title) + '.tex';
    const assetFolder = sanitizeName(title) + '_assets';
    const proj = { id, title, latex };

    // If a workspace is set, automatically save to disk
    if (currentWorkspaceHandle) {
      try {
        const perm = await currentWorkspaceHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          await writeToDisk(currentWorkspaceHandle, texFilename, latex);
          proj.onDisk      = true;
          proj.texFilename = texFilename;
          proj.assetFolder = assetFolder;
        }
      } catch (err) {
        console.warn('Disk write failed:', err);
      }
    }

    projects.push(proj);
    saveProjects(projects);
    currentProjectId = id;
    projectTitleLabel.textContent = title;
    markClean();
    await idbMigrateImageKeys('draft', id).then(() => syncToText());
    saveDraftNow();
    renderProjectsList();
  }
}

async function downloadCurrentProject() {
  const title = projectTitleLabel.textContent.replace(/\s•$/, '') || 'Untitled';

  const fileImageBoxes = boxes.filter(b => b.type === 'image' && b.mode === 'file' && b.src);

  if (!fileImageBoxes.length || !window.JSZip) {
    // Plain .tex download
    const blob = new Blob([latexSource.value], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = title + '.tex'; a.click();
    URL.revokeObjectURL(url);
    return;
  }

  // ZIP download — rewrite IDB keys to images/<filename>; disk-backed are already in that form
  let texContent = latexSource.value;
  for (const box of fileImageBoxes) {
    if (box.src && box.filename && !box.src.startsWith('images/')) {
      texContent = texContent.replaceAll(`% ${box.src}`, `% images/${box.filename}`);
    }
  }

  const zip = new JSZip();
  zip.file(title + '.tex', texContent);

  for (const box of fileImageBoxes) {
    if (currentWorkspaceHandle && currentProjectId) {
      const diskProj = loadProjects().find(p => p.id === currentProjectId);
      if (diskProj?.onDisk && diskProj.assetFolder && box.src.startsWith(diskProj.assetFolder + '/')) {
        // Disk-backed image — read from workspace asset folder
        try {
          const assetDir = await currentWorkspaceHandle.getDirectoryHandle(diskProj.assetFolder);
          const filename = box.src.slice(diskProj.assetFolder.length + 1);
          const fh = await assetDir.getFileHandle(filename);
          const file = await fh.getFile();
          const buf = await file.arrayBuffer();
          zip.folder('images').file(file.name, buf, { binary: true });
        } catch {}
        continue;
      }
    }
    {
      // IDB-backed image
      const rec = await idbGetImageRecord(box.src).catch(() => null);
      if (rec) {
        zip.folder('images').file(rec.filename, rec.data, { binary: true });
      }
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = title + '.zip'; a.click();
  URL.revokeObjectURL(url);
}

async function openProject(id) {
  if (isDirty && !confirm('You have unsaved changes. Open anyway?')) return;
  const projects = loadProjects();
  const proj = projects.find(p => p.id === id);
  if (!proj) return;

  if (proj.onDisk) {
    // Ensure the global workspace handle is set and accessible (user gesture available here)
    if (!currentWorkspaceHandle) {
      const handle = await idbGetWorkspace().catch(() => null);
      if (handle) {
        try {
          const perm = await handle.requestPermission({ mode: 'readwrite' });
          if (perm === 'granted') currentWorkspaceHandle = handle;
        } catch {}
      }
    }
    // Re-read .tex file from disk for latest content
    if (currentWorkspaceHandle && proj.texFilename) {
      try { proj.latex = await readTexFromDisk(currentWorkspaceHandle, proj.texFilename); } catch {}
    }
  }

  restoreFromLatex(proj.latex || '');
  currentProjectId = id;
  projectTitleLabel.textContent = proj.title;
  markClean();
  saveDraftNow();
  closeProjectsPanel();
  if (boxes.length > 0) focusBox(boxes[0].id);
  renderProjectsList();
}

function deleteProject(id) {
  if (!confirm('Delete this project? (Only removes from recent list — files on disk are not deleted.)')) return;
  let projects = loadProjects();
  projects = projects.filter(p => p.id !== id);
  saveProjects(projects);
  idbDeleteAllImagesForProject(id).catch(() => {});
  if (currentProjectId === id) {
    currentProjectId = null;
    projectTitleLabel.textContent = 'Untitled';
  }
  renderProjectsList();
}

function renameProject(id) {
  const projects = loadProjects();
  const proj = projects.find(p => p.id === id);
  if (!proj) return;
  const newTitle = prompt('Rename project:', proj.title)?.trim();
  if (!newTitle) return;
  proj.title = newTitle;
  saveProjects(projects);
  if (currentProjectId === id) {
    projectTitleLabel.textContent = newTitle;
  }
  renderProjectsList();
}

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
  boxes = [{ id: genId(), type: 'math', content: '' }];
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
    boxes = [{ id: genId(), type: 'math', content: '' }];
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

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
const ZOOM_STEPS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200];
let previewZoomIndex = 4; // 100%

// ── Project state ────────────────────────────────────────────────────────────
const PROJ_KEY     = 'mathnotepad_projects';
const DRAFT_KEY    = 'mathnotepad_draft';
const UI_STATE_KEY = 'mathnotepad_ui';
let currentProjectId = null;
let isDirty = false;

// ── Graph mode ───────────────────────────────────────────────────────────────
let graphModeBoxId = null;        // id of box being edited in graph mode, or null
let focusedGraphExprId = null;    // id of the expression row currently focused
let graphExprNextId = 1;
let graphMqFields = new Map();    // expr id → MathQuill field
let graphExprUpdateFns = new Map(); // expr id → () => void, refreshes that row's badges
let graphCommitTimer = null;

const GRAPH_RENDER_DEBOUNCE_MS = 300; // debounce delay (ms) between typing in a graph expression and re-rendering

const GRAPH_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#eab308', '#06b6d4'];
let graphColorIdx = 0;
function nextGraphColor() { return GRAPH_COLORS[graphColorIdx++ % GRAPH_COLORS.length]; }

// ── Highlight fill colors ─────────────────────────────────────────────────────
// Add new default colors here, or extend the list per-project via custom colors.
const HIGHLIGHT_FILL_COLORS = ['#fff9bf', '#ffbfbf', '#ceffbf', '#c3bfff', '#ffbff3'];
let _activeFillColorPopup = null;
let _activeFillColorPopupOutside = null;

function formatConstantValue(v) {
  if (!isFinite(v)) return null;
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return '= ' + v;
  const s = parseFloat(v.toPrecision(6)).toString();
  return '≈ ' + s;
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

  // Refresh all expression row badges now that constants may have changed
  for (const fn of graphExprUpdateFns.values()) fn();
}

/** Update error indicators on graph expression rows. */
function updateGraphExprErrors(errors) {
  const rows = document.querySelectorAll('#graph-expr-list .graph-expr-row');
  for (const row of rows) {
    const exprId = row.dataset.exprId;
    const errorMsg = errors.get(exprId);
    let errorEl = row.querySelector('.graph-expr-error');
    if (errorMsg) {
      if (!errorEl) {
        errorEl = document.createElement('span');
        errorEl.className = 'graph-expr-error';
        row.appendChild(errorEl);
      }
      errorEl.textContent = errorMsg;
      errorEl.title = errorMsg;
      row.classList.add('has-error');
    } else {
      if (errorEl) errorEl.remove();
      row.classList.remove('has-error');
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

// ── Serialization ─────────────────────────────────────────────────────────────
function serializeToLatex(boxArray) {
  return boxArray.map(b => {
    let serialized;
    if (b.type === 'math') serialized = `\\[${b.content}\\]`;
    else if (b.type === 'h1') serialized = `\\section{${b.content}}`;
    else if (b.type === 'h2') serialized = `\\subsection{${b.content}}`;
    else if (b.type === 'h3') serialized = `\\subsubsection{${b.content}}`;
    else if (b.type === 'pagebreak') serialized = '\\newpage';
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

// ── Box → DOM ─────────────────────────────────────────────────────────────────
function createBoxElement(box) {
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

  // Click on box padding → focus the field
  div.addEventListener('click', e => {
    if (e.target.closest('.delete-btn') || e.target.closest('.box-drag-handle')) return;
    if (e.target.closest('.mq-editable-field') || e.target.closest('.text-input')) return;
    if (box.type === 'math') {
      const field = mqFields.get(box.id);
      if (field) field.focus();
    } else if (box.type === 'pagebreak' || box.type === 'graph') {
      setFocused(box.id, div);
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
      autoCommands: 'sqrt nthroot sum int prod in notin subset subseteq supset supseteq cup cap emptyset forall exists infty partial setminus ell approx times vec '+greekLetters,
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
  }

  return div;
}

// Setting the latex of a box before it is in the DOM can cause bugs. Calling reflow after it is added fixes this.
function reflowBox(box){
  if(mqFields.get(box.id) != undefined){
    const field = mqFields.get(box.id) ;
    field.reflow();
  }
}

function setFocused(id, el) {
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

  boxList.innerHTML = '';
  for (const box of boxes) {
    let boxElement = createBoxElement(box);

    boxList.appendChild(boxElement);
    reflowBox(box);
  }

  
}

// ── Insert / delete ───────────────────────────────────────────────────────────
function insertBoxAfter(afterId, type = 'math') {
  const newBox = type === 'graph' ? makeGraphBox() : { id: genId(), type, content: '' };
  const idx = boxes.findIndex(b => b.id === afterId);
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
  if (focusedBoxId) {
    const idx = boxes.findIndex(b => b.id === focusedBoxId);
    if (idx !== -1) {
      // Check if focused box is empty
      const focused = boxes[idx];
      // Pagebreaks and graphs have no editable content — always insert after, never convert
      if (focused.type === 'pagebreak' || focused.type === 'graph') {
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
        // Convert the empty box to the new type in-place
        mqFields.delete(focusedBoxId);
        boxResizers.delete(focusedBoxId);
        const oldEl = boxList.querySelector(`[data-id="${focusedBoxId}"]`);
        if (oldEl) oldEl.remove();
        boxes[idx] = type === 'graph' ? makeGraphBox(focusedBoxId) : { id: focusedBoxId, type, content: '' };
        rebuildBoxList();
        syncToText();
        focusBox(focusedBoxId);
        return;
      }
    }
    insertBoxAfter(focusedBoxId, type);
  } else {
    const newBox = type === 'graph' ? makeGraphBox() : { id: genId(), type, content: '' };
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
}

// ── Focus a box ───────────────────────────────────────────────────────────────
function focusBox(id) {
  const field = mqFields.get(id);
  if (field) {
    setTimeout(() => field.focus(), 0);
    return;
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
  historyIndex--;
  restoreSnapshot(history[historyIndex], focusIdx);
  if (graphBoxIdx >= 0 && graphBoxIdx < boxes.length && boxes[graphBoxIdx].type === 'graph') {
    enterGraphMode(boxes[graphBoxIdx].id);
  }
}

function applyRedo() {
  if (historyIndex >= history.length - 1) return;
  const graphBoxIdx = graphModeBoxId ? boxes.findIndex(b => b.id === graphModeBoxId) : -1;
  if (graphModeBoxId) _teardownGraphModeUI();
  const focusIdx = boxes.findIndex(b => b.id === focusedBoxId);
  historyIndex++;
  restoreSnapshot(history[historyIndex], focusIdx);
  if (graphBoxIdx >= 0 && graphBoxIdx < boxes.length && boxes[graphBoxIdx].type === 'graph') {
    enterGraphMode(boxes[graphBoxIdx].id);
  }
}

function restoreSnapshot(snap, preferFocusIdx = -1) {
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
    focusBox(boxes[Math.min(preferFocusIdx, boxes.length - 1)].id);
  }
}

// ── Sync right → left ─────────────────────────────────────────────────────────
function syncToText() {
  if (suppressBoxSync) return;
  suppressTextSync = true;
  let latex = serializeToLatex(boxes);

  latexSource.value = latex;
  suppressTextSync = false;
  updateLineNumbers();
  pushHistory(latex);
  saveDraft();
  markDirty();
  schedulePreview();
}

// ── Sync left → right (debounced) ─────────────────────────────────────────────
latexSource.addEventListener('input', () => {
  if (suppressTextSync) return;
  updateLineNumbers();
  clearTimeout(textSyncTimer);
  textSyncTimer = setTimeout(() => {
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
  // Strategy: match by position; preserve IDs where type/content match
  const result = newBoxes.map((nb, i) => {
    const existing = boxes[i];
    if (existing && existing.type === nb.type) {
      if (existing.type === 'graph') {
        // Preserve id but take all parsed fields (expressions, width, height)
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
    } else {
      // Insert new element
      const newEl = createBoxElement(box);
      if (existingEl) {
        boxList.insertBefore(newEl, existingEl);
        // Remove the displaced element if it's for a different id
        if (existingEl.dataset.id !== box.id) {
          // It'll be cleaned up in the next pass or is already accounted for
        }
      } else {
        boxList.appendChild(newEl);
      }
      reflowBox(box);
    }
  }
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
[addMathBtn, addTextBtn, addH1Btn, addH2Btn, addH3Btn, addBreakBtn, addGraphBtn].forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault());
});
addMathBtn.addEventListener('click', () => appendBox('math'));
addTextBtn.addEventListener('click', () => appendBox('text'));
addH1Btn.addEventListener('click', () => appendBox('h1'));
addH2Btn.addEventListener('click', () => appendBox('h2'));
addH3Btn.addEventListener('click', () => appendBox('h3'));
addBreakBtn.addEventListener('click', () => appendBox('pagebreak'));
addGraphBtn.addEventListener('click', () => appendBox('graph'));

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
  } else {
    const ta = boxList.querySelector(`[data-id="${focusedBoxId}"] .text-input`);
    isEmpty = !ta || ta.value === '';
  }

  const newBox = { id: genId(), type: boxClipboard.type, content: boxClipboard.content };

  if (isEmpty) {
    // Replace the empty box in-place
    mqFields.delete(focusedBoxId);
    boxResizers.delete(focusedBoxId);
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

// ── Preview ───────────────────────────────────────────────────────────────────

// Blackboard bold shorthands: RR → \mathbb{R}, etc.
// Applied to LaTeX strings in the preview only; boxes/source are left untouched.
// IMPORTANT: call this BEFORE escapeHtml so that <-/-> are substituted before < and > are escaped.
const BB_SUBS = {
  'RR': '\\mathbb{R}',
  'CC': '\\mathbb{C}',
  'ZZ': '\\mathbb{Z}',
  'NN': '\\mathbb{N}',
  'QQ': '\\mathbb{Q}',
  'FF': '\\mathbb{F}',
  'HH': '\\mathbb{H}',
};
function applyBBSubs(latex) {
  let out = latex;
  out = out.replace(/<=/g, '\\leq ');
  out = out.replace(/>=/g, '\\geq ');
  out = out.replace(/->/g, '\\rightarrow ');
  out = out.replace(/<-/g, '\\leftarrow ');
  out = out.replace(/!=/g, '\\neq ');
  for (const [key, val] of Object.entries(BB_SUBS)) out = out.replaceAll(key, val);
  return out;
}

// Escape HTML and convert $...$ to MathJax inline math \(...\).
// Splits on dollar-sign pairs; odd-indexed segments are math, even are plain text.
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function processTextContent(text) {
  return text.split(/\$([^$]+)\$/).map((part, i) => {
    if (i % 2 === 1) return `\\(${escapeHtml(applyBBSubs(part))}\\)`;
    return escapeHtml(part).replace(/\n/g, '<br>');
  }).join('');
}

function schedulePreview(delay = 400) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => updatePreview(), delay);
}

let previewRunning = false;
let previewPending = false;

async function updatePreview() {
  if (!isPreviewOpen) return;
  if (graphModeBoxId) return; // preview panel is used for graph canvas in graph mode
  if (previewRunning) { previewPending = true; return; }
  previewRunning = true;
  previewPending = false;

  let inner = '';
  for (const box of boxes) {
    if (box.commented) continue;
    let boxHtml;
    if (box.type === 'math') {
      boxHtml = `<div class="preview-math" data-box-id="${box.id}">\\[${escapeHtml(applyBBSubs(box.content))}\\]</div>`;
    } else if (box.type === 'h1' || box.type === 'h2' || box.type === 'h3') {
      const tag = box.type;
      boxHtml = `<${tag} class="preview-${tag}" data-box-id="${box.id}">${processTextContent(box.content)}</${tag}>`;
    } else if (box.type === 'pagebreak') {
      boxHtml = `<div class="preview-pagebreak" data-box-id="${box.id}"></div>`;
    } else if (box.type === 'graph') {
      if (box._snapshotDataUrl) {
        boxHtml = `<div class="preview-graph-image" data-box-id="${box.id}" style="text-align:center;margin:8px 0">
          <img src="${box._snapshotDataUrl}" style="max-width:100%;width:${box.width||600}px;height:auto;border-radius:4px"></div>`;
      } else {
        const n = (box.expressions || []).filter(e => e.enabled).length;
        boxHtml = `<div class="preview-graph-placeholder" data-box-id="${box.id}" style="width:${box.width || 600}px;height:${box.height || 400}px">
          <span>${n} expression${n !== 1 ? 's' : ''}</span></div>`;
      }
    } else {
      boxHtml = `<p class="preview-text" data-box-id="${box.id}">${processTextContent(box.content)}</p>`;
    }
    if (box.highlighted) {
      const bgStyle = box.fillColor ? `background:${box.fillColor};` : '';
      boxHtml = `<div class="preview-highlight-box" style="${bgStyle}">${boxHtml}</div>`;
    }
    inner += boxHtml;
  }

  const savedScroll = previewContent.scrollTop;

  if (window.MathJax?.typesetClear) MathJax.typesetClear([previewContent]);
  previewContent.innerHTML = `<div class="preview-page">${inner}</div>`;
  if (window.MathJax?.typesetPromise) await MathJax.typesetPromise([previewContent]);
  // Eliminate SVG stroke rendering that causes artefacts in printed PDFs.
  // Must set stroke="none" on every element individually — PDF renderers don't
  // reliably cascade SVG attributes, and child stroke-width="0" can reintroduce strokes.
  previewContent.querySelectorAll('svg, svg *').forEach(el => el.setAttribute('stroke', 'none'));
  paginatePreview();  // split content across separate page divs
  applyPreviewZoom(); // apply after MathJax renders so it measures at natural size

  previewContent.scrollTop = savedScroll;
  previewRunning = false;
  if (previewPending) schedulePreview(0);
}

// Try to split a .preview-text element at a <br> boundary so that the first
// part fits within maxHeight px. Returns [part1El, part2El] or null if no
// split is possible (no <br>s, or even the first line exceeds maxHeight).
function splitTextAtBr(el, maxHeight, ruler) {
  const parts = el.innerHTML.split(/<br\s*\/?>/i);
  if (parts.length <= 1) return null;

  let lastFitting = 0;
  for (let i = 1; i < parts.length; i++) {
    const testEl = el.cloneNode(false);
    testEl.innerHTML = parts.slice(0, i).join('<br>');
    ruler.appendChild(testEl);
    const h = testEl.offsetHeight;
    ruler.removeChild(testEl);
    if (h <= maxHeight) {
      lastFitting = i;
    } else {
      break;
    }
  }

  if (lastFitting === 0 || lastFitting >= parts.length) return null;

  const part1 = el.cloneNode(false);
  part1.innerHTML = parts.slice(0, lastFitting).join('<br>');

  const part2 = el.cloneNode(false);
  part2.innerHTML = parts.slice(lastFitting).join('<br>');

  return [part1, part2];
}

// Split the single rendered page into multiple .preview-page divs at page boundaries.
// Render happens in one tall page first so MathJax can lay out content naturally,
// then we use actual offsetTop positions (not summed offsetHeights) so that CSS
// margin collapsing between elements is already accounted for in the measurement.
// Text boxes (.preview-text) are split across pages at <br> boundaries using a
// hidden ruler element for accurate height measurement.
function paginatePreview() {
  const singlePage = previewContent.querySelector('.preview-page');
  if (!singlePage) return;

  const children = Array.from(singlePage.children);
  if (children.length === 0) return;

  // 1in padding-top; content area = 9in = 864px (letter minus top+bottom padding).
  // .preview-page has position:relative so offsetTop is relative to the page element.
  const PADDING_TOP    = 96;  // 1in at 96 dpi
  const PAGE_CONTENT_H = 864; // 9in at 96 dpi

  // Measure positions before detaching elements.
  const tops    = children.map(el => el.offsetTop - PADDING_TOP);
  const bottoms = children.map((el, i) => {
    const mb = parseFloat(getComputedStyle(el).marginBottom) || 0;
    return tops[i] + el.offsetHeight + mb;
  });

  // Hidden off-screen ruler with the same CSS as a real page — used to measure
  // split fragment heights without affecting the visible layout.
  const ruler = document.createElement('div');
  ruler.className = 'preview-page';
  ruler.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;min-height:0;';
  document.body.appendChild(ruler);

  children.forEach(el => el.remove());

  // Queue: each entry carries the element plus its measured top/bottom in the
  // original single-page coordinate space (or estimated coords for split parts).
  const queue = children.map((el, i) => ({ el, top: tops[i], bottom: bottoms[i] }));

  const pages   = [[]];
  let pageBaseY = 0; // where the current page's content area starts in original coords

  while (queue.length > 0) {
    const item        = queue.shift();
    const { el }      = item;
    const relTop      = item.top    - pageBaseY;
    const relBottom   = item.bottom - pageBaseY;
    const currentPage = pages[pages.length - 1];

    // Forced page break — start a new page without adding any element
    if (el.classList.contains('preview-pagebreak')) {
      pages.push([]);
      pageBaseY = item.top;
      continue;
    }

    if (currentPage.length > 0 && relBottom > PAGE_CONTENT_H) {
      // Element overflows the current page. Try splitting text boxes.
      const remaining = PAGE_CONTENT_H - relTop;

      if (el.classList.contains('preview-text') && remaining > 20) {
        const parts = splitTextAtBr(el, remaining, ruler);
        if (parts) {
          currentPage.push(parts[0]);
          // Measure part2 in the ruler so subsequent items can estimate positions.
          ruler.appendChild(parts[1]);
          const part2H = parts[1].offsetHeight;
          ruler.removeChild(parts[1]);
          // New page starts at item.top in original coords.
          pages.push([]);
          pageBaseY = item.top;
          // Part2 sits at the top of the new page.
          queue.unshift({ el: parts[1], top: item.top, bottom: item.top + part2H });
          continue;
        }
      }

      // Can't split — move the whole element to a new page.
      pages.push([]);
      pageBaseY = item.top;
      pages[pages.length - 1].push(el);
    } else {
      currentPage.push(el);
    }
  }

  ruler.remove();

  previewContent.innerHTML = '';
  for (const group of pages) {
    const pageDiv = document.createElement('div');
    pageDiv.className = 'preview-page';
    group.forEach(el => pageDiv.appendChild(el));
    previewContent.appendChild(pageDiv);
  }
}

function applyPreviewZoom() {
  const zoom = ZOOM_STEPS[previewZoomIndex];
  previewContent.querySelectorAll('.preview-page').forEach(page => {
    page.style.zoom = zoom + '%';
  });
  previewZoomLabel.textContent = zoom + '%';
}

function stepPreviewZoom(delta) {
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, previewZoomIndex + delta));
  if (next !== previewZoomIndex) {
    previewZoomIndex = next;
    applyPreviewZoom();
  }
}

previewZoomInBtn.addEventListener('click',  () => stepPreviewZoom(+1));
previewZoomOutBtn.addEventListener('click', () => stepPreviewZoom(-1));

previewContent.addEventListener('wheel', e => {
  if (e.ctrlKey) {
    e.preventDefault();
    stepPreviewZoom(e.deltaY < 0 ? +1 : -1);
  } else if (e.shiftKey) {
    e.preventDefault();
    previewContent.scrollLeft += e.deltaY;
  }
}, { passive: false });

previewContent.addEventListener('click', e => {
  if (graphModeBoxId) return;
  // Walk up from the clicked element to find a data-box-id
  let target = e.target;
  while (target && target !== previewContent) {
    if (target.dataset.boxId) {
      scrollAndHighlightBox(target.dataset.boxId);
      return;
    }
    target = target.parentElement;
  }
});

function scrollAndHighlightBox(boxId) {
  const el = boxList.querySelector(`[data-id="${boxId}"]`);
  if (!el) return;
  // Scroll box into center of the box list
  const listRect = boxList.getBoundingClientRect();
  const elRect   = el.getBoundingClientRect();
  const offset   = elRect.top - listRect.top - (listRect.height / 2) + (elRect.height / 2);
  boxList.scrollBy({ top: offset, behavior: 'smooth' });
  // Blink green
  el.classList.remove('box-highlight-blink');
  // Force reflow so removing+re-adding restarts the animation
  void el.offsetWidth;
  el.classList.add('box-highlight-blink');
  el.addEventListener('animationend', () => el.classList.remove('box-highlight-blink'), { once: true });
}

function togglePreview() {
  isPreviewOpen = !isPreviewOpen;
  previewPanel.classList.toggle('open', isPreviewOpen);
  divider2.classList.toggle('open', isPreviewOpen);
  const previewLabel = isPreviewOpen ? 'Hide Preview' : 'Preview';
  togglePreviewBtn.textContent = previewLabel;
  document.getElementById('graph-toggle-preview-btn').textContent = previewLabel;
  if (isPreviewOpen) {
    // Reset any manually-dragged width so it starts at flex: 1
    previewPanel.style.flex = '';
    previewPanel.style.width = '';
    updatePreview();
  }
  saveUiState();
}

togglePreviewBtn.addEventListener('click', togglePreview);
downloadPdfBtn.addEventListener('click', () => window.print()); // print dialog → "Save as PDF"

const toggleSourceBtn = document.getElementById('toggle-source-btn');
let isSourceOpen = true;

function toggleSource() {
  isSourceOpen = !isSourceOpen;
  document.getElementById('left-panel').classList.toggle('hidden', !isSourceOpen);
  document.getElementById('divider').classList.toggle('hidden', !isSourceOpen);
  const sourceLabel = isSourceOpen ? 'Hide Source' : 'Source';
  toggleSourceBtn.textContent = sourceLabel;
  document.getElementById('graph-toggle-source-btn').textContent = sourceLabel;
  saveUiState();
}

toggleSourceBtn.addEventListener('click', toggleSource);
document.getElementById('graph-toggle-source-btn').addEventListener('click', toggleSource);
document.getElementById('graph-toggle-preview-btn').addEventListener('click', togglePreview);

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === 't') { e.preventDefault(); appendBox('text'); return; }
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

function loadProjects() {
  return JSON.parse(localStorage.getItem(PROJ_KEY) || '[]');
}

function saveProjects(list) {
  localStorage.setItem(PROJ_KEY, JSON.stringify(list));
}

function saveDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({
    latex: latexSource.value,
    projectId: currentProjectId,
  }));
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

function saveCurrentProject() {
  const projects = loadProjects();
  const latex = latexSource.value;

  if (currentProjectId) {
    const idx = projects.findIndex(p => p.id === currentProjectId);
    if (idx !== -1) {
      projects[idx].latex = latex;
      saveProjects(projects);
      markClean();
      saveDraft();
      renderProjectsList();
    }
  } else {
    const title = prompt('Project title:')?.trim();
    if (!title) return;
    const id = Date.now().toString();
    projects.push({ id, title, latex });
    saveProjects(projects);
    currentProjectId = id;
    projectTitleLabel.textContent = title;
    markClean();
    saveDraft();
    renderProjectsList();
  }
}

function downloadCurrentProject() {
  const title = projectTitleLabel.textContent.replace(/\s•$/, '') || 'Untitled';
  const blob = new Blob([latexSource.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title + '.tex';
  a.click();
  URL.revokeObjectURL(url);
}

function openProject(id) {
  if (isDirty && !confirm('You have unsaved changes. Open anyway?')) return;
  const projects = loadProjects();
  const proj = projects.find(p => p.id === id);
  if (!proj) return;
  restoreFromLatex(proj.latex);
  currentProjectId = id;
  projectTitleLabel.textContent = proj.title;
  markClean();
  saveDraft();
  closeProjectsPanel();
  if (boxes.length > 0) focusBox(boxes[0].id);
  renderProjectsList();
}

function deleteProject(id) {
  if (!confirm('Delete this project?')) return;
  let projects = loadProjects();
  projects = projects.filter(p => p.id !== id);
  saveProjects(projects);
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

    const title = document.createElement('span');
    title.className = 'project-title';
    title.textContent = proj.title;

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
    item.appendChild(title);
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
  saveDraft();
  closeProjectsPanel();
  renderProjectsList();
  focusBox(boxes[0].id);
}

function openProjectsPanel() {
  projectsPanel.classList.add('open');
  projectsOverlay.classList.add('visible');
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
saveBtn.addEventListener('click', saveCurrentProject);
downloadBtn.addEventListener('click', downloadCurrentProject);

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
  // Sync graph toolbar toggle button labels to current panel state
  document.getElementById('graph-toggle-source-btn').textContent = isSourceOpen ? 'Hide Source' : 'Source';
  document.getElementById('graph-toggle-preview-btn').textContent = isPreviewOpen ? 'Hide Preview' : 'Preview';
  document.getElementById('graph-crop-checkbox').checked = showGraphCropRect;
  document.getElementById('graph-toolbar').style.display = '';
  document.getElementById('right-panel-title').textContent = 'Graph Expressions';

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

  // Set up click-to-focus: clicking a curve focuses its expression row
  renderer._onPick = exprId => {
    const listEl = document.getElementById('graph-expr-list');
    if (!listEl) return;
    const rows = Array.from(listEl.querySelectorAll('.graph-expr-row'));
    const idx = rows.findIndex(r => r.dataset.exprId === exprId);
    if (idx !== -1) focusGraphExpr(idx, 'start');
  };

  // Initial render
  renderGraphPreview();
}

function _teardownGraphModeUI() {
  clearTimeout(graphCommitTimer);
  if (graphRenderer) { graphRenderer._onRender = null; graphRenderer._onPick = null; }
  graphMqFields.clear();
  graphExprUpdateFns.clear();
  focusedGraphExprId = null;
  closeColorPopup();
  document.getElementById('graph-expr-list').innerHTML = '';
  boxList.style.display = '';
  document.getElementById('graph-editor-content').style.display = 'none';
  document.getElementById('normal-toolbar').style.display = '';
  document.getElementById('graph-toolbar').style.display = 'none';
  document.getElementById('right-panel-title').textContent = 'Equations';
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

function renderGraphExprList(box) {
  const listEl = document.getElementById('graph-expr-list');
  listEl.innerHTML = '';
  graphMqFields.clear();
  graphExprUpdateFns.clear();
  // Ensure graphExprNextId is above all existing expression ids to avoid duplicates
  for (const expr of (box.expressions || [])) {
    const m = expr.id.match(/^ge(\d+)$/);
    if (m) graphExprNextId = Math.max(graphExprNextId, parseInt(m[1]) + 1);
  }
  for (const expr of (box.expressions || [])) {
    listEl.appendChild(createGraphExprRow(expr));
  }
  // Reflow MathQuill fields after they're mounted in the DOM
  for (const field of graphMqFields.values()) {
    field.reflow();
  }
}

// Focus a graph expression by its index in the DOM list, placing cursor at 'start' or 'end'.
function focusGraphExpr(idx, edge) {
  const listEl = document.getElementById('graph-expr-list');
  if (!listEl) return;
  const rows = listEl.querySelectorAll('.graph-expr-row');
  if (idx < 0 || idx >= rows.length) return;
  const exprId = rows[idx].dataset.exprId;
  const field = graphMqFields.get(exprId);
  if (field) setTimeout(() => field.focus(), 0);
}

// Delete a graph expression by id, focusing adjacent expression or nothing.
function deleteGraphExpr(exprId) {
  const listEl = document.getElementById('graph-expr-list');
  if (!listEl) return;
  const rows = Array.from(listEl.querySelectorAll('.graph-expr-row'));
  const idx = rows.findIndex(r => r.dataset.exprId === exprId);
  const focusIdx = idx > 0 ? idx - 1 : (rows.length > 1 ? 1 : -1);

  clearTimeout(graphCommitTimer);
  const boxIdx = boxes.findIndex(b => b.id === graphModeBoxId);
  if (boxIdx !== -1) {
    boxes[boxIdx].expressions = boxes[boxIdx].expressions.filter(e => e.id !== exprId);
  }
  graphMqFields.delete(exprId);
  graphExprUpdateFns.delete(exprId);
  (rows[idx].closest('.graph-expr-wrapper') || rows[idx]).remove();
  updateGraphBoxCount(graphModeBoxId);
  syncToText();
  scheduleGraphRender();
  if (focusIdx >= 0) focusGraphExpr(focusIdx, 'end');
}

function createGraphExprRow(expr) {
  const wrapper = document.createElement('div');
  wrapper.className = 'graph-expr-wrapper';

  const row = document.createElement('div');
  row.className = 'graph-expr-row';
  row.dataset.exprId = expr.id;
  row.dataset.sliderMin = expr.sliderMin != null ? expr.sliderMin : 0;
  row.dataset.sliderMax = expr.sliderMax != null ? expr.sliderMax : 10;
  row.dataset.color = expr.color || '#3b82f6';
  row.dataset.thickness = expr.thickness != null ? expr.thickness : 2.0;
  wrapper.appendChild(row);

  // Slider row (shown only for numeric constant expressions)
  const sliderRow = document.createElement('div');
  sliderRow.className = 'graph-expr-slider-row';
  sliderRow.style.display = 'none';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'graph-expr-slider';
  slider.min = row.dataset.sliderMin;
  slider.max = row.dataset.sliderMax;
  slider.step = 'any';

  const minInput = document.createElement('input');
  minInput.type = 'number';
  minInput.className = 'graph-expr-slider-min';
  minInput.value = row.dataset.sliderMin;
  minInput.title = 'Min';

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.className = 'graph-expr-slider-max';
  maxInput.value = row.dataset.sliderMax;
  maxInput.title = 'Max';

  sliderRow.appendChild(minInput);
  sliderRow.appendChild(slider);
  sliderRow.appendChild(maxInput);

  let sliderDragging = false;

  function applySliderValue(val) {
    // Extract variable name from current latex and update the expression
    const field = graphMqFields.get(expr.id);
    if (!field) return;
    const currentLatex = field.latex();
    const nameMatch = currentLatex.match(/^([a-zA-Z]\w*)\s*=/);
    if (!nameMatch) return;
    const rounded = parseFloat(val.toPrecision(6));
    field.latex(`${nameMatch[1]}=${rounded}`);
    commitGraphEditorToBox(graphModeBoxId);
    scheduleGraphRender();
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
    row.dataset.sliderMin = min;
    commitGraphEditorToBox(graphModeBoxId);
  });

  maxInput.addEventListener('change', () => {
    const max = parseFloat(maxInput.value);
    if (isNaN(max)) return;
    slider.max = max;
    row.dataset.sliderMax = max;
    commitGraphEditorToBox(graphModeBoxId);
  });

  // Drag handle
  const handle = document.createElement('div');
  handle.className = 'graph-expr-handle';
  handle.innerHTML = '&#8942;&#8942;';
  handle.title = 'Drag to reorder';
  row.appendChild(handle);

  // Enable/disable toggle
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'graph-expr-toggle';
  toggle.checked = expr.enabled;
  toggle.addEventListener('change', () => { commitGraphEditorToBox(graphModeBoxId); scheduleGraphRender(); });
  row.appendChild(toggle);

  // Color swatch — clicking opens the color/thickness popup
  const colorSwatch = document.createElement('div');
  colorSwatch.className = 'graph-expr-color-swatch';
  colorSwatch.style.background = expr.color || '#3b82f6';
  colorSwatch.title = 'Color & thickness';
  colorSwatch.addEventListener('click', (e) => {
    e.stopPropagation();
    openColorPopup(colorSwatch, expr.id);
  });
  row.appendChild(colorSwatch);

  // Constant value badge — declared here so updateGraphingControls can reference it
  const constValueSpan = document.createElement('span');
  constValueSpan.className = 'graph-expr-const-value';
  constValueSpan.style.display = 'none';

  function updateGraphingControls(latex) {
    let graphing = false;
    let isNumericConst = false;
    let constValue = null;
    let constEvalValue = null;
    if (latex.trim() !== '' && graphModeBoxId) {
      const box = boxes.find(b => b.id === graphModeBoxId);
      const allExprs = (box ? box.expressions || [] : []).map(e =>
        e.id === expr.id ? { ...e, latex } : e
      );
      if (!allExprs.find(e => e.id === expr.id)) {
        allExprs.push({ id: expr.id, latex, color: '#000', enabled: true, thickness: 2 });
      }
      const { renderExprs, analysis } = compileGraphExpressions(allExprs);
      graphing = renderExprs.some(re => re.exprId === expr.id);
      if (!graphing) {
        const nameMatch = latex.trim().match(/^([a-zA-Z]\w*)\s*=/);
        if (nameMatch && !['x', 'y'].includes(nameMatch[1]) && analysis.constantValues.has(nameMatch[1])) {
          const constName = nameMatch[1];
          const constInfo = analysis.constants.find(c => c.name === constName);
          // Slider only for depth-0 constants (directly adjustable)
          if (constInfo && constInfo.depth === 0) {
            isNumericConst = true;
            constValue = analysis.constantValues.get(constName);
          }
          // Badge for any constant whose value was evaluated and isn't a plain number literal
          if (constInfo) {
            const evalVal = analysis.constantValues.get(constName);
            if (evalVal !== undefined) {
              const eqIdx = latex.indexOf('=');
              const rhs = eqIdx >= 0 ? latex.slice(eqIdx + 1).trim() : '';
              if (!/^-?\d+(\.\d+)?$/.test(rhs)) {
                constEvalValue = evalVal;
              }
            }
          }
        } else {
          // Try to evaluate bare constant expressions (no = sign, no x/y)
          const trimmed = latex.trim();
          if (findEqAtDepth0(trimmed) === -1) {
            try {
              const ast = parseLatexToAst(trimmed);
              const vars = collectVariables(ast);
              if (!vars.has('x') && !vars.has('y')) {
                const val = evaluateAst(ast, analysis.constantValues);
                if (isFinite(val) && !/^-?\d+(\.\d+)?$/.test(trimmed)) {
                  constEvalValue = val;
                }
              }
            } catch (e) { /* not evaluable */ }
          }
        }
      }
    }
    colorSwatch.style.display = graphing ? '' : 'none';
    toggle.style.display = graphing ? '' : 'none';
    if (!graphing) toggle.checked = true;
    sliderRow.style.display = isNumericConst ? '' : 'none';
    if (isNumericConst && constValue !== null && !sliderDragging) {
      slider.value = constValue;
    }
    // Update the constant value badge
    const formatted = constEvalValue !== null ? formatConstantValue(constEvalValue) : null;
    if (formatted !== null) {
      constValueSpan.textContent = formatted;
      constValueSpan.style.display = 'block';
    } else {
      constValueSpan.style.display = 'none';
    }
  }
  updateGraphingControls(expr.latex || '');

  // MathQuill field
  const mqSpan = document.createElement('span');
  mqSpan.className = 'graph-expr-mq';
  row.appendChild(mqSpan);
  row.appendChild(sliderRow);

  const greekLetters = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega";
  const field = MQ.MathField(mqSpan, {
    spaceBehavesLikeTab: false,
    autoCommands: 'sqrt sum int prod infty partial ' + greekLetters,
    autoOperatorNames: 'sin cos tan arcsin arccos arctan ln log exp',
    handlers: {
      edit: () => {
        updateGraphingControls(field.latex());
        clearTimeout(graphCommitTimer);
        graphCommitTimer = setTimeout(() => {
          commitGraphEditorToBox(graphModeBoxId);
          scheduleGraphRender();
        }, GRAPH_RENDER_DEBOUNCE_MS);
      },
      enter: () => {
        addGraphExpressionAfter(expr.id);
      },
      moveOutOf: (dir) => {
        const listEl = document.getElementById('graph-expr-list');
        if (!listEl) return;
        const rows = Array.from(listEl.querySelectorAll('.graph-expr-row'));
        const idx = rows.findIndex(r => r.dataset.exprId === expr.id);
        if (dir === 1 && idx < rows.length - 1) focusGraphExpr(idx + 1, 'start');
        else if (dir === -1 && idx > 0)         focusGraphExpr(idx - 1, 'end');
      },
      upOutOf: () => {
        const listEl = document.getElementById('graph-expr-list');
        if (!listEl) return;
        const rows = Array.from(listEl.querySelectorAll('.graph-expr-row'));
        const idx = rows.findIndex(r => r.dataset.exprId === expr.id);
        if (idx > 0) focusGraphExpr(idx - 1, 'end');
      },
      downOutOf: () => {
        const listEl = document.getElementById('graph-expr-list');
        if (!listEl) return;
        const rows = Array.from(listEl.querySelectorAll('.graph-expr-row'));
        const idx = rows.findIndex(r => r.dataset.exprId === expr.id);
        if (idx < rows.length - 1) focusGraphExpr(idx + 1, 'start');
      },
    },
  });
  if (expr.latex) field.latex(expr.latex);
  graphMqFields.set(expr.id, field);
  graphExprUpdateFns.set(expr.id, () => updateGraphingControls(field.latex()));

  mqSpan.addEventListener('keydown', e => {
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
    // Backspace on empty expression → delete it (mirrors regular box behavior)
    if (e.key === 'Backspace' && field.latex() === '') {
      e.preventDefault();
      deleteGraphExpr(expr.id);
    }
  }, true); // capture phase: fires before MathQuill's inner textarea handler

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'graph-expr-delete';
  delBtn.textContent = '×';
  delBtn.title = 'Remove expression';
  delBtn.addEventListener('click', () => deleteGraphExpr(expr.id));
  row.insertBefore(delBtn, sliderRow);

  // Append constant value badge last so it wraps to its own line below everything
  constValueSpan.addEventListener('click', () => {
    const raw = constValueSpan.textContent.replace(/^[≈=]\s*/, '');
    navigator.clipboard.writeText(raw).catch(() => {});
  });
  row.appendChild(constValueSpan);

  // Drag-to-reorder
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const list = document.getElementById('graph-expr-list');
    if (!list) return;

    const allWrappers = () => Array.from(list.querySelectorAll('.graph-expr-wrapper'));
    const wrapperEl = wrapper;
    const startY = e.clientY;
    const origRect = wrapperEl.getBoundingClientRect();

    // Create a floating clone
    const ghost = wrapperEl.cloneNode(true);
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

    // Placeholder to hold space
    const placeholder = document.createElement('div');
    placeholder.style.cssText = `height: ${origRect.height}px; border-radius: 6px; background: #313244; border: 1px dashed #585b70;`;
    wrapperEl.replaceWith(placeholder);

    let currentTarget = placeholder;

    function onMove(ev) {
      ghost.style.top = (origRect.top + ev.clientY - startY) + 'px';

      const siblings = allWrappers().filter(w => w !== wrapperEl);
      let inserted = false;
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        if (ev.clientY < mid) {
          if (currentTarget !== sib) {
            sib.before(placeholder);
            currentTarget = sib;
          }
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        const last = siblings[siblings.length - 1];
        if (last && currentTarget !== null) {
          list.appendChild(placeholder);
          currentTarget = null;
        }
      }
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      ghost.remove();
      placeholder.replaceWith(wrapperEl);
      commitGraphEditorToBox(graphModeBoxId);
      scheduleGraphRender();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Track focus for render-on-top highlight
  row.addEventListener('focusin', () => {
    if (focusedGraphExprId !== expr.id) {
      focusedGraphExprId = expr.id;
      scheduleGraphRender();
    }
  });
  row.addEventListener('focusout', e => {
    if (!row.contains(e.relatedTarget)) {
      const leavingId = expr.id;
      setTimeout(() => {
        if (focusedGraphExprId === leavingId) {
          focusedGraphExprId = null;
          scheduleGraphRender();
        }
      }, 0);
    }
  });

  return wrapper;
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

  const row = anchorEl.closest('.graph-expr-row');
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

  const rows = document.querySelectorAll('#graph-expr-list .graph-expr-row');
  const expressions = [];
  for (const row of rows) {
    const exprId  = row.dataset.exprId;
    const enabled   = row.querySelector('.graph-expr-toggle').checked;
    const color     = row.dataset.color || '#3b82f6';
    const thickness = parseFloat(row.dataset.thickness) || 2.0;
    const sliderMin = parseFloat(row.dataset.sliderMin) || 0;
    const sliderMax = parseFloat(row.dataset.sliderMax) || 10;
    const field     = graphMqFields.get(exprId);
    const latex     = field ? field.latex() : '';
    expressions.push({ id: exprId, latex, color, enabled, thickness, sliderMin, sliderMax });
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
  const newExpr = { id: 'ge' + (graphExprNextId++), latex: '', color: nextGraphColor(), enabled: true, thickness: 2.0 };
  const listEl = document.getElementById('graph-expr-list');
  const row = createGraphExprRow(newExpr);
  listEl.appendChild(row);
  const field = graphMqFields.get(newExpr.id);
  if (field) field.reflow();
  commitGraphEditorToBox(graphModeBoxId);
  if (field) setTimeout(() => field.focus(), 0);
}

function addGraphExpressionAfter(afterId) {
  if (!graphModeBoxId) return;
  clearTimeout(graphCommitTimer);
  commitGraphEditorToBox(graphModeBoxId);

  const newExpr = { id: 'ge' + (graphExprNextId++), latex: '', color: nextGraphColor(), enabled: true, thickness: 2.0 };
  const listEl  = document.getElementById('graph-expr-list');
  const afterRow = listEl.querySelector(`.graph-expr-row[data-expr-id="${afterId}"]`);
  const newWrapper = createGraphExprRow(newExpr);

  if (afterRow) {
    const afterWrapper = afterRow.closest('.graph-expr-wrapper') || afterRow;
    listEl.insertBefore(newWrapper, afterWrapper.nextSibling);
  } else {
    listEl.appendChild(newWrapper);
  }

  // Also insert into boxes array
  const idx = boxes.findIndex(b => b.id === graphModeBoxId);
  if (idx !== -1) {
    const exprIdx = boxes[idx].expressions.findIndex(e => e.id === afterId);
    if (exprIdx !== -1) {
      boxes[idx].expressions.splice(exprIdx + 1, 0, newExpr);
    } else {
      boxes[idx].expressions.push(newExpr);
    }
  }
  const field = graphMqFields.get(newExpr.id);
  if (field) field.reflow();
  updateGraphBoxCount(graphModeBoxId);
  syncToText();
  if (field) setTimeout(() => field.focus(), 0);
}

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
(function init() {
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
      if (proj) projectTitleLabel.textContent = proj.title;
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
})();

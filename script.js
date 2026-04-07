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
const PROJ_KEY  = 'mathnotepad_projects';
const DRAFT_KEY = 'mathnotepad_draft';
let currentProjectId = null;
let isDirty = false;

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

// ── ID generation ─────────────────────────────────────────────────────────────
function genId() { return 'b' + (nextId++); }

// ── Serialization ─────────────────────────────────────────────────────────────
function serializeToLatex(boxArray) {
  return boxArray.map(b => {
    if (b.type === 'math') return `\\[${b.content}\\]`;
    if (b.type === 'h1') return `\\section{${b.content}}`;
    if (b.type === 'h2') return `\\subsection{${b.content}}`;
    if (b.type === 'h3') return `\\subsubsection{${b.content}}`;
    // text: prefix each line with '%'
    return b.content.split('\n').map(line => '% ' + line).join('\n');
  }).join('\n\n');
}

function parseFromLatex(src) {
  const result = [];
  // We'll scan line-by-line, collecting \[...\] blocks as math and % lines as text
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Heading boxes: \section{}, \subsection{}, \subsubsection{}
    const headingPatterns = [
      { prefix: '\\section{',       type: 'h1', len: 9  },
      { prefix: '\\subsection{',    type: 'h2', len: 12 },
      { prefix: '\\subsubsection{', type: 'h3', len: 15 },
    ];
    let matchedHeading = false;
    for (const { prefix, type, len } of headingPatterns) {
      if (line.startsWith(prefix) && line.endsWith('}')) {
        result.push({ id: genId(), type, content: line.slice(len, -1) });
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
        result.push({ id: genId(), type: 'math', content: inner.content });
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
      result.push({ id: genId(), type: 'text', content: textLines.join('\n') });
      continue;
    }

    // Skip blank lines
    if (line.trim() === '') { i++; continue; }

    // Unrecognized non-empty line → treat as text box
    result.push({ id: genId(), type: 'text', content: line });
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
  div.className = 'box';
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
      autoCommands: 'sqrt sum int prod in notin subset subseteq supset supseteq cup cap emptyset forall exists infty partial setminus '+greekLetters,
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
  }

  return div;
}

// Setting the latex of a box before it is in the DOM can cause bugs. Callnig reflow after it is added fixes this.
function reflowBox(box){
  if(mqFields.get(box.id) != undefined){
    const field = mqFields.get(box.id) ;
    field.reflow();
  }
}

function setFocused(id, el) {
  focusedBoxId = id;
  el.classList.add('focused');
  // Clear source-panel box outline (source panel takes over when textarea is focused)
  boxList.querySelectorAll('.box-source-active').forEach(b => b.classList.remove('box-source-active'));
  highlightSourceForBox(id);
}

function clearFocused(id, el) {
  if (focusedBoxId === id) focusedBoxId = null;
  el.classList.remove('focused');
  updateSourceHighlight(-1, -1);
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
  const newBox = { id: genId(), type, content: '' };
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
        boxes[idx] = { id: focusedBoxId, type, content: '' };
        rebuildBoxList();
        syncToText();
        focusBox(focusedBoxId);
        return;
      }
    }
    insertBoxAfter(focusedBoxId, type);
  } else {
    const newBox = { id: genId(), type, content: '' };
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
  const focusIdx = boxes.findIndex(b => b.id === focusedBoxId);
  historyIndex--;
  restoreSnapshot(history[historyIndex], focusIdx);
}

function applyRedo() {
  if (historyIndex >= history.length - 1) return;
  const focusIdx = boxes.findIndex(b => b.id === focusedBoxId);
  historyIndex++;
  restoreSnapshot(history[historyIndex], focusIdx);
}

function restoreSnapshot(snap, preferFocusIdx = -1) {
  suppressHistory = true;
  suppressBoxSync = true;
  boxes = parseFromLatex(snap.latex);
  rebuildBoxList();
  suppressTextSync = true;
  latexSource.value = snap.latex;
  suppressTextSync = false;
  suppressBoxSync = false;
  suppressHistory = false;
  updateLineNumbers();
  updatePreview();
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
      // Reuse id, update content
      return { ...existing, content: nb.content };
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
[addMathBtn, addTextBtn, addH1Btn, addH2Btn, addH3Btn].forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault());
});
addMathBtn.addEventListener('click', () => appendBox('math'));
addTextBtn.addEventListener('click', () => appendBox('text'));
addH1Btn.addEventListener('click', () => appendBox('h1'));
addH2Btn.addEventListener('click', () => appendBox('h2'));
addH3Btn.addEventListener('click', () => appendBox('h3'));

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
  } else {
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
  for (const [key, val] of Object.entries(BB_SUBS)) out = out.replaceAll(key, val);
  return out;
}

// Escape HTML and convert $...$ to MathJax inline math \(...\).
// Splits on dollar-sign pairs; odd-indexed segments are math, even are plain text.
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function processTextContent(text) {
  return text.split(/\$([^$]+)\$/).map((part, i) => {
    if (i % 2 === 1) return `\\(${applyBBSubs(escapeHtml(part))}\\)`;
    return escapeHtml(part).replace(/\n/g, '<br>');
  }).join('');
}

function schedulePreview(delay = 400) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => updatePreview(), delay);
}

async function updatePreview() {
  if (!isPreviewOpen) return;

  let inner = '';
  for (const box of boxes) {
    if (box.type === 'math') {
      inner += `<div class="preview-math">\\[${applyBBSubs(escapeHtml(box.content))}\\]</div>`;
    } else if (box.type === 'h1' || box.type === 'h2' || box.type === 'h3') {
      const tag = box.type;
      inner += `<${tag} class="preview-${tag}">${processTextContent(box.content)}</${tag}>`;
    } else {
      inner += `<p class="preview-text">${processTextContent(box.content)}</p>`;
    }
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
  const bottoms = children.map((el, i) => tops[i] + el.offsetHeight);

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

function togglePreview() {
  isPreviewOpen = !isPreviewOpen;
  previewPanel.classList.toggle('open', isPreviewOpen);
  divider2.classList.toggle('open', isPreviewOpen);
  togglePreviewBtn.textContent = isPreviewOpen ? 'Hide Preview' : 'Preview';
  if (isPreviewOpen) {
    // Reset any manually-dragged width so it starts at flex: 1
    previewPanel.style.flex = '';
    previewPanel.style.width = '';
    updatePreview();
  }
}

togglePreviewBtn.addEventListener('click', togglePreview);
downloadPdfBtn.addEventListener('click', () => window.print()); // print dialog → "Save as PDF"

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
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
  }
  if (dragging2) {
    dragging2 = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
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

// ── Initialize ────────────────────────────────────────────────────────────────
(function init() {
  applyFontSize();
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

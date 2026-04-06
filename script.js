'use strict';

// ── MathQuill setup ──────────────────────────────────────────────────────────
const MQ = MathQuill.getInterface(2);

// ── State ────────────────────────────────────────────────────────────────────
let boxes = [];           // [{ id, type: 'math'|'text', content }]
let mqFields = new Map(); // id → MathQuill field instance
let nextId = 1;
let suppressTextSync = false; // prevent feedback loops
let suppressBoxSync  = false;
let textSyncTimer = null;
let focusedBoxId = null;
let boxClipboard = null; // { type, content } — box-level cut/paste
let dragSrcBoxId = null; // id of box being dragged

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
const boxList     = document.getElementById('box-list');
const latexSource = document.getElementById('latex-source');
const addMathBtn  = document.getElementById('add-math-btn');
const addTextBtn  = document.getElementById('add-text-btn');
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
    // text: prefix each line with '%'
    return b.content.split('\n').map(line => '% ' + line).join('\n');
  }).join('\n');
}

function parseFromLatex(src) {
  const result = [];
  // We'll scan line-by-line, collecting \[...\] blocks as math and % lines as text
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

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

    const field = MQ.MathField(mqSpan, {
      spaceBehavesLikeTab: false,
      autoCommands: 'sqrt sum int prod',
      handlers: {
        edit: () => {
          const idx = boxes.findIndex(b => b.id === box.id);
          if (idx !== -1) {
            boxes[idx].content = field.latex();
            syncToText();
          }
        },
        enter: () => {
          insertBoxAfter(box.id, 'math');
        },
      },
    });

    if (box.content) field.latex(box.content);

    // Capture-phase keydown: fires before MathQuill's inner handler so we read
    // field state before MathQuill mutates it, and can override Enter/Backspace.
    mqSpan.addEventListener('keydown', e => {
      // Enter with any modifier combo → new box (MathQuill's handlers.enter only
      // fires for plain Enter, so we must handle modified Enter here)
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey || e.altKey)) {
        e.preventDefault();
        insertBoxAfter(box.id, 'math');
      }
      // Backspace on empty → delete box
      if (e.key === 'Backspace' && field.latex() === '') {
        e.preventDefault();
        deleteBox(box.id);
      }
      // Ctrl+X: whole-box cut only when nothing is selected in MathQuill.
      // Must be capture phase so we check selection state before MQ processes the key.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        const hasSelection = !!mqSpan.querySelector('.mq-selection');
        if (!hasSelection) {
          e.preventDefault();
          e.stopPropagation();
          cutBox(box.id);
        } else {
          // Partial cut — clear box clipboard so Ctrl+V falls through to MathQuill
          boxClipboard = null;
        }
      }
    }, true); // capture phase: fires before MathQuill's inner textarea handler

    // Track focus
    mqSpan.addEventListener('focusin', () => setFocused(box.id, div));
    mqSpan.addEventListener('focusout', () => clearFocused(box.id, div));

    mqFields.set(box.id, field);

  } else {
    // Text box: textarea that auto-resizes
    const ta = document.createElement('textarea');
    ta.className = 'text-input';
    ta.rows = 1;
    ta.value = box.content || '';
    ta.placeholder = 'Text…';

    const autoResize = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    };

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
        insertBoxAfter(box.id, 'math');
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
          // Partial cut — clear box clipboard so Ctrl+V falls through to browser paste
          boxClipboard = null;
        }
      }
    });

    ta.addEventListener('focus', () => setFocused(box.id, div));
    ta.addEventListener('blur',  () => clearFocused(box.id, div));

    div.appendChild(ta);
    div.appendChild(deleteBtn);

    // Trigger resize after append
    requestAnimationFrame(autoResize);
  }

  return div;
}

function setFocused(id, el) {
  focusedBoxId = id;
  el.classList.add('focused');
}

function clearFocused(id, el) {
  if (focusedBoxId === id) focusedBoxId = null;
  el.classList.remove('focused');
}

// ── Render all boxes ──────────────────────────────────────────────────────────
function renderBoxes() {
  // Remove MQ instances for boxes that no longer exist
  const currentIds = new Set(boxes.map(b => b.id));
  for (const [id] of mqFields) {
    if (!currentIds.has(id)) mqFields.delete(id);
  }

  boxList.innerHTML = '';
  for (const box of boxes) {
    boxList.appendChild(createBoxElement(box));
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
  // Insert after currently focused box, or at end
  if (focusedBoxId) {
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
    }
  }
}

// ── Focus a box ───────────────────────────────────────────────────────────────
function focusBox(id) {
  const field = mqFields.get(id);
  if (field) {
    // MathQuill focus
    setTimeout(() => field.focus(), 0);
    return;
  }
  // Text box
  const el = boxList.querySelector(`[data-id="${id}"] .text-input`);
  if (el) setTimeout(() => el.focus(), 0);
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
  // parseFromLatex always generates new IDs, so focus by position rather than ID
  if (preferFocusIdx >= 0 && boxes.length > 0) {
    focusBox(boxes[Math.min(preferFocusIdx, boxes.length - 1)].id);
  }
}

// ── Sync right → left ─────────────────────────────────────────────────────────
function syncToText() {
  if (suppressBoxSync) return;
  suppressTextSync = true;
  const latex = serializeToLatex(boxes);
  latexSource.value = latex;
  suppressTextSync = false;
  pushHistory(latex);
  saveDraft();
  markDirty();
  updatePreview();
}

// ── Sync left → right (debounced) ─────────────────────────────────────────────
latexSource.addEventListener('input', () => {
  if (suppressTextSync) return;
  clearTimeout(textSyncTimer);
  textSyncTimer = setTimeout(() => {
    suppressBoxSync = true;
    const parsed = parseFromLatex(latexSource.value);
    diffAndApply(parsed);
    suppressBoxSync = false;
  }, 300);
});

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
          ta.style.height = 'auto';
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
    }
  }
}

// ── Toolbar buttons ───────────────────────────────────────────────────────────
addMathBtn.addEventListener('click', () => appendBox('math'));
addTextBtn.addEventListener('click', () => appendBox('text'));

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
async function updatePreview() {
  if (!isPreviewOpen) return;

  let inner = '';
  for (const box of boxes) {
    if (box.type === 'math') {
      inner += `<div class="preview-math">\\[${box.content}\\]</div>`;
    } else {
      const escaped = box.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      inner += `<p class="preview-text">${escaped}</p>`;
    }
  }

  if (window.MathJax?.typesetClear) MathJax.typesetClear([previewContent]);
  previewContent.innerHTML = `<div class="preview-page">${inner}</div>`;
  if (window.MathJax?.typesetPromise) await MathJax.typesetPromise([previewContent]);
  applyPreviewZoom(); // apply after MathJax renders so it measures at natural size
}

function applyPreviewZoom() {
  const zoom = ZOOM_STEPS[previewZoomIndex];
  const page = previewContent.querySelector('.preview-page');
  if (page) page.style.zoom = zoom + '%';
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
  mqFields.clear();
  rebuildBoxList();
  suppressTextSync = true;
  latexSource.value = latex;
  suppressTextSync = false;
  suppressBoxSync = false;
  suppressHistory = false;
  history = [{ latex, focusId: null }];
  historyIndex = 0;
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
  mqFields.clear();
  boxes = [{ id: genId(), type: 'math', content: '' }];
  rebuildBoxList();
  suppressTextSync = true;
  latexSource.value = '';
  suppressTextSync = false;
  history = [{ latex: '', focusId: null }];
  historyIndex = 0;
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
})();

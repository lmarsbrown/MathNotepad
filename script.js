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
const fontSizeLabel = document.getElementById('font-size-label');

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
  historyIndex--;
  restoreSnapshot(history[historyIndex]);
}

function applyRedo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  restoreSnapshot(history[historyIndex]);
}

function restoreSnapshot(snap) {
  suppressHistory = true;
  suppressBoxSync = true;
  boxes = parseFromLatex(snap.latex);
  rebuildBoxList();
  suppressTextSync = true;
  latexSource.value = snap.latex;
  suppressTextSync = false;
  suppressBoxSync = false;
  suppressHistory = false;
  if (snap.focusId) focusBox(snap.focusId);
}

// ── Sync right → left ─────────────────────────────────────────────────────────
function syncToText() {
  if (suppressBoxSync) return;
  suppressTextSync = true;
  const latex = serializeToLatex(boxes);
  latexSource.value = latex;
  suppressTextSync = false;
  pushHistory(latex);
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

// ── Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (undo/redo) ───────────────────────────────
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  // Don't intercept when editing the raw LaTeX textarea
  if (document.activeElement === latexSource) return;

  if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); applyUndo(); }
  if (e.key === 'z' &&  e.shiftKey) { e.preventDefault(); applyRedo(); }
  if (e.key === 'y')                 { e.preventDefault(); applyRedo(); }
});

// ── Divider drag-to-resize ────────────────────────────────────────────────────
const divider = document.getElementById('divider');
const leftPanel = document.getElementById('left-panel');
const rightPanel = document.getElementById('right-panel');

let dragging = false;
let dragStartX = 0;
let leftStartWidth = 0;

divider.addEventListener('mousedown', e => {
  dragging = true;
  dragStartX = e.clientX;
  leftStartWidth = leftPanel.getBoundingClientRect().width;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const delta = e.clientX - dragStartX;
  const totalWidth = leftPanel.parentElement.getBoundingClientRect().width - divider.offsetWidth;
  const newLeft = Math.max(200, Math.min(totalWidth - 200, leftStartWidth + delta));
  leftPanel.style.flex = 'none';
  leftPanel.style.width = newLeft + 'px';
  rightPanel.style.flex = '1';
});

document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

// ── Initialize ────────────────────────────────────────────────────────────────
(function init() {
  applyFontSize();
  boxes = [{ id: genId(), type: 'math', content: '' }];
  renderBoxes();
  syncToText(); // also seeds history[0]
  focusBox(boxes[0].id);
})();

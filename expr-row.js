'use strict';

// Shared expression row component used by both the graph editor and calc boxes.
// Returns { wrapper, row, mqField, toggle, mqSpan, handle }.

function createExprRow(expr, opts) {
  const {
    onEdit,
    onEnter,
    onMoveOut,
    onToggle,
    onDelete,
    onBackspaceEmpty,
    rightSlot,
    autoCommands,
    showDragHandle = false,
  } = opts;

  const wrapper = document.createElement('div');
  wrapper.className = 'expr-wrapper';
  wrapper.dataset.exprId = expr.id;
  if (!expr.enabled) wrapper.classList.add('expr-disabled');

  const row = document.createElement('div');
  row.className = 'expr-row';
  wrapper.appendChild(row);

  let handle = null;
  if (showDragHandle) {
    handle = document.createElement('div');
    handle.className = 'expr-drag-handle';
    handle.innerHTML = '&#8942;&#8942;';
    handle.title = 'Drag to reorder';
    row.appendChild(handle);
  }

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'expr-toggle';
  toggle.setAttribute('aria-pressed', expr.enabled ? 'true' : 'false');
  toggle.title = expr.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
  toggle.addEventListener('click', () => {
    const isEnabled = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
    toggle.title = isEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
    wrapper.classList.toggle('expr-disabled', !isEnabled);
    if (onToggle) onToggle(isEnabled);
  });
  row.appendChild(toggle);

  const mqSpan = document.createElement('span');
  mqSpan.className = 'expr-mq';
  row.appendChild(mqSpan);

  if (rightSlot) row.appendChild(rightSlot);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'expr-delete';
  delBtn.textContent = '×';
  delBtn.title = 'Delete expression';
  delBtn.addEventListener('mousedown', e => e.preventDefault());
  delBtn.addEventListener('click', () => { if (onDelete) onDelete(); });
  row.appendChild(delBtn);

  const field = MQ.MathField(mqSpan, {
    spaceBehavesLikeTab: false,
    autoCommands: autoCommands,
    autoOperatorNames: 'sin cos tan arcsin arccos arctan ln log exp',
    handlers: {
      edit:      ()    => { if (onEdit)    onEdit(field.latex()); },
      enter:     ()    => { if (onEnter)   onEnter(); },
      moveOutOf: (dir) => { if (onMoveOut) onMoveOut(dir); },
      upOutOf:   ()    => { if (onMoveOut) onMoveOut(-1); },
      downOutOf: ()    => { if (onMoveOut) onMoveOut(1); },
    },
  });

  if (onBackspaceEmpty) {
    mqSpan.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && field.latex() === '') {
        e.preventDefault();
        onBackspaceEmpty();
      }
    }, true);
  }

  return { wrapper, row, mqField: field, toggle, mqSpan, handle };
}

class CalcBox extends Box{
    constructor(id, data={}){
        super("calc",id);
        this.content = '';
        this.showResultsDefs = data.showResultsDefs !== false;
        this.showResultsBare = data.showResultsBare !== false;
        this.physicsBasic = !!data.physicsBasic;
        this.physicsEM = !!data.physicsEM;
        this.physicsChem = !!data.physicsChem;
        this.useUnits = !!data.useUnits;
        this.useSymbolic = !!data.useSymbolic;
        this.useBaseUnits = !!data.useBaseUnits;
        this.hidden = !!data.hidden;
        this.collapsed = !!data.collapsed;
        this.sigFigs = data.sigFigs || 6;
        this.expressions = data.expressions || [
            { id: 'ce' + (calcExprNextId++), latex: '', enabled: true },
        ];
        this._exprList = null; // set during createElement
        this._calcCtx  = null; // set during createElement
        this.element = this.createElement();
    }

    /**
     * Focuses a calc row (expression or text) by its exprId.
     * @param {string} exprId - The id of the expression/text row to focus.
     * @param {number} dir - 1 = arriving from above (start), -1 = arriving from below (end).
     */
    _focusCalcRowById(exprId, dir) {
        const taMap    = calcTextAreaMap.get(this.id);
        const field = this.fieldMap && this.fieldMap.get(exprId);
        if (field) { field.focus(); return; }
        const ta = taMap && taMap.get(exprId);
        if (ta) {
            ta.focus();
            const pos = dir === -1 ? ta.value.length : 0;
            ta.selectionStart = ta.selectionEnd = pos;
        }
    }

    /**
     * Creates a text annotation row inside a calc box.
     * Renders as a plain textarea with inline-LaTeX support.
     * @param {{ id: string, text: string }} expr - The text row data.
     * @returns {HTMLElement} The wrapper element.
     */
    _createCalcTextRow(expr) {
        const taMap = calcTextAreaMap.get(this.id);
        const wrapper = document.createElement('div');
        wrapper.className = 'expr-wrapper';
        wrapper.dataset.exprId = expr.id;
        wrapper.dataset.rowType = 'text';

        // Double-click → scroll preview to this specific text row and blink it
        wrapper.addEventListener('dblclick', e => {
            if (!isPreviewOpen) return;
            e.stopPropagation();
            scrollAndHighlightPreview(this.id, expr.id);
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
            const boxIdx = boxes.findIndex(b => b.id === this.id);
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
            const addAfter = calcAddExprFns.get(this.id);
            if (addAfter) addAfter(expr.id);
            return;
            }
            // Backspace on empty → delete row, focus adjacent
            if (e.key === 'Backspace' && ta.value === '') {
            e.preventDefault();
            const wrappers = [...this._exprList.querySelectorAll('.expr-wrapper')];
            const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
            if (wrappers.length > 1) {
                const focusTarget = rowIdx > 0 ? wrappers[rowIdx - 1].dataset.exprId : wrappers[rowIdx + 1].dataset.exprId;
                this._focusCalcRowById(focusTarget, rowIdx > 0 ? -1 : 1);
            }
            const idx = boxes.findIndex(b => b.id === this.id);
            if (idx !== -1) {
                const exprIdx = boxes[idx].expressions.findIndex(ex => ex.id === expr.id);
                if (exprIdx !== -1) boxes[idx].expressions.splice(exprIdx, 1);
            }
            if (taMap) taMap.delete(expr.id);
            wrapper.remove();
            commitCalcBox(this.id);
            return;
            }
            // Arrow up at start → move to previous row
            if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
            e.preventDefault();
            const wrappers = [...this._exprList.querySelectorAll('.expr-wrapper')];
            const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
            if (rowIdx > 0) {
                this._focusCalcRowById(wrappers[rowIdx - 1].dataset.exprId, -1);
            } else {
                const boxIdx = boxes.findIndex(b => b.id === this.id);
                if (boxIdx > 0) focusBoxAtEdge(boxes[boxIdx - 1].id, 'end');
            }
            return;
            }
            // Arrow down at end → move to next row
            if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
            e.preventDefault();
            const wrappers = [...this._exprList.querySelectorAll('.expr-wrapper')];
            const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
            if (rowIdx < wrappers.length - 1) {
                this._focusCalcRowById(wrappers[rowIdx + 1].dataset.exprId, 1);
            } else {
                const boxIdx = boxes.findIndex(b => b.id === this.id);
                if (boxIdx < boxes.length - 1) focusBoxAtEdge(boxes[boxIdx + 1].id, 'start');
            }
            return;
            }
        });

        ta.addEventListener('focusin',  () => setFocused(this.id, this.element));
        ta.addEventListener('focusout', (e) => {
            if (!this.element.contains(e.relatedTarget)) clearFocused(this.id, this.element);
        });

        if (taMap) taMap.set(expr.id, ta);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'expr-delete';
        delBtn.textContent = '×';
        delBtn.addEventListener('mousedown', e => e.preventDefault());
        delBtn.addEventListener('click', () => {
            const wrappers = [...this._exprList.querySelectorAll('.expr-wrapper')];
            const rowIdx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
            if (wrappers.length > 1) {
            const focusTarget = rowIdx > 0 ? wrappers[rowIdx - 1].dataset.exprId : wrappers[rowIdx + 1].dataset.exprId;
            this._focusCalcRowById(focusTarget, rowIdx > 0 ? -1 : 1);
            }
            const idx = boxes.findIndex(b => b.id === this.id);
            if (idx !== -1) {
            const exprIdx = boxes[idx].expressions.findIndex(ex => ex.id === expr.id);
            if (exprIdx !== -1) boxes[idx].expressions.splice(exprIdx, 1);
            }
            if (taMap) taMap.delete(expr.id);
            wrapper.remove();
            commitCalcBox(this.id);
        });

        row.appendChild(ta);
        row.appendChild(delBtn);
        wrapper.appendChild(row);
        return wrapper;
    }

    /**
     * Creates a results-visibility toggle button for the calc toolbar.
     * @param {string} label - Button text.
     * @param {string} title - Tooltip text.
     * @param {Function} getFlag - () => boolean — reads the current flag value from boxes[].
     * @param {Function} setFlag - (idx, val) => void — writes the flag to boxes[idx].
     * @returns {HTMLButtonElement}
     */
    _makeResultsToggle(label, title, getFlag, setFlag) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'calc-show-results-btn' + (getFlag() ? ' active' : '');
        btn.title = title;
        btn.textContent = label;
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('click', () => {
            const idx = boxes.findIndex(b => b.id === this.id);
            if (idx === -1) return;
            setFlag(idx, !getFlag());
            btn.classList.toggle('active', getFlag());
            syncToText();
            scheduleCalcUpdate(this.id);
        });
        return btn;
    }

    /**
     * Creates a physics-constants toggle button for the calc toolbar.
     * @param {string} label - Button text.
     * @param {string[]} tooltipGroup - Physics constants group for the tooltip.
     * @param {string} tooltipLabel - Display label for the tooltip.
     * @param {string} flagKey - Property key on the box object (e.g. 'physicsBasic').
     * @returns {HTMLButtonElement}
     */
    _makePhysicsBtn(label, tooltipGroup, tooltipLabel, flagKey) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'calc-show-results-btn' + (this[flagKey] ? ' active' : '');
        btn.title = buildPhysicsTooltip(tooltipGroup, tooltipLabel);
        btn.textContent = label;
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('click', () => {
            const idx = boxes.findIndex(b => b.id === this.id);
            if (idx === -1) return;
            boxes[idx][flagKey] = !boxes[idx][flagKey];
            btn.classList.toggle('active', boxes[idx][flagKey]);
            syncToText();
            scheduleCalcUpdate(this.id);
        });
        return btn;
    }

    /**
     * Inserts a new expression row after the given exprId in this calc box.
     * @param {string|null} afterExprId - Insert after this expression id, or append if null.
     */
    _addExprAfter(afterExprId) {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx === -1) return;
        const newExpr = { id: 'ce' + (calcExprNextId++), latex: '', enabled: true };
        if (afterExprId) {
            const exprIdx = boxes[idx].expressions.findIndex(e => e.id === afterExprId);
            if (exprIdx !== -1) {
            boxes[idx].expressions.splice(exprIdx + 1, 0, newExpr);
            } else {
            boxes[idx].expressions.push(newExpr);
            }
            const afterRow = this._exprList.querySelector(`.expr-wrapper[data-expr-id="${afterExprId}"]`);
            const newRow = createCalcExprRow(newExpr, this._calcCtx).wrapper;
            if (afterRow) {
            this._exprList.insertBefore(newRow, afterRow.nextSibling);
            } else {
            this._exprList.appendChild(newRow);
            }
        } else {
            boxes[idx].expressions.push(newExpr);
            this._exprList.appendChild(createCalcExprRow(newExpr, this._calcCtx).wrapper);
        }
        const newField = this.fieldMap && this.fieldMap.get(newExpr.id);
        if (newField) {
            newField.reflow();
            setTimeout(() => newField.focus(), 0);
        }
        commitCalcBox(this.id);
        scheduleCalcUpdate(this.id);
    }

    /**
     * Inserts a new text annotation row after the given exprId in this calc box.
     * @param {string|null} afterExprId - Insert after this expression id, or append if null.
     */
    _addTextAfter(afterExprId) {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx === -1) return;
        const taMap = calcTextAreaMap.get(this.id);
        const newExpr = { id: 'ct' + (calcTextNextId++), type: 'text', text: '', latex: '' };
        if (afterExprId) {
            const exprIdx = boxes[idx].expressions.findIndex(e => e.id === afterExprId);
            if (exprIdx !== -1) {
            boxes[idx].expressions.splice(exprIdx + 1, 0, newExpr);
            } else {
            boxes[idx].expressions.push(newExpr);
            }
            const afterRow = this._exprList.querySelector(`.expr-wrapper[data-expr-id="${afterExprId}"]`);
            const newRow = this._createCalcTextRow(newExpr);
            if (afterRow) {
            this._exprList.insertBefore(newRow, afterRow.nextSibling);
            } else {
            this._exprList.appendChild(newRow);
            }
        } else {
            boxes[idx].expressions.push(newExpr);
            this._exprList.appendChild(this._createCalcTextRow(newExpr));
        }
        const newTa = taMap && taMap.get(newExpr.id);
        if (newTa) setTimeout(() => newTa.focus(), 0);
        commitCalcBox(this.id);
    }

    createElement(){
        let div = super.createElement();
        div.classList.add('box-calc');

        const toolbar = document.createElement('div');
        toolbar.className = 'calc-toolbar';

        // ── Collapse button (leftmost in toolbar) ─────────────────────────────────
        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'calc-collapse-btn';
        collapseBtn.title = 'Collapse/expand expression list';
        collapseBtn.textContent = this.collapsed ? '▸' : '▾';
        collapseBtn.addEventListener('mousedown', e => e.preventDefault());
        toolbar.appendChild(collapseBtn);

        const badge = document.createElement('span');
        badge.className = 'box-type-label';
        badge.textContent = 'CALC';
        toolbar.appendChild(badge);

        toolbar.appendChild(this._makeResultsToggle(
        'Assignments',
        'Show/hide results for assignment expressions (e.g. y = x²)',
        () => boxes.find(b => b.id === this.id)?.showResultsDefs !== false,
        (idx, val) => { boxes[idx].showResultsDefs = val; }
        ));
        toolbar.appendChild(this._makeResultsToggle(
        'Bare',
        'Show/hide results for bare expressions (e.g. √2)',
        () => boxes.find(b => b.id === this.id)?.showResultsBare !== false,
        (idx, val) => { boxes[idx].showResultsBare = val; }
        ));

        // Physics constants toggles (3 groups)
        toolbar.appendChild(this._makePhysicsBtn('Physics', PHYSICS_CONSTANTS_BASIC, 'basic physics', 'physicsBasic'));
        toolbar.appendChild(this._makePhysicsBtn('E&M',     PHYSICS_CONSTANTS_EM,    'E&M',            'physicsEM'));
        toolbar.appendChild(this._makePhysicsBtn('Chem',    PHYSICS_CONSTANTS_CHEM,  'chemistry',      'physicsChem'));

        // Units mode toggle
        const unitsBtn = document.createElement('button');
        unitsBtn.type = 'button';
        unitsBtn.className = 'calc-show-results-btn' + (this.useUnits ? ' active' : '');
        unitsBtn.title = 'SI units mode: treat unit symbols (m, kg, s, N, …) as dimensional quantities';
        unitsBtn.textContent = 'Units';
        unitsBtn.addEventListener('mousedown', e => e.preventDefault());
        unitsBtn.addEventListener('click', () => {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx === -1) return;
        boxes[idx].useUnits = !boxes[idx].useUnits;
        unitsBtn.classList.toggle('active', boxes[idx].useUnits);
        // Disable dependent buttons when units mode is off
        symbolicBtn.disabled = !boxes[idx].useUnits;
        symbolicBtn.classList.toggle('btn-disabled', !boxes[idx].useUnits);
        baseUnitsBtn.disabled = !boxes[idx].useUnits;
        baseUnitsBtn.classList.toggle('btn-disabled', !boxes[idx].useUnits);
        syncToText();
        scheduleCalcUpdate(this.id);
        });
        toolbar.appendChild(unitsBtn);

        // Symbolic mode toggle (only meaningful when units mode is on)
        const symbolicBtn = document.createElement('button');
        symbolicBtn.type = 'button';
        const symActive = this.useUnits && this.useSymbolic;
        symbolicBtn.className = 'calc-show-results-btn' + (symActive ? ' active' : '') + (!this.useUnits ? ' btn-disabled' : '');
        symbolicBtn.disabled = !this.useUnits;
        symbolicBtn.title = 'Symbolic mode: keep undefined variables symbolic rather than erroring';
        symbolicBtn.textContent = 'Symbolic';
        symbolicBtn.addEventListener('mousedown', e => e.preventDefault());
        symbolicBtn.addEventListener('click', () => {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx === -1 || !boxes[idx].useUnits) return;
        boxes[idx].useSymbolic = !boxes[idx].useSymbolic;
        symbolicBtn.classList.toggle('active', boxes[idx].useSymbolic);
        syncToText();
        scheduleCalcUpdate(this.id);
        });
        toolbar.appendChild(symbolicBtn);

        // Base Units toggle (only meaningful when units mode is on)
        const baseUnitsBtn = document.createElement('button');
        baseUnitsBtn.type = 'button';
        const baseActive = this.useUnits && this.useBaseUnits;
        baseUnitsBtn.className = 'calc-show-results-btn' + (baseActive ? ' active' : '') + (!this.useUnits ? ' btn-disabled' : '');
        baseUnitsBtn.disabled = !this.useUnits;
        baseUnitsBtn.title = 'Base units mode: expand all results to SI base units (m, kg, s, A, K, mol, cd)';
        baseUnitsBtn.textContent = 'Base Units';
        baseUnitsBtn.addEventListener('mousedown', e => e.preventDefault());
        baseUnitsBtn.addEventListener('click', () => {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx === -1 || !boxes[idx].useUnits) return;
        boxes[idx].useBaseUnits = !boxes[idx].useBaseUnits;
        baseUnitsBtn.classList.toggle('active', boxes[idx].useBaseUnits);
        syncToText();
        scheduleCalcUpdate(this.id);
        });
        toolbar.appendChild(baseUnitsBtn);

        // Hidden toggle — prevents the calc box from rendering anything in the preview
        toolbar.appendChild(this._makeResultsToggle(
        'Hidden',
        'Hide this calc box from the preview (expressions still evaluate in the editor)',
        () => !!(boxes.find(b => b.id === this.id)?.hidden),
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
        sigFigsInput.value = this.sigFigs ?? 6;
        sigFigsInput.title = 'Number of significant figures for numeric results';
        sigFigsInput.addEventListener('mousedown', e => e.stopPropagation());
        sigFigsInput.addEventListener('change', () => {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx === -1) return;
        const v = parseInt(sigFigsInput.value, 10);
        if (!isNaN(v) && v >= 1 && v <= 15) {
            boxes[idx].sigFigs = v;
            syncToText();
            scheduleCalcUpdate(this.id);
        } else {
            sigFigsInput.value = boxes[idx].sigFigs ?? 6;
        }
        });
        sigFigsLabel.appendChild(sigFigsInput);
        toolbar.appendChild(sigFigsLabel);

        div.appendChild(toolbar);

        const exprList = document.createElement('div');
        exprList.className = 'calc-expr-list';
        this._exprList = exprList;

        const calcFieldMap = new Map();   // exprId → MQField
        const calcTaMap   = new Map();    // exprId → HTMLTextAreaElement
        const calcUpdateFns = new Map();  // exprId → (resultMap) => void

        this.fieldMap = calcFieldMap;

        calcTextAreaMap.set(this.id, calcTaMap);
        calcUpdateFnsMap.set(this.id, calcUpdateFns);

        // ── Calc box context passed to the module-level createCalcExprRow ────────────
        const calcCtx = {
            boxId: this.id,
            fieldMap: calcFieldMap,
            updateFns: calcUpdateFns,
            exprList,
            focusRowById: (exprId, dir) => this._focusCalcRowById(exprId, dir),
            addExpr: (afterId) => this._addExprAfter(afterId),
            commitBox: () => commitCalcBox(this.id),
            scheduleUpdate: () => scheduleCalcUpdate(this.id),
            onMoveOutOfList: (dir) => {
                const boxIdx = boxes.findIndex(b => b.id === this.id);
                if (dir === 1 && boxIdx < boxes.length - 1) focusBoxAtEdge(boxes[boxIdx + 1].id, 'start');
                else if (dir === -1 && boxIdx > 0) focusBoxAtEdge(boxes[boxIdx - 1].id, 'end');
            },
            onDblClick: (exprId) => {
                if (!isPreviewOpen) return;
                scrollAndHighlightPreview(this.id, exprId);
            },
            onFocusIn: () => setFocused(this.id, div),
            onFocusOut: (e) => { if (!div.contains(e.relatedTarget)) clearFocused(this.id, div); },
        };
        this._calcCtx = calcCtx;

        // Populate expression list
        for (const expr of (this.expressions || [])) {
        exprList.appendChild(expr.type === 'text' ? this._createCalcTextRow(expr) : createCalcExprRow(expr, calcCtx).wrapper);
        }
        div.appendChild(exprList);

        // ── Add expression button ─────────────────────────────────────────────────
        // Apply initial collapsed state
        if (this.collapsed) {
        exprList.style.display = 'none';
        }

        // Wire collapse button now that exprList exists
        collapseBtn.addEventListener('click', () => {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx === -1) return;
        boxes[idx].collapsed = !boxes[idx].collapsed;
        const isCollapsed = boxes[idx].collapsed;
        exprList.style.display  = isCollapsed ? 'none' : '';
        collapseBtn.textContent = isCollapsed ? '▸' : '▾';
        syncToText(false); // collapsed state doesn't affect preview output
        });

        // ── Register the "add expression after" and "add text row after" functions ─
        calcAddExprFns.set(this.id, (afterId) => this._addExprAfter(afterId));
        calcAddTextFns.set(this.id, (afterId) => this._addTextAfter(afterId));

        div.appendChild(this._createDeleteButton());

        // Initial result update after elements are in the DOM
        requestAnimationFrame(() => scheduleCalcUpdate(this.id));
        
        return div;
    }
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
  return /^(?:[a-zA-Z]|\\(?:alpha|beta|gamma|delta|theta|lambda|mu|sigma|phi|Phi|omega))(?:_(?:[a-zA-Z0-9]|\{[^}]*\}))?$/.test(lhs) ? 'def' : 'equation';
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

/**
 * Reads the current state of a calc box's UI and writes it back to the boxes data array, then syncs to storage.  
 * Flushes the calc box UI state into the boxes data array, then persists to storage.
 * Iterates every expr-wrapper row: text rows are saved as {id, type, text, latex},
 * expression rows are saved as {id, latex, enabled, sliderMin, sliderMax} using
 * the MathQuill field value and DOM data attributes for slider bounds.
 * @param {string} boxId - The ID of the calc box to commit.
 */
function commitCalcBox(boxId) {
  const idx = boxes.findIndex(b => b.id === boxId);
  if (idx === -1) return;
  let fieldMap = boxes[idx].fieldMap;
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
    const sliderMin = parseFloat(row.dataset.sliderMin) || 0;
    const sliderMax = parseFloat(row.dataset.sliderMax) || 10;
    expressions.push({ id: exprId, latex, enabled, sliderMin, sliderMax });
  }
  boxes[idx].expressions = expressions;
  syncToText();
}

function cleanupCalcBox(boxId) {
//   calcMqFields.delete(boxId);
  calcTextAreaMap.delete(boxId);
  calcUpdateFnsMap.delete(boxId);
  calcAddExprFns.delete(boxId);
  calcAddTextFns.delete(boxId);
  calcPendingUpdate.delete(boxId);
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

/**
 * Creates one expression row for a calc or graph editor box.
 * Shared by both calc boxes (createBoxElement) and the graph editor (renderGraphExprList).
 *
 * @param {Object} expr - Expression data ({ id, latex, enabled, sliderMin?, sliderMax? }).
 * @param {Object} ctx - Box context providing all closure-bound dependencies.
 * @param {string} ctx.boxId
 * @param {Map} ctx.fieldMap - exprId → MQField
 * @param {Map} ctx.updateFns - exprId → update function
 * @param {HTMLElement} ctx.exprList - The expression list container (.calc-expr-list or #graph-expr-list)
 * @param {Function} ctx.focusRowById - (exprId, dir) → void
 * @param {Function} ctx.addExpr - (afterId) → void, inserts a new expression after this one
 * @param {Function} ctx.commitBox - () → void, persists current box state
 * @param {Function} ctx.scheduleUpdate - () → void, triggers re-render/re-evaluate
 * @param {Function} [ctx.onAfterDelete] - (exprId) → void, extra cleanup after row deletion
 * @param {Function} [ctx.onMoveOutOfList] - (dir) → void, called when navigating past list ends
 * @param {Function} [ctx.onDblClick] - (exprId) → void, called on wrapper double-click
 * @param {Function} [ctx.onFocusIn] - () → void, called on mqSpan focusin
 * @param {Function} [ctx.onFocusOut] - (e) → void, called on mqSpan focusout
 * @param {Object} [opts] - Display options.
 * @param {HTMLElement|null} [opts.rightSlot] - Custom right-slot element; null = use result display.
 * @param {boolean} [opts.showDragHandle] - Whether to show the drag reorder handle.
 * @param {string} [opts.autoCommands] - MathQuill autoCommands override.
 * @param {Function|null} [opts.customUpdate] - (data, controls) → void, replaces default result display.
 * @returns {{ wrapper, toggle, field, mqSpan, handle }}
 */
function createCalcExprRow(expr, ctx, opts = {}) {
  const {
    rightSlot: customRightSlot = null,
    showDragHandle = false,
    //Claude: please do not touch the greek letters. There are some I dont want (like psi) because they interfere with others (you can spell epsilon without psi for example)
    autoCommands = 'sqrt sum int prod infty partial leq geq neq alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon Phi phi chi omega Omega',
    customUpdate = null,
  } = opts;

  // Create rightSlot: custom element or a fresh result display span
  let resultSpan = null;
  let rightSlotEl;
  if (customRightSlot !== null) {
    rightSlotEl = customRightSlot;
  } else {
    resultSpan = document.createElement('span');
    resultSpan.className = 'calc-expr-result';
    resultSpan.style.display = 'none';
    resultSpan.title = 'Click to copy';
    resultSpan.style.cursor = 'pointer';
    rightSlotEl = resultSpan;
  }

  const { wrapper, mqField: field, mqSpan, toggle, handle } = createExprRow(expr, {
    rightSlot: rightSlotEl,
    autoCommands,
    showDragHandle,
    onToggle: () => { ctx.commitBox(); ctx.scheduleUpdate(); },
    onDelete: () => deleteRow(false),
    onEdit: () => { ctx.commitBox(); ctx.scheduleUpdate(); },
    onEnter: () => ctx.addExpr(expr.id),
    onMoveOut: (dir) => {
      const wrappers = [...ctx.exprList.querySelectorAll('.expr-wrapper')];
      const idx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
      if (dir === 1 && idx < wrappers.length - 1) {
        ctx.focusRowById(wrappers[idx + 1].dataset.exprId, 1);
      } else if (dir === -1 && idx > 0) {
        ctx.focusRowById(wrappers[idx - 1].dataset.exprId, -1);
      } else if (ctx.onMoveOutOfList) {
        ctx.onMoveOutOfList(dir);
      }
    },
    onBackspaceEmpty: () => deleteRow(true),
  });

  // Removes row from DOM, boxes[], and state maps; optionally focuses adjacent row
  function deleteRow(focusAdjacent) {
    const wrappers = Array.from(ctx.exprList.querySelectorAll('.expr-wrapper'));
    const idx = wrappers.findIndex(w => w.dataset.exprId === expr.id);
    if (focusAdjacent && wrappers.length > 1) {
      const focusId = idx > 0 ? wrappers[idx - 1].dataset.exprId : wrappers[idx + 1].dataset.exprId;
      ctx.focusRowById(focusId, idx > 0 ? -1 : 1);
    }
    const boxIdx = boxes.findIndex(b => b.id === ctx.boxId);
    if (boxIdx !== -1) {
      const exprIdx = boxes[boxIdx].expressions.findIndex(e => e.id === expr.id);
      if (exprIdx !== -1) boxes[boxIdx].expressions.splice(exprIdx, 1);
    }
    ctx.fieldMap.delete(expr.id);
    ctx.updateFns.delete(expr.id);
    wrapper.remove();
    if (ctx.onAfterDelete) ctx.onAfterDelete(expr.id);
    ctx.commitBox();
    ctx.scheduleUpdate();
  }

  if (ctx.onDblClick) {
    wrapper.addEventListener('dblclick', e => { e.stopPropagation(); ctx.onDblClick(expr.id); });
  }

  // Slider section — shown when expression is a numeric constant like a=2
  const { showSlider, hideSlider } = createSliderSection(wrapper, expr, {
    getLatex: () => field.latex(),
    setLatex: (str) => { field.latex(str); ctx.commitBox(); ctx.scheduleUpdate(); },
    onBoundsCommit: () => ctx.commitBox(),
  });

  const errorLine = document.createElement('div');
  errorLine.className = 'calc-expr-error';
  errorLine.style.display = 'none';
  wrapper.appendChild(errorLine);

  const warningLine = document.createElement('div');
  warningLine.className = 'calc-unit-warning';
  warningLine.style.display = 'none';
  wrapper.appendChild(warningLine);

  // Copy-on-click for the result span (calc mode only — not used when rightSlot is custom)
  if (resultSpan) {
    let copyFlashing = false;
    resultSpan.addEventListener('click', () => {
      if (copyFlashing) return;
      const val = resultSpan.dataset.copyValue ?? resultSpan.textContent;
      if (!val) return;
      const num = val.replace(/^[=≈]\s*/, '');
      const prevHtml = resultSpan.innerHTML;
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
  }

  // Per-row update function stored in ctx.updateFns
  const controls = { field, toggle, showSlider, hideSlider, errorLine, warningLine, wrapper };
  const updateFn = customUpdate
    ? (data) => customUpdate(data, controls)
    : (resultMap) => {
        const result = resultMap ? resultMap.get(expr.id) : null;
        const currentExpr = boxes.find(b => b.id === ctx.boxId)?.expressions?.find(e => e.id === expr.id);
        const currentLatex = currentExpr?.latex || '';
        const kind = classifyCalcExpr(currentLatex);
        let suppress = false;
        let numericLiteralRhs = null;
        if (kind === 'def') {
          const op = findCalcOperatorAtDepth0(currentLatex.trim());
          const rhs = op ? currentLatex.trim().slice(op.idx + op.len).trim() : '';
          if (isNumericLiteralLatex(rhs) && !(result && result.boolValue !== undefined)) {
            suppress = true;
            numericLiteralRhs = rhs;
          }
        }
        if (numericLiteralRhs !== null && result && !result.error) {
          showSlider(parseFloat(numericLiteralRhs));
        } else {
          hideSlider();
        }
        warningLine.style.display = 'none';
        warningLine.textContent = '';
        if (result && result.error) {
          errorLine.textContent = result.error;
          errorLine.style.display = '';
          if (resultSpan) resultSpan.style.display = 'none';
          wrapper.classList.add('has-error');
        } else if (result && result.unitAst !== undefined && !suppress) {
          errorLine.style.display = 'none';
          wrapper.classList.remove('has-error');
          if (resultSpan) {
            const sigFigs = boxes.find(b => b.id === ctx.boxId)?.sigFigs ?? 6;
            renderUnitResult(resultSpan, result.unitAst, result.warnings, sigFigs);
            resultSpan.dataset.copyValue = buildAstText(result.unitAst, sigFigs) ?? '';
            resultSpan.style.display = '';
            resultSpan.style.color = '';
            const warnText = formatUnitWarnings(result.warnings);
            if (warnText) { warningLine.textContent = warnText; warningLine.style.display = ''; }
          }
        } else {
          const currentBox = boxes.find(b => b.id === ctx.boxId);
          const formatted = result ? formatCalcResult(result, currentBox?.sigFigs ?? 6) : null;
          if (formatted !== null && !suppress && resultSpan) {
            errorLine.style.display = 'none';
            if (formatted.length > CALC_RESULT_MAX_CHARS) {
              resultSpan.textContent = 'Too Bulky!';
              resultSpan.dataset.copyValue = formatted;
            } else {
              resultSpan.textContent = formatted;
              delete resultSpan.dataset.copyValue;
            }
            resultSpan.style.display = '';
            if (result.boolValue === true)       resultSpan.style.color = '#4ec9b0';
            else if (result.boolValue === false)  resultSpan.style.color = '#f44747';
            else                                  resultSpan.style.color = '';
            wrapper.classList.remove('has-error');
          } else {
            errorLine.style.display = 'none';
            if (resultSpan) resultSpan.style.display = 'none';
            wrapper.classList.remove('has-error');
          }
        }
      };

  ctx.updateFns.set(expr.id, updateFn);
  if (expr.latex) field.latex(expr.latex);
  ctx.fieldMap.set(expr.id, field);
  if (ctx.onFocusIn)  mqSpan.addEventListener('focusin',  () => ctx.onFocusIn());
  if (ctx.onFocusOut) mqSpan.addEventListener('focusout', (e) => ctx.onFocusOut(e));

  return { wrapper, toggle, field, mqSpan, handle };
}

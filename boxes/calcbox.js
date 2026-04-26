// ── ExpressionBox ─────────────────────────────────────────────────────────────

/**
 * A single math expression row, used by both CalcBox and the graph editor.
 * In calc mode pass the parent CalcBox as the second argument.
 * In graph mode pass a config object: { fieldMap, listEl, color, thickness,
 *   autoCommands, onEdit, onEnter, onToggle, onDeleteCallback, onReorder,
 *   onFocusIn, onFocusOut }.
 * @extends Box
 */
class ExpressionBox extends Box {
    /**
     * @param {{ id?: string, latex?: string, enabled?: boolean, sliderMin?: number, sliderMax?: number, color?: string, thickness?: number }} data
     * @param {CalcBox|Object} opts - CalcBox instance (calc mode) or graph config object.
     */
    constructor(data = {}, opts = null) {
        super('expr', data.id);
        this.latex     = data.latex   || '';
        this.enabled   = data.enabled !== false;
        this.sliderMin = data.sliderMin ?? 0;
        this.sliderMax = data.sliderMax ?? 10;

        const isGraph = opts !== null && !(opts instanceof CalcBox);
        this._isGraph    = isGraph;
        this._calcBox    = isGraph ? null : (opts || null);
        this._graphOpts  = isGraph ? opts : null;

        // Graph-specific properties; color/thickness/pointSize/draggable stored on wrapper.dataset too
        this.color     = isGraph ? (data.color     ?? opts.color     ?? '#3b82f6') : null;
        this.thickness = isGraph ? (data.thickness ?? opts.thickness ?? 2.0)       : null;
        this.pointSize = isGraph ? (data.pointSize != null ? data.pointSize : 8.0) : null;
        this.draggable = isGraph ? (data.draggable ?? false) : null;

        /** Cached expression type (calc mode): 'constant' | 'def' | 'bare' | 'equation' */
        this.exprType           = null;
        this._lastAnalyzedLatex = null;

        // DOM refs — set during createElement()
        this._mqField        = null;
        this._toggle         = null;
        this._resultSpan     = null;
        this._colorSwatch    = null;  // graph mode only
        this._errorLine      = null;
        this._warningLine    = null;
        this._showSlider     = null;
        this._hideSlider     = null;

        this.element = this.createElement();
        if (!isGraph) this._analyze();
    }

    /** @returns {HTMLElement} The list container for this expression's siblings. */
    get _listEl() { return this._isGraph ? this._graphOpts.listEl : this._calcBox._exprList; }

    /**
     * Builds the .expr-wrapper DOM for this expression row.
     * In calc mode registers _mqField into this._calcBox.fieldMap.
     * In graph mode registers into opts.fieldMap and adds color swatch + const-value badge.
     * @returns {HTMLElement}
     */
    createElement() {
        const isGraph = this._isGraph;
        const opts    = this._graphOpts;

        // ── Right-slot element(s) ────────────────────────────────────────────
        // Calc: resultSpan only.  Graph: colorSwatch as primary rightSlot,
        // resultSpan inserted into the row separately for non-graphable expressions.
        let rightSlot;
        if (isGraph) {
            const colorSwatch = document.createElement('div');
            colorSwatch.className = 'graph-expr-color-swatch';
            colorSwatch.style.background = this.color;
            colorSwatch.style.display = 'none'; // shown only when expression is graphable
            colorSwatch.title = 'Color & thickness';
            colorSwatch.addEventListener('click', e => {
                e.stopPropagation();
                openColorPopup(colorSwatch, this.id);
            });
            this._colorSwatch = colorSwatch;
            rightSlot = colorSwatch;
        } else {
            const resultSpan = document.createElement('span');
            resultSpan.className = 'calc-expr-result';
            resultSpan.style.display = 'none';
            resultSpan.title = 'Click to copy';
            resultSpan.style.cursor = 'pointer';
            this._resultSpan = resultSpan;
            rightSlot = resultSpan;
        }

        // ── MQ callbacks — differ by mode ────────────────────────────────────
        //Claude: please do not touch the greek letters. There are some I dont want (like psi) because they interfere with others (you can spell epsilon without psi for example)
        const autoCommands = isGraph
            ? opts.autoCommands
            : 'sqrt sum int prod infty partial leq geq neq alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon Phi phi chi omega Omega';

        const onEdit = isGraph
            ? () => opts.onEdit()
            : () => { this._calcBox.commit(); this._calcBox.scheduleUpdate(); this._analyze(); };

        const onEnter = isGraph
            ? () => opts.onEnter()
            : () => this._calcBox._addExprAfter(this.id);

        const onToggle = isGraph
            ? () => opts.onToggle()
            : () => { this._calcBox.commit(); this._calcBox.scheduleUpdate(); };

        const onMoveOut = isGraph
            ? (dir) => {
                const wrappers = [...opts.listEl.querySelectorAll('.expr-wrapper')];
                const idx = wrappers.findIndex(w => w.dataset.exprId === this.id);
                if (dir === 1 && idx < wrappers.length - 1)
                    focusExprRowById(opts.fieldMap, wrappers[idx + 1].dataset.exprId);
                else if (dir === -1 && idx > 0)
                    focusExprRowById(opts.fieldMap, wrappers[idx - 1].dataset.exprId);
            }
            : (dir) => {
                const wrappers = [...this._calcBox._exprList.querySelectorAll('.expr-wrapper')];
                const idx = wrappers.findIndex(w => w.dataset.exprId === this.id);
                if (dir === 1 && idx < wrappers.length - 1) {
                    this._calcBox._focusCalcRowById(wrappers[idx + 1].dataset.exprId, 1);
                } else if (dir === -1 && idx > 0) {
                    this._calcBox._focusCalcRowById(wrappers[idx - 1].dataset.exprId, -1);
                } else {
                    const boxIdx = boxes.findIndex(b => b.id === this._calcBox.id);
                    if (dir === 1 && boxIdx < boxes.length - 1) focusBoxAtEdge(boxes[boxIdx + 1].id, 'start');
                    else if (dir === -1 && boxIdx > 0) focusBoxAtEdge(boxes[boxIdx - 1].id, 'end');
                }
            };

        // ── Build wrapper, row, and interactive elements ─────────────────────
        const wrapper = document.createElement('div');
        wrapper.className = 'expr-wrapper';
        wrapper.dataset.exprId = this.id;
        if (!this.enabled) wrapper.classList.add('expr-disabled');

        const row = document.createElement('div');
        row.className = 'expr-row';
        wrapper.appendChild(row);

        const handle = document.createElement('div');
        handle.className = 'expr-drag-handle';
        handle.innerHTML = '&#8942;&#8942;';
        handle.title = 'Drag to reorder';
        row.appendChild(handle);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'expr-toggle';
        toggle.setAttribute('aria-pressed', this.enabled ? 'true' : 'false');
        toggle.title = this.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
        toggle.addEventListener('click', () => {
            const isEnabled = toggle.getAttribute('aria-pressed') !== 'true';
            toggle.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
            toggle.title = isEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
            wrapper.classList.toggle('expr-disabled', !isEnabled);
            onToggle(isEnabled);
        });
        row.appendChild(toggle);

        const mqSpan = document.createElement('span');
        mqSpan.className = 'expr-mq';
        row.appendChild(mqSpan);

        row.appendChild(rightSlot);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'expr-delete';
        delBtn.textContent = '×';
        delBtn.title = 'Delete expression';
        delBtn.addEventListener('mousedown', e => e.preventDefault());
        delBtn.addEventListener('click', () => this._delete(false));
        row.appendChild(delBtn);

        const field = MQ.MathField(mqSpan, {
            spaceBehavesLikeTab: false,
            autoCommands,
            autoOperatorNames: 'sin cos tan cot sec csc arcsin arccos arctan ln log exp mat',
            handlers: {
                edit:      ()    => onEdit(field.latex()),
                enter:     ()    => onEnter(),
                moveOutOf: (dir) => onMoveOut(dir),
                upOutOf:   ()    => onMoveOut(-1),
                downOutOf: ()    => onMoveOut(1),
            },
        });

        mqSpan.addEventListener('keydown', e => {
            if (e.key === 'Backspace' && field.latex() === '') {
                e.preventDefault();
                this._delete(true);
            }
        }, true);
        this._mqField = field;
        this._toggle  = toggle;

        // In graph mode: insert a result span into the row for non-graphable expressions.
        // Placed just before the delete button so it sits in the same row slot position.
        if (isGraph) {
            const resultSpan = document.createElement('span');
            resultSpan.className = 'calc-expr-result';
            resultSpan.style.display = 'none';
            resultSpan.title = 'Click to copy';
            resultSpan.style.cursor = 'pointer';
            this._resultSpan = resultSpan;
            const delBtn = row.querySelector('.expr-delete');
            if (delBtn) row.insertBefore(resultSpan, delBtn);
            else        row.appendChild(resultSpan);

            // Store color/thickness/pointSize/draggable in wrapper dataset so color popup and toData() can read them
            wrapper.dataset.color     = this.color;
            wrapper.dataset.thickness = this.thickness;
            wrapper.dataset.pointSize = this.pointSize != null ? this.pointSize : 8.0;
            wrapper.dataset.draggable = this.draggable ? '1' : '0';
        }

        // ── Drag-to-reorder (shared implementation, mode-specific onUp) ───────
        if (handle) handle.addEventListener('mousedown', e => {
            e.preventDefault();
            const listEl = this._listEl;
            const allWrappers = () => Array.from(listEl.querySelectorAll('.expr-wrapper'));
            const startY   = e.clientY;
            const origRect = wrapper.getBoundingClientRect();

            const ghost = wrapper.cloneNode(true);
            ghost.style.cssText = `
              position: fixed;
              left: ${origRect.left}px; top: ${origRect.top}px;
              width: ${origRect.width}px; opacity: 0.85;
              pointer-events: none; z-index: 9999;
              box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            `;
            document.body.appendChild(ghost);

            const placeholder = document.createElement('div');
            placeholder.style.cssText = `height: ${origRect.height}px; border-radius: 6px; background: #313244; border: 1px dashed #585b70;`;
            wrapper.replaceWith(placeholder);
            let currentTarget = placeholder;

            const onMove = (ev) => {
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
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                ghost.remove();
                placeholder.replaceWith(wrapper);
                if (isGraph) {
                    opts.onReorder();
                } else {
                    // Re-sync expressions array from DOM order
                    const newWrappers = Array.from(listEl.querySelectorAll('.expr-wrapper'));
                    this._calcBox.expressions = newWrappers
                        .map(w => this._calcBox.expressions.find(ex => ex.id === w.dataset.exprId))
                        .filter(Boolean);
                    this._calcBox.commit();
                    this._calcBox.scheduleUpdate();
                }
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // ── Undo/redo keyboard shortcuts inside MathQuill ────────────────────
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

        // ── Focus tracking ───────────────────────────────────────────────────
        if (isGraph) {
            wrapper.addEventListener('focusin', () => {
                if (opts.onFocusIn) opts.onFocusIn(this.id);
            });
            wrapper.addEventListener('focusout', e => {
                if (!wrapper.contains(e.relatedTarget) && opts.onFocusOut) opts.onFocusOut(this.id);
            });
        } else {
            mqSpan.addEventListener('focusin',  () => setFocused(this._calcBox.id, this._calcBox.element));
            mqSpan.addEventListener('focusout', (e) => {
                if (!this._calcBox.element.contains(e.relatedTarget)) clearFocused(this._calcBox.id, this._calcBox.element);
            });
        }

        // ── Calc-only: double-click scrolls preview ──────────────────────────
        if (!isGraph) {
            wrapper.addEventListener('dblclick', e => {
                if (!isPreviewOpen) return;
                e.stopPropagation();
                scrollAndHighlightPreview(this._calcBox.id, this.id);
            });
        }

        // ── Slider ───────────────────────────────────────────────────────────
        const { showSlider, hideSlider } = createSliderSection(wrapper, this, isGraph
            ? {
                getLatex:       () => this._mqField.latex(),
                setLatex:       (str) => { this._mqField.latex(str); opts.onEdit(); },
                onBoundsCommit: () => opts.onEdit(),
              }
            : {
                getLatex:       () => this._mqField.latex(),
                setLatex:       (str) => { this._mqField.latex(str); this._calcBox.commit(); this._calcBox.scheduleUpdate(); },
                onBoundsCommit: () => this._calcBox.commit(),
              }
        );
        this._showSlider = showSlider;
        this._hideSlider = hideSlider;

        // ── Error / warning lines (always created) ───────────────────────────
        const errorLine = document.createElement('div');
        errorLine.className = 'calc-expr-error';
        errorLine.style.display = 'none';
        wrapper.appendChild(errorLine);
        this._errorLine = errorLine;

        const warningLine = document.createElement('div');
        warningLine.className = 'calc-unit-warning';
        warningLine.style.display = 'none';
        wrapper.appendChild(warningLine);
        this._warningLine = warningLine;

        // ── Copy-on-click for result span ────────────────────────────────────
        _wireResultSpanCopy(this._resultSpan);

        // ── MQ field initialization and registration ─────────────────────────
        if (this.latex) field.latex(this.latex);
        const fieldMap = isGraph ? opts.fieldMap : this._calcBox.fieldMap;
        fieldMap.set(this.id, this._mqField);

        return wrapper;
    }

    /**
     * Classifies the current LaTeX and caches result in this.exprType.
     * No-op if the LaTeX hasn't changed since last call.
     * Types: 'constant' (def with numeric literal RHS), 'def', 'bare', 'equation'.
     * Only used in calc mode; graph mode uses evaluateBoxExpressions results.
     */
    _analyze() {
        const latex = this._mqField ? this._mqField.latex() : this.latex;
        if (latex === this._lastAnalyzedLatex) return;
        this._lastAnalyzedLatex = latex;
        const kind = classifyCalcExpr(latex);
        if (kind === 'def') {
            const op  = findCalcOperatorAtDepth0(latex.trim());
            const rhs = op ? latex.trim().slice(op.idx + op.len).trim() : '';
            this.exprType = isNumericLiteralLatex(rhs) ? 'constant' : 'def';
        } else {
            this.exprType = kind;
        }
    }

    /**
     * Removes this row from the DOM and cleans up its state.
     * In calc mode updates the parent's expressions array.
     * In graph mode calls opts.onDeleteCallback(id) for external cleanup.
     * @param {boolean} focusAdjacent - Whether to focus the nearest remaining row.
     */
    _delete(focusAdjacent) {
        if (focusAdjacent) {
            const wrappers = Array.from(this._listEl.querySelectorAll('.expr-wrapper'));
            const idx = wrappers.findIndex(w => w.dataset.exprId === this.id);
            if (wrappers.length > 1) {
                const focusId = idx > 0 ? wrappers[idx - 1].dataset.exprId : wrappers[idx + 1].dataset.exprId;
                if (this._isGraph) {
                    focusExprRowById(this._graphOpts.fieldMap, focusId);
                } else {
                    this._calcBox._focusCalcRowById(focusId, idx > 0 ? -1 : 1);
                }
            }
        }
        this.element.remove();
        if (this._isGraph) {
            this._graphOpts.fieldMap.delete(this.id);
            if (this._graphOpts.onDeleteCallback) this._graphOpts.onDeleteCallback(this.id);
        } else {
            const exprIdx = this._calcBox.expressions.indexOf(this);
            if (exprIdx !== -1) this._calcBox.expressions.splice(exprIdx, 1);
            this._calcBox.fieldMap.delete(this.id);
            this._calcBox.commit();
            this._calcBox.scheduleUpdate();
        }
    }

    /**
     * Updates the result display for a calc-mode row.
     * @param {Map|null} resultMap - Map<exprId, result> from evaluateCalcExpressions.
     */
    updateResult(resultMap) {
        this._applyResult(resultMap, this._calcBox ? this._calcBox.sigFigs ?? 6 : 6);
    }

    /**
     * Unified update for graph-mode rows. Shows color swatch for graphable expressions
     * and numeric results (via result span) for everything else.
     * @param {Map} resultMap - Map<exprId, result> from evaluateCalcExpressions.
     * @param {Set<string>} graphableIds - Set of expression ids currently being graphed.
     * @param {number} [sigFigs=6]
     * @param {Map|null} [compilationErrors] - Map<exprId, errorString> from shader compilation.
     */
    update(resultMap, graphableIds, sigFigs = 6, compilationErrors = null) {
        if (!this._isGraph) { this._applyResult(resultMap, sigFigs); return; }

        this._analyze();

        const isGraphable = graphableIds && graphableIds.has(this.id);
        const isPoint = this.element && this.element.dataset.kind === 'point';

        if (this._colorSwatch) this._colorSwatch.style.display = isGraphable ? '' : 'none';
        // Never hide the toggle or overwrite its state here — the toggle is always
        // visible in graph mode and its aria-pressed state is owned by user interaction.

        if (isGraphable && !isPoint) {
            if (this._resultSpan) this._resultSpan.style.display = 'none';
            this._hideSlider();
            this._warningLine.style.display = 'none';
            const compileErr = compilationErrors && compilationErrors.get(this.id);
            if (compileErr) {
                this._errorLine.textContent = compileErr;
                this._errorLine.style.display = '';
                this.element.classList.add('has-error');
            } else {
                this._errorLine.style.display = 'none';
                this.element.classList.remove('has-error');
            }
        } else {
            this._applyResult(resultMap, sigFigs);
        }
    }

    /**
     * Shared result-display logic used by both updateResult() and update().
     * Handles slider visibility, error lines, unit results, and numeric results.
     * @param {Map|null} resultMap
     * @param {number} sigFigs
     */
    _applyResult(resultMap, sigFigs) {
        const result       = resultMap ? resultMap.get(this.id) : null;
        const currentLatex = this._mqField ? this._mqField.latex() : this.latex;
        let suppress = false;
        let numericLiteralRhs = null;

        // Suppress result span and show slider for simple numeric constants (a = 5)
        if (this.exprType === 'constant' && !(result && result.boolValue !== undefined)) {
            suppress = true;
            const op = findCalcOperatorAtDepth0(currentLatex.trim());
            numericLiteralRhs = op ? currentLatex.trim().slice(op.idx + op.len).trim() : '';
        }
        if (numericLiteralRhs !== null && result && !result.error) {
            this._showSlider(parseFloat(numericLiteralRhs));
        } else {
            this._hideSlider();
        }

        this._warningLine.style.display = 'none';
        this._warningLine.textContent   = '';

        if (result && result.error) {
            this._errorLine.textContent = result.error;
            this._errorLine.style.display = '';
            this._resultSpan.style.display = 'none';
            this.element.classList.add('has-error');
        } else if (result && result.pointAst !== undefined && !suppress) {
            this._errorLine.style.display = 'none';
            this.element.classList.remove('has-error');
            const xText = buildAstText(result.pointAst.args[0], sigFigs);
            const yText = buildAstText(result.pointAst.args[1], sigFigs);
            const ptText = (xText !== null && yText !== null) ? `= (${xText}, ${yText})` : '= (?, ?)';
            this._resultSpan.textContent = ptText.length > CALC_RESULT_MAX_CHARS ? 'Too Bulky!' : ptText;
            this._resultSpan.dataset.copyValue = ptText;
            this._resultSpan.style.display = '';
            this._resultSpan.style.color = '';
        } else if (result && result.unitAst !== undefined && !suppress) {
            this._errorLine.style.display = 'none';
            this.element.classList.remove('has-error');
            renderUnitResult(this._resultSpan, result.unitAst, result.warnings, sigFigs);
            this._resultSpan.dataset.copyValue = buildAstText(result.unitAst, sigFigs) ?? '';
            this._resultSpan.style.display = '';
            this._resultSpan.style.color = '';
            const warnText = formatUnitWarnings(result.warnings);
            if (warnText) { this._warningLine.textContent = warnText; this._warningLine.style.display = ''; }
        } else {
            const formatted = result ? formatCalcResult(result, sigFigs) : null;
            if (formatted !== null && !suppress) {
                this._errorLine.style.display = 'none';
                if (formatted.length > CALC_RESULT_MAX_CHARS) {
                    this._resultSpan.textContent = 'Too Bulky!';
                    this._resultSpan.dataset.copyValue = formatted;
                } else {
                    this._resultSpan.textContent = formatted;
                    delete this._resultSpan.dataset.copyValue;
                }
                this._resultSpan.style.display = '';
                if (result.boolValue === true)      this._resultSpan.style.color = '#4ec9b0';
                else if (result.boolValue === false) this._resultSpan.style.color = '#f44747';
                else                                 this._resultSpan.style.color = '';
                this.element.classList.remove('has-error');
            } else {
                this._errorLine.style.display = 'none';
                this._resultSpan.style.display = 'none';
                this.element.classList.remove('has-error');
            }
        }
    }

    /** Focuses the MathQuill field. */
    focus() {
        if (this._mqField) this._mqField.focus();
    }

    /**
     * Returns a plain serializable data object for persistence.
     * Graph mode includes color and thickness; calc mode does not.
     * @returns {Object}
     */
    toData() {
        const latex     = this._mqField ? this._mqField.latex() : this.latex;
        const enabled   = this._toggle  ? this._toggle.getAttribute('aria-pressed') === 'true' : this.enabled;
        const sliderMin = this.element  ? (parseFloat(this.element.dataset.sliderMin) || 0)  : this.sliderMin;
        const sliderMax = this.element  ? (parseFloat(this.element.dataset.sliderMax) || 10) : this.sliderMax;
        if (this._isGraph) {
            const color     = this.element ? (this.element.dataset.color                 || this.color)     : this.color;
            const thickness = this.element ? (parseFloat(this.element.dataset.thickness) || 2.0)            : this.thickness;
            const tMin      = this.element ? parseFloat(this.element.dataset.tMin  ?? 0) : (this.tMin  ?? 0);
            const tMax      = this.element ? parseFloat(this.element.dataset.tMax  ?? 1) : (this.tMax  ?? 1);
            const pointSize = this.element
                ? (parseFloat(this.element.dataset.pointSize) || 8.0)
                : (this.pointSize ?? 8.0);
            const draggable = this.element
                ? (this.element.dataset.draggable === '1')
                : (this.draggable ?? false);
            return { id: this.id, latex, enabled, color, thickness, sliderMin, sliderMax, tMin, tMax, pointSize, draggable };
        }
        return { id: this.id, latex, enabled, sliderMin, sliderMax };
    }
}

/**
 * Wires copy-on-click behaviour onto a result span element.
 * @param {HTMLElement|null} span
 */
function _wireResultSpanCopy(span) {
    if (!span) return;
    let copyFlashing = false;
    span.addEventListener('click', () => {
        if (copyFlashing) return;
        const val = span.dataset.copyValue ?? span.textContent;
        if (!val) return;
        const num = val.replace(/^[=≈]\s*/, '');
        const prevHtml  = span.innerHTML;
        const prevColor = span.style.color;
        copyFlashing = true;
        navigator.clipboard.writeText(num).then(() => {
            span.textContent = 'copied!';
            span.style.color = '#4ec9b0';
            setTimeout(() => {
                span.innerHTML = prevHtml;
                span.style.color = prevColor;
                copyFlashing = false;
            }, 900);
        }).catch(() => { copyFlashing = false; });
    });
}

// ── CalcTextRow ───────────────────────────────────────────────────────────────

/**
 * Represents a text annotation row within a CalcBox.
 * Uses type='text' for serialization compatibility with serializeToLatex().
 * @extends Box
 */
class CalcTextRow extends Box {
    /**
     * @param {{ id?: string, text?: string }} data
     * @param {CalcBox} calcBox - Parent CalcBox instance.
     */
    constructor(data = {}, calcBox) {
        super('text', data.id);
        this.content   = data.text || '';
        this.latex     = '';    // always empty; toData() returns this in the data object
        this.enabled   = true;  // always enabled; evaluator skips empty-latex rows
        this._calcBox  = calcBox;
        this._textarea = null;  // set during createElement()
        this.element   = this.createElement();
    }

    /** preview.js reads e.text on CalcTextRow instances when rendering the preview panel. */
    get text() { return this.content; }

    /**
     * Builds the .expr-wrapper[data-row-type=text] DOM for this annotation row.
     * @returns {HTMLElement}
     */
    createElement() {
        const taMap = this._calcBox.textAreaMap;

        const wrapper = document.createElement('div');
        wrapper.className = 'expr-wrapper';
        wrapper.dataset.exprId  = this.id;
        wrapper.dataset.rowType = 'text';

        wrapper.addEventListener('dblclick', e => {
            if (!isPreviewOpen) return;
            e.stopPropagation();
            scrollAndHighlightPreview(this._calcBox.id, this.id);
        });

        const row = document.createElement('div');
        row.className = 'calc-text-row';

        const ta = document.createElement('textarea');
        ta.className   = 'calc-text-input';
        ta.rows        = 1;
        ta.value       = this.content;
        ta.placeholder = 'Text…';
        this._textarea = ta;

        const autoResize = () => {
            ta.style.height = '1px';
            ta.style.height = ta.scrollHeight + 'px';
        };
        requestAnimationFrame(autoResize);

        ta.addEventListener('input', () => {
            autoResize();
            this.content = ta.value;
            syncToText();
        });

        ta.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._calcBox._addExprAfter(this.id);
                return;
            }
            if (e.key === 'Backspace' && ta.value === '') {
                e.preventDefault();
                this._delete(true);
                return;
            }
            if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
                e.preventDefault();
                const wrappers = [...this._calcBox._exprList.querySelectorAll('.expr-wrapper')];
                const rowIdx = wrappers.findIndex(w => w.dataset.exprId === this.id);
                if (rowIdx > 0) {
                    this._calcBox._focusCalcRowById(wrappers[rowIdx - 1].dataset.exprId, -1);
                } else {
                    const boxIdx = boxes.findIndex(b => b.id === this._calcBox.id);
                    if (boxIdx > 0) focusBoxAtEdge(boxes[boxIdx - 1].id, 'end');
                }
                return;
            }
            if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
                e.preventDefault();
                const wrappers = [...this._calcBox._exprList.querySelectorAll('.expr-wrapper')];
                const rowIdx = wrappers.findIndex(w => w.dataset.exprId === this.id);
                if (rowIdx < wrappers.length - 1) {
                    this._calcBox._focusCalcRowById(wrappers[rowIdx + 1].dataset.exprId, 1);
                } else {
                    const boxIdx = boxes.findIndex(b => b.id === this._calcBox.id);
                    if (boxIdx < boxes.length - 1) focusBoxAtEdge(boxes[boxIdx + 1].id, 'start');
                }
                return;
            }
        });

        ta.addEventListener('focusin',  ()  => setFocused(this._calcBox.id, this._calcBox.element));
        ta.addEventListener('focusout', (e) => {
            if (!this._calcBox.element.contains(e.relatedTarget)) clearFocused(this._calcBox.id, this._calcBox.element);
        });

        if (taMap) taMap.set(this.id, ta);

        const delBtn = document.createElement('button');
        delBtn.type      = 'button';
        delBtn.className = 'expr-delete';
        delBtn.textContent = '×';
        delBtn.addEventListener('mousedown', e => e.preventDefault());
        delBtn.addEventListener('click', () => this._delete(true));

        row.appendChild(ta);
        row.appendChild(delBtn);
        wrapper.appendChild(row);
        return wrapper;
    }

    /**
     * Removes this row from the DOM and the parent CalcBox's expression list.
     * @param {boolean} focusAdjacent
     */
    _delete(focusAdjacent) {
        if (focusAdjacent) {
            const wrappers = [...this._calcBox._exprList.querySelectorAll('.expr-wrapper')];
            const rowIdx = wrappers.findIndex(w => w.dataset.exprId === this.id);
            if (wrappers.length > 1) {
                const focusId = rowIdx > 0 ? wrappers[rowIdx - 1].dataset.exprId : wrappers[rowIdx + 1].dataset.exprId;
                this._calcBox._focusCalcRowById(focusId, rowIdx > 0 ? -1 : 1);
            }
        }
        this._calcBox.textAreaMap.delete(this.id);
        const exprIdx = this._calcBox.expressions.indexOf(this);
        if (exprIdx !== -1) this._calcBox.expressions.splice(exprIdx, 1);
        this.element.remove();
        this._calcBox.commit();
    }

    /**
     * Returns a plain serializable data object for persistence.
     * @returns {{ id: string, type: string, text: string, latex: string }}
     */
    toData() {
        return { id: this.id, type: 'text', text: this._textarea ? this._textarea.value : this.content, latex: '' };
    }
}

// ── CalcBox ───────────────────────────────────────────────────────────────────

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
        // Initialize maps early so ExpressionBox/CalcTextRow constructors can register into them
        this.fieldMap    = new Map();
        this.textAreaMap = new Map();
        this._pendingUpdate = false;
        // Map plain data objects to class instances
        const defaultExpr = { id: 'ce' + (calcExprNextId++), latex: '', enabled: true };
        this.expressions = (data.expressions || [defaultExpr]).map(e =>
            e.type === 'text' ? new CalcTextRow(e, this) : new ExpressionBox(e, this)
        );
        this._exprList = null; // set during createElement
        this.element = this.createElement();
    }

    /**
     * Focuses a calc row (expression or text) by its exprId.
     * @param {string} exprId - The id of the expression/text row to focus.
     * @param {number} dir - 1 = arriving from above (start), -1 = arriving from below (end).
     */
    _focusCalcRowById(exprId, dir) {
        const taMap = this.textAreaMap;
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
            this.scheduleUpdate();
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
            this.scheduleUpdate();
        });
        return btn;
    }

    /**
     * Inserts a new expression row after the given exprId in this calc box.
     * @param {string|null} afterExprId - Insert after this expression id, or append if null.
     */
    _addExprAfter(afterExprId) {
        const newData    = { id: 'ce' + (calcExprNextId++), latex: '', enabled: true };
        const newExprBox = new ExpressionBox(newData, this);
        if (afterExprId) {
            const exprIdx = this.expressions.findIndex(e => e.id === afterExprId);
            if (exprIdx !== -1) {
                this.expressions.splice(exprIdx + 1, 0, newExprBox);
            } else {
                this.expressions.push(newExprBox);
            }
            const afterRow = this._exprList.querySelector(`[data-expr-id="${afterExprId}"]`);
            if (afterRow) {
                this._exprList.insertBefore(newExprBox.element, afterRow.nextSibling);
            } else {
                this._exprList.appendChild(newExprBox.element);
            }
        } else {
            this.expressions.push(newExprBox);
            this._exprList.appendChild(newExprBox.element);
        }
        newExprBox._mqField.reflow();
        setTimeout(() => newExprBox._mqField.focus(), 0);
        this.commit();
        this.scheduleUpdate();
    }

    /**
     * Inserts a new text annotation row after the given exprId in this calc box.
     * @param {string|null} afterExprId - Insert after this expression id, or append if null.
     */
    _addTextAfter(afterExprId) {
        const newData    = { id: 'ct' + (calcTextNextId++), text: '' };
        const newTextRow = new CalcTextRow(newData, this);
        if (afterExprId) {
            const exprIdx = this.expressions.findIndex(e => e.id === afterExprId);
            if (exprIdx !== -1) {
                this.expressions.splice(exprIdx + 1, 0, newTextRow);
            } else {
                this.expressions.push(newTextRow);
            }
            const afterRow = this._exprList.querySelector(`[data-expr-id="${afterExprId}"]`);
            if (afterRow) {
                this._exprList.insertBefore(newTextRow.element, afterRow.nextSibling);
            } else {
                this._exprList.appendChild(newTextRow.element);
            }
        } else {
            this.expressions.push(newTextRow);
            this._exprList.appendChild(newTextRow.element);
        }
        setTimeout(() => newTextRow._textarea?.focus(), 0);
        this.commit();
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
        this.scheduleUpdate();
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
        this.scheduleUpdate();
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
        this.scheduleUpdate();
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
            this.scheduleUpdate();
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

        // Populate expression list from pre-built ExpressionBox/CalcTextRow instances
        for (const exprBox of this.expressions) {
            exprList.appendChild(exprBox.element);
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

        div.appendChild(this._createDeleteButton());

        // Initial result update after elements are in the DOM
        requestAnimationFrame(() => this.scheduleUpdate());
        
        return div;
    }

    /**
     * Debounces result evaluation using requestAnimationFrame.
     * Safe to call multiple times per frame; only one update will run.
     */
    scheduleUpdate() {
        if (this._pendingUpdate) return;
        this._pendingUpdate = true;
        requestAnimationFrame(() => {
            this._pendingUpdate = false;
            this.updateResults();
        });
    }

    /**
     * Evaluates all expressions in this calc box and updates each row's result display.
     */
    updateResults() {
        const exprData = this.expressions.map(e => e.toData ? e.toData() : e);
        const results = evaluateCalcExpressions(exprData, {
            usePhysicsBasic: !!this.physicsBasic,
            usePhysicsEM:    !!this.physicsEM,
            usePhysicsChem:  !!this.physicsChem,
            useUnits:        !!this.useUnits,
            useSymbolic:     !!this.useSymbolic,
            useBaseUnits:    !!this.useBaseUnits,
        });
        for (const exprBox of this.expressions) {
            if (exprBox instanceof ExpressionBox) exprBox.updateResult(results);
        }
    }

    /**
     * Syncs this calc box's state to the LaTeX source panel (right → left sync).
     */
    commit() {
        syncToText();
    }

    /**
     * Cancels any pending update. Called when the box is removed from the document.
     */
    dispose() {
        this._pendingUpdate = false;
    }
}

// ── Calc box helpers ──────────────────────────────────────────────────────────

function formatCalcResult(result, sigFigs = 6) {
  if (!result) return null;
  if (result.error) return null;
  if (result.boolValue !== undefined) return result.boolValue ? 'true' : 'false';
  if (result.pointValue !== undefined) {
    const { px, py } = result.pointValue;
    return `= (${_astNumStr(px, sigFigs)}, ${_astNumStr(py, sigFigs)})`;
  }
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
  if (result.pointValue !== undefined) {
    const { px, py } = result.pointValue;
    return `= \\left(${_numToLatex(px, sigFigs)},\\, ${_numToLatex(py, sigFigs)}\\right)`;
  }
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
  if (ast.type === 'point') {
    const lx = buildAstText(ast.args[0], sigFigs), ly = buildAstText(ast.args[1], sigFigs);
    return (lx !== null && ly !== null) ? `(${lx}, ${ly})` : null;
  }
  if (ast.type === 'member') {
    const s = buildAstText(ast.arg, sigFigs);
    return s !== null ? `${s}.${ast.field}` : null;
  }
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
  if (ast.type === 'point') return span('(', rec(ast.args[0]), ', ', rec(ast.args[1]), ')');
  if (ast.type === 'member') return span(rec(ast.arg), `.${ast.field}`);
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


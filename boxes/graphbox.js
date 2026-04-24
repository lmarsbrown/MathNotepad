class GraphBox extends Box{
    constructor(id, data={}){
        super("graph",id);
        this.width = data.width || 600;
        this.height = data.height || 400;
        this.lightTheme = !!data.lightTheme;
        this.expressions = data.expressions || [
            { id: 'ge' + (graphExprNextId++), latex: '', color: nextGraphColor(), enabled: true, thickness: 2.0 },
        ];
        // Calc-mode settings (mirror CalcBox flags so graph boxes support full evaluation)
        this.physicsBasic = !!data.physicsBasic;
        this.physicsEM    = !!data.physicsEM;
        this.physicsChem  = !!data.physicsChem;
        this.useUnits     = !!data.useUnits;
        this.useSymbolic  = !!data.useSymbolic;
        this.useBaseUnits = !!data.useBaseUnits;
        this.sigFigs      = data.sigFigs ?? 6;
        this.element = this.createElement();
    }
    createElement(){
        let div = super.createElement();

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
        wInput.value = this.width || 600;
        wInput.className = 'graph-size-input';
        wInput.addEventListener('mousedown', e => e.stopPropagation());
        wInput.addEventListener('change', () => {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx !== -1) { boxes[idx].width = parseInt(wInput.value) || 600; syncToText(); }
        });
        wLabel.appendChild(wInput);
        controls.appendChild(wLabel);

        const hLabel = document.createElement('label');
        hLabel.textContent = ' H ';
        const hInput = document.createElement('input');
        hInput.type = 'number'; hInput.min = '100'; hInput.max = '2000'; hInput.step = '10';
        hInput.value = this.height || 400;
        hInput.className = 'graph-size-input';
        hInput.addEventListener('mousedown', e => e.stopPropagation());
        hInput.addEventListener('change', () => {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx !== -1) {
             boxes[idx].height = parseInt(hInput.value) || 400; syncToText(); }
        });
        hLabel.appendChild(hInput);
        controls.appendChild(hLabel);

        const countSpan = document.createElement('span');
        countSpan.className = 'graph-expr-count';
        const n = (this.expressions || []).length;
        countSpan.textContent = `${n} expression${n !== 1 ? 's' : ''}`;
        controls.appendChild(countSpan);

        const themeLabel = document.createElement('label');
        themeLabel.className = 'graph-theme-label';
        const themeCheck = document.createElement('input');
        themeCheck.type = 'checkbox';
        themeCheck.checked = !!this.lightTheme;
        themeCheck.addEventListener('mousedown', e => e.stopPropagation());
        themeCheck.addEventListener('change', () => {
        const idx = boxes.findIndex(b => b.id === this.id);
        if (idx !== -1) { boxes[idx].lightTheme = themeCheck.checked; syncToText(); }
        });
        themeLabel.appendChild(themeCheck);
        themeLabel.appendChild(document.createTextNode(' Light'));
        controls.appendChild(themeLabel);

        const editBtn = document.createElement('button');
        editBtn.className = 'graph-edit-btn';
        editBtn.textContent = 'Edit Graph';
        editBtn.addEventListener('mousedown', e => e.preventDefault());
        editBtn.addEventListener('click', () => enterGraphMode(this.id));
        controls.appendChild(editBtn);

        div.appendChild(controls);

        // Show snapshot thumbnail if available
        if (this._snapshotDataUrl) {
            const thumb = document.createElement('img');
            thumb.src = this._snapshotDataUrl;
            thumb.className = 'graph-snapshot-thumb';
            thumb.style.maxWidth = '100%';
            thumb.style.borderRadius = '4px';
            thumb.style.marginTop = '4px';
            div.appendChild(thumb);
        }

        div.appendChild(this._createDeleteButton());
        return div;
    }
}

class ImageBox extends Box{
    constructor(id, data={}){
        super("image",id);
        this.mode     = data.mode     || "url";
        this.locked   = !!data.locked;
        this.src      = data.src      || "";
        this.filename = data.filename || "";
        this.alt      = data.alt      || "";
        this.width    = data.width    || 0;
        this.height   = data.height   || 0;
        this.fit      = data.fit      || "locked";
        this.align    = data.align    || "left";
        this.element  = this.createElement();
    }

    /**
     * Applies flexbox alignment to the image body based on this.align.
     */
    _applyBodyAlign() {
        const body = this.element.querySelector('.image-body');
        if (!body) return;
        const a = this.align || 'left';
        body.style.display       = 'flex';
        body.style.flexDirection = 'column';
        body.style.alignItems    = a === 'center' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start';
    }

    /**
     * Applies width/height/fit styles to an img element based on this.width/height/fit.
     * @param {HTMLImageElement} img
     */
    _applyImageSize(img) {
        const w = this.width  || 0;
        const h = this.height || 0;
        if (!w && !h) {
            img.style.width     = '';
            img.style.height    = '';
            img.style.objectFit = '';
        } else {
            img.style.width     = w ? `${w}px` : 'auto';
            img.style.height    = h ? `${h}px` : 'auto';
            img.style.objectFit = this.fit === 'crop' ? 'cover' : 'fill';
        }
    }

    /**
     * Builds the size-row (W × H inputs) for the image body.
     * @param {HTMLImageElement} img - The image element to size.
     * @returns {HTMLElement}
     */
    _makeSizeRow(img) {
        const row = document.createElement('div');
        row.className = 'image-size-row';

        const makeDimInput = (labelText, isW) => {
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
            inp.value = (isW ? this.width : this.height) || '';
            wrap.appendChild(lbl);
            wrap.appendChild(inp);
            row.appendChild(wrap);
            return inp;
        };

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
                if (isW) this.width = v; else this.height = v;
                if (this.fit === 'locked' && v && img.naturalWidth && img.naturalHeight) {
                const other = isW
                    ? Math.round(v * img.naturalHeight / img.naturalWidth)
                    : Math.round(v * img.naturalWidth  / img.naturalHeight);
                if (isW) { this.height = other; hInp.value = other || ''; }
                else     { this.width  = other; wInp.value = other || ''; }
                }
                syncToText();
            };
            inp.addEventListener('change', commit);
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
        });

        return row;
    }

    /**
     * Renders the body of the image box (URL input, file dropzone, or image display).
     * Queries '.image-mode-btn' elements from this.element for locked-state updates.
     */
    _renderBody() {
        const body = this.element.querySelector('.image-body');
        if (!body) return;
        const urlBtn  = this.element.querySelector('.image-mode-btn[data-mode="url"]');
        const fileBtn = this.element.querySelector('.image-mode-btn[data-mode="file"]');
        body.innerHTML = '';
        this._applyBodyAlign();

        if (this.mode === 'url') {
            // Always show the URL input; image appears below it when src is set
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'image-url-input';
            input.placeholder = 'Paste image URL…';
            input.value = this.src || '';

            const commit = () => {
                const val = input.value.trim();
                const changed = val !== this.src;
                this.src = val;
                const shouldLock = !!val;
                if (shouldLock !== this.locked) {
                this.locked = shouldLock;
                if (urlBtn)  urlBtn.classList.toggle('locked-btn', shouldLock);
                if (fileBtn) fileBtn.classList.toggle('locked-btn', shouldLock);
                }
                if (changed) {
                this._renderBody();
                syncToText();
                }
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
            input.style.alignSelf = 'stretch';
            body.appendChild(input);

            if (this.src) {
                const img = document.createElement('img');
                img.className = 'image-preview-img';
                img.alt = this.alt || '';
                img.src = this.src;
                img.style.marginTop = '6px';
                body.appendChild(img);
                body.appendChild(this._makeSizeRow(img));
            }
        } else if (this.locked && this.src) {
            // File mode — image is uploaded, show it with X button
            const display = document.createElement('div');
            display.className = 'image-display';

            const img = document.createElement('img');
            img.className = 'image-preview-img';
            img.alt = this.alt || '';
            display.appendChild(img);

            const clearBtn = document.createElement('button');
            clearBtn.className = 'image-clear-btn';
            clearBtn.title = 'Clear image';
            clearBtn.textContent = '×';
            clearBtn.addEventListener('click', async () => {
                await idbDeleteImage(this.src).catch(() => {});
                cleanupImageBox(this.id);
                this.src = ''; this.filename = ''; this.locked = false;
                if (urlBtn)  urlBtn.classList.remove('locked-btn');
                if (fileBtn) fileBtn.classList.remove('locked-btn');
                this._renderBody();
                syncToText();
            });
            display.appendChild(clearBtn);
            body.appendChild(display);
            body.appendChild(this._makeSizeRow(img));

            // Load from IDB or disk
            const existing = imageObjectUrls.get(this.id);
            if (existing) {
                img.src = existing;
            } else {
                loadImageAsObjectURL(this).then(objUrl => {
                if (objUrl) {
                    imageObjectUrls.set(this.id, objUrl);
                    img.src = objUrl;
                } else {
                    display.remove();
                    const missing = document.createElement('div');
                    missing.className = 'image-missing';
                    const allProjs = loadProjects();
                    const proj = (currentProjectId ? allProjs.find(p => p.id === currentProjectId) : null)
                            || allProjs.find(p => p.onDisk && p.assetFolder && this.src?.startsWith(p.assetFolder + '/'));
                    const isDiskBacked = !!(proj?.onDisk && proj.assetFolder && this.src?.startsWith(proj.assetFolder + '/'));
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
                if (file) this._handleFileUpload(file);
            });
            fileInput.addEventListener('change', () => {
                const file = fileInput.files?.[0];
                if (file) this._handleFileUpload(file);
            });

            body.appendChild(dropzone);
        }
    }

    /**
     * Handles file upload for file-mode image boxes.
     * Saves to workspace (if on-disk project) or IndexedDB, then re-renders.
     * @param {File} file - The uploaded file.
     */
    async _handleFileUpload(file) {
        cleanupImageBox(this.id);
        const objUrl = URL.createObjectURL(file);
        imageObjectUrls.set(this.id, objUrl);
        this.filename = file.name;
        this.locked   = true;
        const urlBtn  = this.element.querySelector('.image-mode-btn[data-mode="url"]');
        const fileBtn = this.element.querySelector('.image-mode-btn[data-mode="file"]');
        if (urlBtn)  urlBtn.classList.add('locked-btn');
        if (fileBtn) fileBtn.classList.add('locked-btn');

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
            this.src = `${proj.assetFolder}/${file.name}`;
            // Also save to IDB as fallback for when workspace permission isn't restored on reload
            const buf = await file.arrayBuffer();
            await idbSaveImage(currentProjectId, file.name, file.type, buf);
        } else {
            // Save to IndexedDB
            const projId = currentProjectId || 'draft';
            const buf = await file.arrayBuffer();
            await idbSaveImage(projId, file.name, file.type, buf);
            this.src = `${projId}/${file.name}`;
        }

        this._renderBody();
        syncToText();
    }

    createElement(){
        let div = super.createElement();
        div.classList.add('box-image');

        //---------Create Toolbar----------
        const toolbar = document.createElement('div');
        toolbar.className = 'image-toolbar';

        const label = document.createElement('span');
        label.className = 'box-type-label';
        label.textContent = 'IMAGE';
        toolbar.appendChild(label);

        const modeToggle = document.createElement('div');
        modeToggle.className = 'image-mode-toggle';

        const urlBtn  = document.createElement('button');
        urlBtn.className  = 'image-mode-btn' + (this.mode === 'url'  ? ' active' : '') + (this.locked ? ' locked-btn' : '');
        urlBtn.dataset.mode = 'url';
        urlBtn.textContent = 'URL';

        const fileBtn = document.createElement('button');
        fileBtn.className = 'image-mode-btn' + (this.mode === 'file' ? ' active' : '') + (this.locked ? ' locked-btn' : '');
        fileBtn.dataset.mode = 'file';
        fileBtn.textContent = 'File';

        modeToggle.appendChild(urlBtn);
        modeToggle.appendChild(fileBtn);
        toolbar.appendChild(modeToggle);
        

        //Align Button
        const FIT_CYCLE = ['locked', 'crop', 'scale'];
        const FIT_LABELS = { locked: '⇔ Lock', crop: '✂ Crop', scale: '⤢ Scale' };
        const fitBtn = document.createElement('button');
        fitBtn.className = 'image-fit-btn';
        fitBtn.title = 'Cycle aspect ratio mode: locked → crop → scale';
        fitBtn.textContent = FIT_LABELS[this.fit] || FIT_LABELS.locked;
        fitBtn.addEventListener('click', () => {
            const idx = FIT_CYCLE.indexOf(this.fit);
            this.fit = FIT_CYCLE[(idx + 1) % FIT_CYCLE.length];
            fitBtn.textContent = FIT_LABELS[this.fit];
            fitBtn.dataset.fit = this.fit;
            this._renderBody();
            syncToText();
        });
        fitBtn.dataset.fit = this.fit || 'locked';
        toolbar.appendChild(fitBtn);

        //Align button
        const ALIGN_CYCLE = ['left', 'center', 'right'];
        const ALIGN_LABELS = { left: '⬛ Left', center: '▣ Center', right: '⬛ Right' };
        const ALIGN_ICONS  = { left: '⇤', center: '↔', right: '⇥' };
        const alignBtn = document.createElement('button');
        alignBtn.className = 'image-fit-btn';
        alignBtn.title = 'Cycle image alignment: left → center → right';
        alignBtn.textContent = ALIGN_ICONS[this.align || 'left'] + ' ' + (this.align || 'left').charAt(0).toUpperCase() + (this.align || 'left').slice(1);
        alignBtn.dataset.align = this.align || 'left';
        alignBtn.addEventListener('click', () => {
            const idx = ALIGN_CYCLE.indexOf(this.align || 'left');
            this.align = ALIGN_CYCLE[(idx + 1) % ALIGN_CYCLE.length];
            alignBtn.textContent = ALIGN_ICONS[this.align] + ' ' + this.align.charAt(0).toUpperCase() + this.align.slice(1);
            alignBtn.dataset.align = this.align;
            this._applyBodyAlign();
            syncToText();
        });
        toolbar.appendChild(alignBtn);
        div.appendChild(toolbar);

        // ── Body ──
        const body = document.createElement('div');
        body.className = 'image-body';
        div.appendChild(body);

        // Mode toggle
        [urlBtn, fileBtn].forEach(btn => {
            btn.addEventListener('click', () => {
            if (this.locked) return;
            this.mode = btn.dataset.mode;
            this.src = '';
            urlBtn.classList.toggle('active', this.mode === 'url');
            fileBtn.classList.toggle('active', this.mode === 'file');
            this._renderBody();
            syncToText();
            });
        });

        // Temporarily assign this.element so _renderBody can query it.
        // The constructor will overwrite it with the same div after return.
        this.element = div;
        this._renderBody();

        div.appendChild(this._createDeleteButton());
        return div;
    }
}
// ── Image box DOM ─────────────────────────────────────────────────────────────

function cleanupImageBox(boxId) {
  const url = imageObjectUrls.get(boxId);
  if (url) { URL.revokeObjectURL(url); imageObjectUrls.delete(boxId); }
}

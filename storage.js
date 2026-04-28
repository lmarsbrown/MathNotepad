
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
  // Clear before parseFromLatex so new fields registered during construction are retained.
  // Clearing after would wipe them, making the post-DOM re-apply loop unable to find them.
  mqFields.clear(); boxResizers.clear();
  boxes = parseFromLatex(latex);
  rebuildBoxList();
  // Re-apply latex for math boxes now that elements are in the DOM.
  // Setting field.latex() before DOM insertion can mis-render expressions like (x^2),
  // causing the closing paren to appear inside the exponent.
  for (const box of boxes) {
    if (box.type === 'math' && box.content) {
      const field = mqFields.get(box.id);
      if (field) field.latex(box.content);
    }
  }
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
      return;
    }
    // Project ID was set but project not found — reset to unsaved state and fall through
    console.warn('saveCurrentProject: currentProjectId', currentProjectId, 'not found in projects list. Resetting to unsaved state.');
    currentProjectId = null;
    projectTitleLabel.textContent = 'Untitled';
  }
  // No project ID or stale ID cleared above — prompt to create new project
  {
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

/**
 * Debug function to inspect storage state. Call from browser console: debugStorageState()
 * Returns object with all relevant state for diagnosing project persistence issues.
 */
function debugStorageState() {
  const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  const projects = loadProjects();
  const matchingProject = draft?.projectId ? projects.find(p => p.id === draft.projectId) : null;

  const state = {
    currentProjectId,
    displayedTitle: projectTitleLabel.textContent,
    isDirty,
    draft: draft ? {
      projectId: draft.projectId,
      latexLength: draft.latex?.length ?? 0,
      latexPreview: draft.latex?.slice(0, 100) ?? null,
    } : null,
    projectsCount: projects.length,
    projects: projects.map(p => ({ id: p.id, title: p.title, onDisk: !!p.onDisk })),
    draftProjectFound: !!matchingProject,
    matchingProjectTitle: matchingProject?.title ?? null,
    workspaceConnected: !!currentWorkspaceHandle,
    workspaceName: localStorage.getItem(WORKSPACE_NAME_KEY),
  };

  console.log('=== Storage Debug State ===');
  console.log('currentProjectId:', currentProjectId);
  console.log('displayedTitle:', state.displayedTitle);
  console.log('isDirty:', isDirty);
  console.log('draft.projectId:', draft?.projectId);
  console.log('draft.latexLength:', state.draft?.latexLength);
  console.log('draftProjectFound:', state.draftProjectFound);
  if (!state.draftProjectFound && draft?.projectId) {
    console.warn('WARNING: draft.projectId does not match any saved project!');
  }
  console.log('projects:', state.projects);
  console.log('Full state object:', state);

  return state;
}
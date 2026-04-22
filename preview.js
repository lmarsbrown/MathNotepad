'use strict';

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
/**
 * Splits a string by a single-character separator, ignoring separators inside
 * parentheses or braces (depth > 0). Handles nested parens in matrix entries.
 * @param {string} str
 * @param {string} sep - single character
 * @returns {string[]}
 */
function splitDepth0(str, sep) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (depth === 0 && c === sep) { parts.push(str.slice(start, i)); start = i + 1; }
  }
  parts.push(str.slice(start));
  return parts;
}

/**
 * Converts the interior of a mat() call to a LaTeX pmatrix string.
 * Rows are separated by ';', columns by ',' in the input.
 * Splits respect nested parentheses so entries like (a) or f(x,y) work correctly.
 * @param {string} inner - content between the parens, e.g. "1,0;0,1"
 * @returns {string} LaTeX \begin{pmatrix}...\end{pmatrix} string
 */
function matToLatex(inner) {
  const rows = splitDepth0(inner, ';').map(row =>
    splitDepth0(row, ',').map(cell => cell.trim()).join(' & ')
  );
  return `\\begin{pmatrix}${rows.join(' \\\\ ')}\\end{pmatrix}`;
}

/**
 * Replaces mat(...) notation with LaTeX pmatrix in a LaTeX string.
 * All three forms use balanced-paren scanning so nested parens in entries work:
 *   - \operatorname{mat}\left(...\right)  (MathQuill with autoOperatorNames)
 *   - mat\left(...\right)                 (MathQuill without autoOperatorNames)
 *   - mat(...)                            (source editor)
 * @param {string} latex
 * @returns {string}
 */
function matrixSub(latex) {
  let result = '';
  let i = 0;
  while (i < latex.length) {
    // Determine which prefix (if any) starts at position i
    let afterOpen, closeLen;
    if (latex.startsWith('\\operatorname{mat}\\left(', i)) {
      afterOpen = i + 24; closeLen = 7; // '\right)' length
    } else if (latex.startsWith('mat\\left(', i)) {
      afterOpen = i + 9; closeLen = 7;
    } else if (latex.startsWith('mat(', i)) {
      afterOpen = i + 4; closeLen = 1; // ')' length
    } else {
      result += latex[i++]; continue;
    }

    // Find the matching close, counting nested \left( / \right) or ( / )
    let depth = 1, j = afterOpen;
    if (closeLen === 7) {
      // \left( ... \right) scanning
      while (j < latex.length && depth > 0) {
        if (latex.startsWith('\\left(', j))  { depth++; j += 6; }
        else if (latex.startsWith('\\right)', j)) { depth--; if (depth > 0) j += 7; }
        else j++;
      }
    } else {
      // plain ( ... ) scanning
      while (j < latex.length && depth > 0) {
        if (latex[j] === '(') depth++;
        else if (latex[j] === ')') depth--;
        if (depth > 0) j++;
      }
    }

    if (depth === 0) {
      result += matToLatex(latex.slice(afterOpen, j));
      i = j + closeLen;
    } else {
      // Unbalanced — emit the prefix literally and keep scanning
      result += latex.slice(i, afterOpen);
      i = afterOpen;
    }
  }
  return result;
}

function applyBBSubs(latex) {
  let out = latex;
  out = out.replace(/<=/g, '\\leq ');
  out = out.replace(/>=/g, '\\geq ');
  out = out.replace(/->/g, '\\rightarrow ');
  out = out.replace(/<-/g, '\\leftarrow ');
  out = out.replace(/!=/g, '\\neq ');
  for (const [key, val] of Object.entries(BB_SUBS)) out = out.replaceAll(key, val);
  out = matrixSub(out);
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

function schedulePreview(delay = PREVIEW_DEBOUNCE_MS) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => updatePreview(), delay);
}

let previewRunning = false;
let previewPending = false;

// Build the inner preview DOM element for a single box with raw (un-typeset)
// content. Graph and pagebreak boxes never go through MathJax; math/text/heading
// boxes will be passed to typesetPromise after this returns.
function createPreviewElement(box) {
  if (box.type === 'math') {
    const div = document.createElement('div');
    div.className = 'preview-math';
    div.dataset.boxId = box.id;
    // Use textContent so the backslashes are literal characters in the text node,
    // which is what MathJax's input scanner expects to find.
    div.textContent = `\\[${applyBBSubs(box.content)}\\]`;
    return div;
  }
  if (box.type === 'h1' || box.type === 'h2' || box.type === 'h3') {
    const el = document.createElement(box.type);
    el.className = `preview-${box.type}`;
    el.dataset.boxId = box.id;
    el.innerHTML = processTextContent(box.content);
    return el;
  }
  if (box.type === 'pagebreak') {
    const div = document.createElement('div');
    div.className = 'preview-pagebreak';
    div.dataset.boxId = box.id;
    return div;
  }
  if (box.type === 'calc') {
    const wrapper = document.createElement('div');
    wrapper.className = 'preview-calc-box';
    wrapper.dataset.boxId = box.id;
    // Hidden calc boxes contribute nothing to the preview
    if (box.hidden) return wrapper;
    const results = evaluateCalcExpressions(box.expressions || [], { usePhysicsBasic: !!box.physicsBasic, usePhysicsEM: !!box.physicsEM, usePhysicsChem: !!box.physicsChem, useUnits: !!box.useUnits, useSymbolic: !!box.useSymbolic, useBaseUnits: !!box.useBaseUnits });
    for (const expr of (box.expressions || [])) {
      if (!expr.enabled) continue;
      const latex = (expr.latex || '').trim();
      if (!latex) continue;
      const result = results.get(expr.id);
      const div = document.createElement('div');
      div.className = 'preview-math';
      // In units mode, wrap unit names in \text{} for upright rendering.
      // Substitutes directly in the original LaTeX to avoid altering structure.
      let displayLatex = latex;
      if (box.useUnits) {
        const op = findCalcOperatorAtDepth0(latex);
        if (op) {
          const lhs = latex.slice(0, op.idx).trim();
          const rhs = latex.slice(op.idx + op.len).trim();
          displayLatex = `${lhs} = ${_wrapUnitsInText(rhs)}`;
        } else {
          displayLatex = _wrapUnitsInText(latex);
        }
      }
      // Determine whether to show the result
      let showResult = false;
      let resultLatex = null;
      if (result && !result.error && result.boolValue === undefined) {
        const kind = classifyCalcExpr(latex);
        const shouldShow = kind === 'def'
          ? (() => { const op = findCalcOperatorAtDepth0(latex); const rhs = op ? latex.slice(op.idx + op.len).trim() : ''; return !isNumericLiteralLatex(rhs) && box.showResultsDefs !== false; })()
          : (kind === 'bare' && box.showResultsBare !== false);
        if (shouldShow) {
          if (result.unitAst !== undefined) {
            resultLatex = astToLatex(result.unitAst, box.sigFigs ?? 6);
            showResult = true;
          } else {
            const formatted = formatCalcResultLatex(result, box.sigFigs ?? 6);
            if (formatted !== null) { resultLatex = formatted; showResult = true; }
          }
        }
      }
      let previewLatex;
      if (showResult && result && result.unitAst !== undefined) {
        previewLatex = `\\[${displayLatex} = ${resultLatex}\\]`;
      } else if (showResult) {
        previewLatex = `\\[${displayLatex} ${resultLatex}\\]`;
      } else {
        previewLatex = `\\[${displayLatex}\\]`;
      }
      div.textContent = previewLatex;
      wrapper.appendChild(div);
    }
    return wrapper;
  }
  if (box.type === 'image') {
    const wrapper = document.createElement('div');
    wrapper.className = 'preview-image-box';
    wrapper.dataset.boxId = box.id;
    if (!box.src) return wrapper;
    const a = box.align || 'left';
    wrapper.style.display = 'flex';
    wrapper.style.justifyContent = a === 'center' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start';

    function applyPreviewSize(img) {
      const w = box.width || 0, h = box.height || 0;
      if (w || h) {
        img.style.width  = w ? `${w}px` : 'auto';
        img.style.height = h ? `${h}px` : 'auto';
        img.style.objectFit = box.fit === 'crop' ? 'cover' : 'fill';
      }
    }
    if (box.mode === 'url') {
      const img = document.createElement('img');
      img.src = box.src;
      img.alt = box.alt || '';
      applyPreviewSize(img);
      wrapper.appendChild(img);
    } else {
      // File mode: async IDB load
      const placeholder = document.createElement('div');
      placeholder.className = 'preview-image-placeholder';
      placeholder.textContent = 'Loading image…';
      wrapper.appendChild(placeholder);
      loadImageAsObjectURL(box).then(objUrl => {
        if (objUrl) {
          placeholder.remove();
          const img = document.createElement('img');
          img.src = objUrl;
          img.alt = box.alt || '';
          applyPreviewSize(img);
          wrapper.appendChild(img);
        } else {
          placeholder.textContent = 'Image file not found';
        }
      }).catch(() => { placeholder.textContent = 'Image file not found'; });
    }
    return wrapper;
  }
  if (box.type === 'graph') {
    const div = document.createElement('div');
    div.dataset.boxId = box.id;
    if (box._snapshotDataUrl) {
      div.className = 'preview-graph-image';
      div.style.cssText = 'text-align:center;margin:8px 0';
      const img = document.createElement('img');
      img.src = box._snapshotDataUrl;
      img.style.cssText = `max-width:100%;width:${box.width || 600}px;height:auto;border-radius:4px`;
      div.appendChild(img);
    } else {
      const n = (box.expressions || []).filter(e => e.enabled).length;
      div.className = 'preview-graph-placeholder';
      div.style.cssText = `width:${box.width || 600}px;height:${box.height || 400}px`;
      const span = document.createElement('span');
      span.textContent = `${n} expression${n !== 1 ? 's' : ''}`;
      div.appendChild(span);
    }
    return div;
  }
  // text box (default)
  const p = document.createElement('p');
  p.className = 'preview-text';
  p.dataset.boxId = box.id;
  p.innerHTML = processTextContent(box.content);
  return p;
}

async function updatePreview() {
  if (!isPreviewOpen) return;
  if (graphModeBoxId) return; // preview panel is used for graph canvas in graph mode
  if (previewRunning) { previewPending = true; return; }
  previewRunning = true;
  previewPending = false;

  // Build a new page div from cached + fresh elements. Graph and pagebreak boxes
  // are always recreated (no MathJax cost). Math/text/heading elements are reused
  // from cache when their content hasn't changed, so typesetPromise only runs on
  // the subset that actually changed.
  const pageDiv = document.createElement('div');
  pageDiv.className = 'preview-page';

  const toTypeset = []; // elements that need MathJax this cycle
  const activeIds = new Set();


  
  const innerEls = [];
  
  for (const box of boxes) {
    if (box.commented) continue;
    activeIds.add(box.id);

    // Cache key encodes everything that affects the rendered output.
    // Graph boxes always bypass the cache (snapshot url changes independently).
    const needsCache = box.type !== 'graph' && box.type !== 'pagebreak' && box.type !== 'image';
    const cacheKey = box.type === 'calc'
      ? `calc|${box.showResultsDefs !== false ? '1' : '0'}|${box.showResultsBare !== false ? '1' : '0'}|${box.physicsBasic ? '1' : '0'}|${box.physicsEM ? '1' : '0'}|${box.physicsChem ? '1' : '0'}|sf${box.sigFigs ?? 6}|h${box.hidden ? '1' : '0'}|${(box.expressions || []).map(e => `${e.id}:${e.enabled ? '1' : '0'}:${e.latex}`).join('|')}`
      : `${box.type}|${box.content}`;
    const cached = needsCache ? previewBoxCache.get(box.id) : null;

    let innerEl;
    if (cached && cached.key === cacheKey) {
      innerEl = cached.el; // reuse the already-typeset DOM node
    } else {
      // Content changed — discard the old rendered element and tell MathJax to
      // release its internal state for it, preventing unbounded list growth.
      if (cached) window.MathJax?.typesetClear?.([cached.el]);
      innerEl = createPreviewElement(box);
      if (needsCache) {
        previewBoxCache.set(box.id, { key: cacheKey, el: innerEl });
        toTypeset.push(innerEl);
      }
    }
    innerEls.push([innerEl,box]);
  }
  let cachedMissed = !metricsCache;

  //If there are no cached metrics add the divs to the DOM before running mathjax on them so that the metrics can be cached.
  if(cachedMissed){
    for(let innerEl of innerEls){
      if (innerEl[1].highlighted) {
        const wrap = document.createElement('div');
        wrap.className = 'preview-highlight-box';
        if (innerEl[1].fillColor) wrap.style.background = innerEl[1].fillColor;
        wrap.appendChild(innerEl[0]);
        pageDiv.appendChild(wrap);
      } else {
        pageDiv.appendChild(innerEl[0]);
      }
    }
  }
  

  // Evict cache entries for boxes that no longer exist, and release their
  // MathJax state so the internal MathDocument list doesn't grow unboundedly.
  // Without this, Firefox degrades severely after many create/delete cycles.
  for (const [id, entry] of previewBoxCache) {
    if (!activeIds.has(id)) {
      window.MathJax?.typesetClear?.([entry.el]);
      previewBoxCache.delete(id);
    }
  }

  // Swap in the new page. Cached elements are already in pageDiv so they
  // survive the innerHTML clear as detached (but still JS-referenced) nodes.
  previewContent.innerHTML = '';
  previewContent.appendChild(pageDiv);

  if (toTypeset.length > 0 && window.MathJax?.typesetPromise) {
    await MathJax.typesetPromise(toTypeset);
    // Eliminate SVG stroke rendering that causes artefacts in printed PDFs.
    // Must set stroke="none" on every element individually — PDF renderers don't
    // reliably cascade SVG attributes, and child stroke-width="0" can reintroduce strokes.
    for (const el of toTypeset) {
      el.querySelectorAll('svg, svg *').forEach(e => e.setAttribute('stroke', 'none'));
    }
  }

  //If there are cached metrics add the divs after mathjax has rendered to avoid reflowing the entire page
  if(!cachedMissed){
    for(let innerEl of innerEls){
      if (innerEl[1].highlighted) {
        const wrap = document.createElement('div');
        wrap.className = 'preview-highlight-box';
        if (innerEl[1].fillColor) wrap.style.background = innerEl[1].fillColor;
        wrap.appendChild(innerEl[0]);
        pageDiv.appendChild(wrap);
      } else {
        pageDiv.appendChild(innerEl[0]);
      }
    }
  }

  paginatePreview();  // split content across separate page divs
  applyPreviewZoom(); // apply after MathJax renders so it measures at natural size

  previewContent.scrollTop = previewScrollTop;
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

previewContent.addEventListener('scroll', () => { previewScrollTop = previewContent.scrollTop; }, { passive: true });

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

function scrollAndHighlightPreview(boxId) {
  // Find the element in the preview that corresponds to this box.
  // It may be wrapped in a .preview-highlight-box, so walk up one level.
  let el = previewContent.querySelector(`[data-box-id="${boxId}"]`);
  if (!el) return;
  const target = el.parentElement?.classList.contains('preview-highlight-box') ? el.parentElement : el;
  // Scroll target into the center of the preview panel
  const contentRect = previewContent.getBoundingClientRect();
  const targetRect  = target.getBoundingClientRect();
  const offset = targetRect.top - contentRect.top - (contentRect.height / 2) + (targetRect.height / 2);
  previewContent.scrollBy({ top: offset, behavior: 'smooth' });
  // Blink animation
  target.classList.remove('preview-blink');
  void target.offsetWidth; // force reflow to restart animation
  target.classList.add('preview-blink');
  target.addEventListener('animationend', () => target.classList.remove('preview-blink'), { once: true });
}

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
  togglePreviewBtn.textContent = isPreviewOpen ? 'Hide Preview' : 'Preview';
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
  toggleSourceBtn.textContent = isSourceOpen ? 'Hide Source' : 'Source';
  saveUiState();
}

toggleSourceBtn.addEventListener('click', toggleSource);

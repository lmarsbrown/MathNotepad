'use strict';

// ── GraphRenderer ────────────────────────────────────────────────────────────
//
// Renders implicit curves on a WebGL2 canvas using a two-pass approach:
//   Pass 1 (per graph): Find zero crossings of F(x,y) via subpixel binary search.
//           Each graph is drawn into the same buffer sequentially.
//           Pixel format: vec4(subpixelX, subpixelY, graphId, 1.0) when a
//           crossing exists; previous buffer content is preserved otherwise.
//   Pass 2 (single): Expand thin lines using a circular kernel with subpixel
//           anti-aliasing.  The graphId is used to look up the color from a
//           uniform array.

class GraphRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'graph-canvas';
    this.gl = this.canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!this.gl) throw new Error('WebGL2 not supported');
    if (!this.gl.getExtension('EXT_color_buffer_float'))
      throw new Error('EXT_color_buffer_float not supported');

    this._khrParallelShader = this.gl.getExtension('KHR_parallel_shader_compile');
    this.image = null;        // GPUImage for ping-pong rendering
    this.thinLineShaders = new Map();  // glsl expr string → { program, uniforms }
    this._pendingShaders = new Map();  // glsl expr string → { program, vs, fs } | null(failed)
    this._pollHandle = null;
    this.thickenProgram = null;
    this.vao = null;
    this.width = 0;
    this.height = 0;

    // View bounds (world coordinates)
    this.xMin = -5; this.xMax = 5;
    this.yMin = -5; this.yMax = 5;

    // Panning state
    this._dragging = false;
    this._pendingDrag = false;  // mousedown received but threshold not yet crossed
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragStartXMin = 0;
    this._dragStartXMax = 0;
    this._dragStartYMin = 0;
    this._dragStartYMax = 0;
    this._onRender = null; // callback to re-render on pan/zoom
    this._onPick = null;   // callback(exprId) when user clicks a curve

    // Maps graphId (index in active[]) → expr.exprId, updated each render
    this._lastActiveExprIds = [];

    // Snap-to-curve state
    this._holding      = false;
    this._snapExprId   = null;   // exprId of the focused expression, or null
    this._snapPoint    = null;   // { wx, wy } in world coords, or null
    this._onSnapUpdate       = null;   // callback(snapPoint, canvasX, canvasY) | null
    this._onBackgroundClick  = null;   // callback() when background (no curve) is clicked
    this._mousedownHitCurve  = false;
    this._snapF              = null;   // JS evaluator for the last successfully snapped curve
    this._lastActive   = [];     // active expressions from last render()
    this._effYMin      = 0;
    this._effYMax      = 0;
    this._jsEvaluators = new Map(); // glslExpr → Function(x,y) | null (legacy only)

    // Compiled expression cache — populated by updateExpressions()
    this._compiledExprs  = [];          // Array<{ exprId, shaderInfo, jsEval, color, thickness, enabled }>
    this._constantValues = new Map();   // analysis.constantValues shared across all exprs
    this._compiledErrors = new Map();   // exprId → error string
    this._compiledKey    = '';          // LaTeX-based change-detection key
    this._lastShaderKey  = '';          // shader-key string; drives clearShaderCache()

    this._initThickenShader();
    this._setupInteraction();
  }

  /**
   * Update the compiled expression cache from raw box expressions.
   * Runs compileGraphExpressions() only when LaTeX/enabled state changes;
   * otherwise just patches color/thickness on the existing cache entries.
   *
   * @param {Array<{id, latex, color, thickness, enabled}>} boxExpressions
   * @returns {Map<string, string>} errors — exprId → error message
   */
  updateExpressions(boxExpressions) {
    const latexKey = boxExpressions
      .map(e => `${e.id}:${e.latex}:${e.enabled ? '1' : '0'}`)
      .join('|');

    if (latexKey !== this._compiledKey) {
      // Expressions changed — full recompile
      const { analysis, renderExprs, jsEvaluators } = compileGraphExpressions(boxExpressions);

      this._compiledExprs = renderExprs.map(re => ({
        exprId:     re.exprId,
        shaderInfo: re.shaderInfo,
        jsEval:     jsEvaluators.get(re.exprId) || null,
        color:      re.color,
        thickness:  re.thickness,
        enabled:    re.enabled,
      }));
      this._constantValues = analysis.constantValues;
      this._compiledErrors = analysis.errors;
      this._lastAnalysis   = analysis; // cached for UI badge updates

      const newShaderKey = this._compiledExprs
        .map(e => e.shaderInfo ? e.shaderInfo.shaderKey : '')
        .join('|');
      if (newShaderKey !== this._lastShaderKey) {
        this.clearShaderCache();
        this._lastShaderKey = newShaderKey;
      }

      this._compiledKey = latexKey;
    } else {
      // Only mutable display properties may have changed — no recompile needed
      for (const src of boxExpressions) {
        const compiled = this._compiledExprs.find(e => e.exprId === src.id);
        if (compiled) {
          compiled.color     = src.color;
          compiled.thickness = src.thickness != null ? src.thickness : 2.0;
        }
      }
    }

    return this._compiledErrors;
  }

  // ── Interaction: pan & zoom ──────────────────────────────────────────────

  _setupInteraction() {
    const c = this.canvas;

    c.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      this._pendingDrag = true;
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
      this._dragStartXMin = this.xMin;
      this._dragStartXMax = this.xMax;
      this._dragStartYMin = this.yMin;
      this._dragStartYMax = this.yMax;
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const px = Math.round((e.clientX - rect.left) * (this.width  / rect.width));
      const py = Math.round((e.clientY - rect.top)  * (this.height / rect.height));
      // Focus the curve immediately on press; begin snap mode if a curve was hit
      const exprId = this.pickAt(px, py);
      this._mousedownHitCurve = exprId !== null;
      if (exprId !== null) {
        if (this._onPick) this._onPick(exprId);
        this._holding    = true;
        this._snapExprId = exprId;
        this._updateSnap(px, py);
      }
    });

    c.addEventListener('click', e => {
      if (!this._mousedownHitCurve && this._onBackgroundClick) this._onBackgroundClick();
    });

    c.addEventListener('mousemove', e => {
      if (this._dragging) return;
      // Update cursor: pointer over a curve, default otherwise
      const rect = c.getBoundingClientRect();
      const px = Math.round((e.clientX - rect.left) * (this.width  / rect.width));
      const py = Math.round((e.clientY - rect.top)  * (this.height / rect.height));
      c.style.cursor = this.pickAt(px, py) !== null ? 'pointer' : '';
      if (this._holding) {
        this._updateSnap(px, py);
        if (this._onRender) this._onRender();
      }
    });

    window.addEventListener('mousemove', e => {
      if (!this._pendingDrag && !this._dragging) return;
      const dx = e.clientX - this._dragStartX;
      const dy = e.clientY - this._dragStartY;
      // Transition from pending → dragging once the cursor moves past threshold,
      // but only if snap mode is not active (snap mode locks out panning)
      if (this._pendingDrag && !this._holding && Math.hypot(dx, dy) > 5) {
        this._pendingDrag = false;
        this._dragging    = true;
        c.style.cursor = 'grabbing';
      }
      if (!this._dragging) return;
      // Use uniform world-per-pixel based on X range (Y is aspect-corrected)
      const worldPerPixel = (this._dragStartXMax - this._dragStartXMin) / this.width;
      this.xMin = this._dragStartXMin - dx * worldPerPixel;
      this.xMax = this._dragStartXMax - dx * worldPerPixel;
      this.yMin = this._dragStartYMin + dy * worldPerPixel;
      this.yMax = this._dragStartYMax + dy * worldPerPixel;
      if (this._onRender) this._onRender();
    });

    window.addEventListener('mouseup', () => {
      this._pendingDrag = false;
      if (this._holding) {
        this._holding    = false;
        this._snapExprId = null;
        this._snapPoint  = null;
        this._snapF      = null;
        if (this._onSnapUpdate) this._onSnapUpdate(null, 0, 0);
        if (this._onRender) this._onRender();
      }
      if (!this._dragging) return;
      this._dragging = false;
      c.style.cursor = '';
    });

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = 1 - (e.clientY - rect.top) / rect.height;
      // Compute effective Y bounds (aspect-corrected) for cursor world position
      const aspect = this.height / this.width;
      const xRange = this.xMax - this.xMin;
      const yCenter = 0.5 * (this.yMin + this.yMax);
      const yHalf = xRange * aspect * 0.5;
      const effYMin = yCenter - yHalf;
      const effYMax = yCenter + yHalf;
      const worldX = this.xMin + mx * (this.xMax - this.xMin);
      const worldY = effYMin + my * (effYMax - effYMin);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      this.xMin = worldX + (this.xMin - worldX) * factor;
      this.xMax = worldX + (this.xMax - worldX) * factor;
      // Scale Y center toward cursor in world space
      const newYCenter = worldY + (yCenter - worldY) * factor;
      const newYHalf = (this.xMax - this.xMin) * aspect * 0.5;
      this.yMin = newYCenter - newYHalf;
      this.yMax = newYCenter + newYHalf;
      if (this._onRender) this._onRender();
    }, { passive: false });
  }

  // ── Pick: find which expression is closest to a canvas pixel ──────────

  /**
   * Sample the thin-line buffer near (canvasX, canvasY) and return the
   * _exprId of the closest curve, or null if none is within `radius` pixels.
   * canvasX/Y are in CSS-pixel space (0,0) = top-left.
   */
  pickAt(canvasX, canvasY, radius = 12) {
    if (!this.image || this._lastActiveExprIds.length === 0) return null;
    const gl = this.gl;

    // WebGL readPixels uses bottom-left origin; flip Y
    const webglY = this.height - 1 - canvasY;

    const x0 = Math.max(0, canvasX - radius);
    const y0 = Math.max(0, webglY   - radius);
    const rw = Math.min(2 * radius + 1, this.width  - x0);
    const rh = Math.min(2 * radius + 1, this.height - y0);
    if (rw <= 0 || rh <= 0) return null;

    const buf = new Float32Array(rw * rh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.image.frontFb);
    gl.readPixels(x0, y0, rw, rh, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Center of the read rectangle in local (buf) coordinates
    const cx = canvasX - x0;
    const cy = webglY  - y0;

    let bestDist = Infinity;
    let bestExprId = null;
    for (let py = 0; py < rh; py++) {
      for (let px = 0; px < rw; px++) {
        const i = (py * rw + px) * 4;
        if (buf[i + 3] === 1.0) {
          const dist = Math.hypot(px - cx, py - cy);
          if (dist < bestDist) {
            bestDist = dist;
            const graphId = Math.round(buf[i + 2]);
            bestExprId = this._lastActiveExprIds[graphId] ?? null;
          }
        }
      }
    }
    return bestExprId;
  }

  // ── Snap-to-curve ─────────────────────────────────────────────────────

  /**
   * Get a JS Function(x, y) evaluator for an expression. Supports both:
   * - New format: expr.jsEval is a pre-built function from the analysis pipeline
   * - Legacy format: expr.glsl is a GLSL string that gets regex-converted to JS
   */
  _getJsEvaluator(expr) {
    if (expr.jsEval) return expr.jsEval;
    if (!expr.glsl) return null;

    if (this._jsEvaluators.has(expr.glsl)) return this._jsEvaluators.get(expr.glsl);
    const js = expr.glsl
      .replace(/\bsqrt\b/g,  'Math.sqrt')
      .replace(/\basin\b/g,  'Math.asin')
      .replace(/\bacos\b/g,  'Math.acos')
      .replace(/\batan\b/g,  'Math.atan')
      .replace(/\bsin\b/g,   'Math.sin')
      .replace(/\bcos\b/g,   'Math.cos')
      .replace(/\btan\b/g,   'Math.tan')
      .replace(/\babs\b/g,   'Math.abs')
      .replace(/\blog\b/g,   'Math.log')
      .replace(/\bexp\b/g,   'Math.exp')
      .replace(/\bpow\b/g,   'Math.pow')
      .replace(/\bfloor\b/g, 'Math.floor')
      .replace(/\bceil\b/g,  'Math.ceil')
      .replace(/\bsign\b/g,  'Math.sign')
      .replace(/\bmod\b/g,   '_mod');
    try {
      const fn = new Function('x', 'y', '_mod', `"use strict"; return (${js});`);
      const _mod = (a, b) => a - b * Math.floor(a / b);
      const bound = (x, y) => fn(x, y, _mod);
      this._jsEvaluators.set(expr.glsl, bound);
      return bound;
    } catch {
      this._jsEvaluators.set(expr.glsl, null);
      return null;
    }
  }

  /**
   * Find the world-space point on any active curve closest to the given canvas
   * pixel (CSS top-left origin). Uses a coarse grid search + bisection.
   * Returns { x, y } in world coords, or null if no curve is in range.
   */
  _findNearestCurvePoint(canvasX, canvasY) {
    if (!this._lastActive.length) return null;

    const wx = this.xMin + (canvasX / this.width) * (this.xMax - this.xMin);
    const wy = this._effYMin + (1 - canvasY / this.height) * (this._effYMax - this._effYMin);

    const worldPerPx = (this.xMax - this.xMin) / this.width;
    const R = 200 * worldPerPx;
    const GRID = 40;
    const step = (2 * R) / GRID;
    const gx0 = wx - R, gy0 = wy - R;

    let bestDistSq = Infinity;
    let bestPoint = null;
    let bestF = null;

    const rowA = new Float64Array(GRID + 1);
    const rowB = new Float64Array(GRID + 1);

    for (const expr of this._lastActive) {
      if (this._snapExprId !== null && expr.exprId !== this._snapExprId) continue;
      
      const F = this._getJsEvaluator(expr);
      if (!F) continue;

      for (let ix = 0; ix <= GRID; ix++) rowA[ix] = F(gx0 + ix * step, gy0);

      for (let iy = 0; iy < GRID; iy++) {
        const cy1 = gy0 + iy * step;
        const cy2 = cy1 + step;
        for (let ix = 0; ix <= GRID; ix++) rowB[ix] = F(gx0 + ix * step, cy2);

        for (let ix = 0; ix < GRID; ix++) {
          const cx1 = gx0 + ix * step;
          const cx2 = cx1 + step;
          if (rowA[ix] * rowA[ix + 1] < 0) {
            const pt = this._bisect(F, cx1, cy1, cx2, cy1, rowA[ix], rowA[ix + 1]);
            const dsq = (pt.x - wx) ** 2 + (pt.y - wy) ** 2;
            if (dsq < bestDistSq) { bestDistSq = dsq; bestPoint = pt; bestF = F; }
          }
          if (rowA[ix] * rowB[ix] < 0) {
            const pt = this._bisect(F, cx1, cy1, cx1, cy2, rowA[ix], rowB[ix]);
            const dsq = (pt.x - wx) ** 2 + (pt.y - wy) ** 2;
            if (dsq < bestDistSq) { bestDistSq = dsq; bestPoint = pt; bestF = F; }
          }
        }
        // Slide row forward
        rowA.set(rowB);
      }

      // If no candidate found yet, try a finer pass over a smaller area (handles
      // steep-gradient curves like metaballs where a sign change fits in one cell)
      if (bestPoint === null) {
        const FINE = GRID * 2;
        const fineR = R * 0.5;
        const fineStep = (2 * fineR) / FINE;
        const fx0 = wx - fineR, fy0 = wy - fineR;
        const fRowA = new Float64Array(FINE + 1);
        const fRowB = new Float64Array(FINE + 1);
        for (let ix = 0; ix <= FINE; ix++) fRowA[ix] = F(fx0 + ix * fineStep, fy0);
        for (let iy = 0; iy < FINE; iy++) {
          const cy1 = fy0 + iy * fineStep;
          const cy2 = cy1 + fineStep;
          for (let ix = 0; ix <= FINE; ix++) fRowB[ix] = F(fx0 + ix * fineStep, cy2);
          for (let ix = 0; ix < FINE; ix++) {
            const cx1 = fx0 + ix * fineStep;
            const cx2 = cx1 + fineStep;
            if (fRowA[ix] * fRowA[ix + 1] < 0) {
              const pt = this._bisect(F, cx1, cy1, cx2, cy1, fRowA[ix], fRowA[ix + 1]);
              const dsq = (pt.x - wx) ** 2 + (pt.y - wy) ** 2;
              if (dsq < bestDistSq) { bestDistSq = dsq; bestPoint = pt; bestF = F; }
            }
            if (fRowA[ix] * fRowB[ix] < 0) {
              const pt = this._bisect(F, cx1, cy1, cx1, cy2, fRowA[ix], fRowB[ix]);
              const dsq = (pt.x - wx) ** 2 + (pt.y - wy) ** 2;
              if (dsq < bestDistSq) { bestDistSq = dsq; bestPoint = pt; bestF = F; }
            }
          }
          fRowA.set(fRowB);
        }
      }
    }

    if (bestPoint === null) return null;
    bestPoint = this._refineNearestCurvePoint(bestF,bestPoint.x,bestPoint.y,wx,wy);

    return { x: bestPoint.x, y: bestPoint.y, F: bestF };
  }

  
  _refineNearestCurvePoint(F,pointXEst,pointYEst,targetX,targetY){
    let origEst = this._approxNearest(F,pointXEst,pointYEst);

    let target = {x:targetX,y:targetY};
    let currentDist = Math.hypot(origEst.x-target.x,origEst.y-target.y);

    let leftEst;
    let rightEst;

    let est = {x:origEst.x,y:origEst.y};

    let moveDir = 1;

    for(let dir = 0; dir < 2; dir++){
      scootLoop:
      for(let i = 0; i < 200; i++){
        let gradient = this._evaluateGradient(F,est.x,est.y);
        let gradMag = Math.hypot(gradient.x,gradient.y);
        if(gradMag==0 || gradMag == NaN){
          return origEst;
        }
        gradient.x /= gradMag;
        gradient.y /= gradMag;

        gradient.x *= currentDist*0.01*moveDir;
        gradient.y *= currentDist*0.01*moveDir;

        //Move est perpendicularly to the gradient
        let newEst = {x:est.x-gradient.y,y:est.y+gradient.x};
        newEst = this._approxNearest(F,newEst.x,newEst.y);

        let newDist = Math.hypot(newEst.x-target.x,newEst.y-target.y);

        if(newDist<currentDist){
          currentDist = newDist;
          est = newEst;
        }
        else{
          currentDist = newDist;
          est = newEst;
          break scootLoop;
        }
      }
      moveDir = -1;
      if(dir == 0){
        leftEst = est;
      }
      else{
        rightEst = est; 
      }
      est = origEst;
    }

    //Bin search to find best estimate
    for(let i = 0; i < 12; i++){
      est = {
        x:(leftEst.x+rightEst.x)/2,
        y:(leftEst.y+rightEst.y)/2
      };
      est = this._approxNearest(F,est.x,est.y);

      let leftDist = Math.hypot(leftEst.x-target.x,leftEst.y-target.y);
      let rightDist = Math.hypot(rightEst.x-target.x,rightEst.y-target.y);

      if(leftDist>rightDist){
        leftEst = est;
      }else{
        rightEst = est;
      }
    }
    est = {
      x:(leftEst.x+rightEst.x)/2,
      y:(leftEst.y+rightEst.y)/2
    };

    return est;
  }


  //This is currently not in use, but could be useful in the future due to the discontinuous nature of clsoes points
  _gradDecNearest(F,x,y){

    let costF = (x,y)=>{return F(x,y)**2};

    let est = {x:x,y:y};
    let currentValue = costF(x,y);

    for(let i = 0; i < 2000; i++){
      let gradient = this._evaluateGradient(costF,est.x,est.y);

      let gradMag = Math.hypot(gradient.x,gradient.y);

      if(gradMag==0 || gradMag == NaN){
        return est;
      }

      gradient.x /= gradMag*gradMag;
      gradient.y /= gradMag*gradMag;
      gradient.x *= -1;
      gradient.y *= -1;

      overshootLoop:
      for(let j = 0; j < 10; j++){

        let newEst = {x:est.x+gradient.x,y:est.y+gradient.y};
        let newVal = costF(newEst.x,newEst.y);
        if(newVal<currentValue){
          est = newEst;
          currentValue = newVal;
          break overshootLoop;
        }
        else{
          gradient.x *= 0.5;
          gradient.y *= 0.5;
        }
      }
    }

    return est;
  }

  //Uses a single pass of gradient descent to snap a point to the line. This allows the adjustment system to accurately traverse along curves.
  _approxNearest(F,x,y){
    let currentValue = F(x,y);
    let gradient = this._evaluateGradient(F,x,y);

    let gradMag = Math.hypot(gradient.x,gradient.y);

    if(gradMag==0 || gradMag == NaN){
      return {x:x,y:y};
    }

    gradient.x /= gradMag*gradMag;
    gradient.y /= gradMag*gradMag;

    gradient.x *= -currentValue*0.5;
    gradient.y *= -currentValue*0.5;
    


    let testPoint;

    let runawayCounter = 0;

    do {
      testPoint = {
        x:x+gradient.x,
        y:y+gradient.y
      };

      gradient.x *= 2;
      gradient.y *= 2;

      runawayCounter++;
    }
    while(F(testPoint.x,testPoint.y) * currentValue > 0 && runawayCounter < 8);

    if(F(testPoint.x,testPoint.y) * currentValue > 0 ){
      return {x:x,y:y};
    }

    return this._bisect(F,x,y,testPoint.x,testPoint.y,currentValue,F(testPoint.x,testPoint.y));
  }

  _evaluateGradient(F,x,y){
    let d = 0.000001;
    return {
      x:(F(x+d,y)-F(x-d,y))/(d*2),
      y:(F(x,y+d)-F(x,y-d))/(d*2)
    }
  }

  _bisect(F, x0, y0, x1, y1, f0nop, f1nop, iters = 12) {
    let f0 = F(x0,y0);
    let f1 = F(x1,y1);

    for (let i = 0; i < iters; i++) {
      const xm = (x0 + x1) * 0.5;
      const ym = (y0 + y1) * 0.5;
      const fm = F(xm, ym);
      if (f0 * fm <= 0) { x1 = xm; y1 = ym; f1 = fm; }
      else              { x0 = xm; y0 = ym; f0 = fm; }
    }
    return { x: (x0 + x1) * 0.5, y: (y0 + y1) * 0.5 };
  }

  _updateSnap(canvasX, canvasY) {
    const wx = this.xMin + (canvasX / this.width) * (this.xMax - this.xMin);
    const wy = this._effYMin + (1 - canvasY / this.height) * (this._effYMax - this._effYMin);

    let pt = this._findNearestCurvePoint(canvasX, canvasY);

    // Fallback: if grid search missed, walk the previous curve toward the cursor
    if (pt === null && this._snapF !== null && this._snapPoint !== null) {
      const refined = this._refineNearestCurvePoint(
        this._snapF, this._snapPoint.wx, this._snapPoint.wy, wx, wy
      );
      pt = { x: refined.x, y: refined.y, F: this._snapF };
    }

    if (pt !== null) {
      this._snapF     = pt.F;
      this._snapPoint = { wx: pt.x, wy: pt.y };
    } else {
      this._snapPoint = null;
    }

    if (this._onSnapUpdate) {
      if (this._snapPoint) {
        const sx = (this._snapPoint.wx - this.xMin) / (this.xMax - this.xMin) * this.width;
        const sy = (1 - (this._snapPoint.wy - this._effYMin) / (this._effYMax - this._effYMin)) * this.height;
        this._onSnapUpdate(this._snapPoint, sx, sy);
      } else {
        this._onSnapUpdate(null, 0, 0);
      }
    }
  }

  // ── Shader generation ──────────────────────────────────────────────────

  /**
   * Build the fragment shader for a thin-line pass.
   * Accepts either a plain GLSL expression string (legacy) or a shaderInfo
   * object { uniformDecls, bodyCode, fExpr } from the new analysis pipeline.
   */
  _buildThinLineFS(shaderInfoOrGlsl) {
    let uniformDecls = '';
    let bodyCode = '';
    let fExpr;

    if (typeof shaderInfoOrGlsl === 'string') {
      fExpr = shaderInfoOrGlsl;
    } else {
      uniformDecls = shaderInfoOrGlsl.uniformDecls || '';
      bodyCode = shaderInfoOrGlsl.bodyCode || '';
      fExpr = shaderInfoOrGlsl.fExpr;
    }

    return `#version 300 es
precision highp float;
in vec2 v_position;

uniform vec2 u_rangeMin;   // (xMin, yMin)
uniform vec2 u_rangeMax;   // (xMax, yMax)
uniform vec2 u_resolution; // (width, height)
uniform float u_graphId;
uniform sampler2D u_prevTex;
${uniformDecls}

out vec4 FragColor;

float F(float x, float y) {
    ${bodyCode}
    return ${fExpr};
}

void main() {
    vec2 uv = 0.5 * (v_position + 1.0);
    vec2 pixel = uv * u_resolution;
    float x = mix(u_rangeMin.x, u_rangeMax.x, uv.x);
    float y = mix(u_rangeMin.y, u_rangeMax.y, uv.y);

    vec2 worldPixSize = (u_rangeMax - u_rangeMin) / u_resolution;

    bool hasNeg = false;
    bool hasPos = false;
    vec2 negPos = vec2(0.0);
    vec2 posPos = vec2(0.0);
    float negVal = -1e20;
    float posVal = 1e20;

    // Sample a nxn subpixel grid to detect zero crossings.
    // Higher resolution subsampling may improve accuracy for curves with multiple lines very close together
    // (like a high frequency sin function) at the cost of worse performance
    

    int sampleRes = 3;

    for (int yD = -(sampleRes-1)/2; yD < (sampleRes+1)/2; yD++) {
        for (int xD = -(sampleRes-1)/2; xD < (sampleRes+1)/2; xD++) {
            vec2 off = vec2(float(xD) / (float(sampleRes+1)/2.0) * worldPixSize.x,
                            float(yD) / (float(sampleRes+1)/2.0) * worldPixSize.y);
            float val = F(x + off.x, y + off.y);
            if (val <= 0.0 && val > negVal) { negVal = val; negPos = off; hasNeg = true; }
            if (val >= 0.0 && val < posVal) { posVal = val; posPos = off; hasPos = true; }
        }
    }

    if (hasNeg && hasPos) {
        // Binary search for the exact zero crossing
        vec2 center = 0.5 * (negPos + posPos);
        for (int i = 0; i < 8; i++) {
            float cv = F(x + center.x, y + center.y);
            if (cv < 0.0) negPos = center; else posPos = center;
            center = 0.5 * (negPos + posPos);
        }
        FragColor = vec4(center / worldPixSize, u_graphId, 1.0);
    } else {
        // No crossing — preserve previous graph data
        ivec2 tc = ivec2(pixel);
        FragColor = texelFetch(u_prevTex, tc, 0);
    }
}
`;
  }

  /**
   * Return the cached thin-line shader entry for a shader key, or null if it is
   * still compiling. On first call for a new key, kicks off async GPU compilation.
   *
   * @param {string} shaderKey - Cache key (either GLSL string or shaderInfo.shaderKey)
   * @param {string|Object} shaderInfoOrGlsl - GLSL string or { uniformDecls, bodyCode, fExpr, constantUniforms }
   */
  _getThinLineProgram(shaderKey, shaderInfoOrGlsl) {
    if (this.thinLineShaders.has(shaderKey)) return this.thinLineShaders.get(shaderKey);
    if (this._pendingShaders.has(shaderKey)) return null; // compiling

    // Store the shaderInfo alongside the handle so _checkPending can query custom uniforms
    const shaderInfo = typeof shaderInfoOrGlsl === 'string' ? null : shaderInfoOrGlsl;

    try {
      const handle = GL.beginShaderProgram(this.gl, GL.GENERIC_VS, this._buildThinLineFS(shaderInfoOrGlsl));
      this._pendingShaders.set(shaderKey, { handle, shaderInfo });
    } catch (e) {
      console.warn('[GraphRenderer] shader init failed:', e.message);
      this._pendingShaders.set(shaderKey, null);
    }
    this._schedulePoll();
    return null;
  }

  /** Schedule a poll for pending shader completion on the next animation frame. */
  _schedulePoll() {
    if (this._pollHandle !== null) return;
    this._pollHandle = requestAnimationFrame(() => {
      this._pollHandle = null;
      this._checkPending();
    });
  }

  /** Check all pending shaders; finalize any that are done. */
  _checkPending() {
    const gl = this.gl;
    const ext = this._khrParallelShader;
    let anyStillPending = false;
    let anyCompleted = false;

    for (const [shaderKey, pending] of this._pendingShaders) {
      if (!pending) { this._pendingShaders.delete(shaderKey); continue; }

      const { handle, shaderInfo } = pending;

      const ready = ext
        ? gl.getProgramParameter(handle.program, ext.COMPLETION_STATUS_KHR)
        : true;

      if (!ready) { anyStillPending = true; continue; }

      try {
        const prog = GL.finalizeShaderProgram(gl, handle);
        if (!this.vao) this.vao = GL.createFullscreenTriangle(gl, prog);
        const entry = {
          program: prog,
          u_rangeMin:   gl.getUniformLocation(prog, 'u_rangeMin'),
          u_rangeMax:   gl.getUniformLocation(prog, 'u_rangeMax'),
          u_resolution: gl.getUniformLocation(prog, 'u_resolution'),
          u_graphId:    gl.getUniformLocation(prog, 'u_graphId'),
          u_prevTex:    gl.getUniformLocation(prog, 'u_prevTex'),
          customUniforms: {},
        };
        // Query locations for custom constant uniforms
        if (shaderInfo && shaderInfo.constantUniforms) {
          for (const { name, glslName } of shaderInfo.constantUniforms) {
            entry.customUniforms[name] = gl.getUniformLocation(prog, glslName);
          }
        }
        this.thinLineShaders.set(shaderKey, entry);
        anyCompleted = true;
      } catch (e) {
        console.warn('[GraphRenderer] shader compile failed:', e.message);
      }
      this._pendingShaders.delete(shaderKey);
    }

    if (anyStillPending) this._schedulePoll();
    if (anyCompleted && this._onRender) this._onRender();
  }

  _initThickenShader() {
    const gl = this.gl;
    // Maximum 16 graph colors
    const fs = `#version 300 es
precision highp float;
in vec2 v_position;

uniform vec2 u_resolution;
uniform vec3 u_colors[16];
uniform float u_thicknesses[16];
uniform int u_numColors;
uniform sampler2D u_tex;
uniform vec3 u_bgColor;
uniform float u_lightTheme;

// Grid / axes uniforms
uniform vec2 u_rangeMin;
uniform vec2 u_rangeMax;

// Snap-to-curve indicator
uniform vec2  u_snapPoint;   // position in WebGL pixel coords (bottom-left origin)
uniform float u_showSnap;    // 1.0 = draw, 0.0 = hide
uniform vec3  u_snapColor;   // color of the snapped expression

out vec4 FragColor;

void main() {
    vec2 uv = 0.5 * (v_position + 1.0);
    ivec2 px = ivec2(uv * u_resolution);
    int ipx = px.x;
    int ipy = px.y;
    int w = int(u_resolution.x);
    int h = int(u_resolution.y);

    // -- Grid / axes --
    vec2 worldPos = mix(u_rangeMin, u_rangeMax, uv);
    vec2 worldPixSize = (u_rangeMax - u_rangeMin) / u_resolution;

    // Choose grid spacing based on zoom level
    float rangeX = u_rangeMax.x - u_rangeMin.x;
    float rawStep = rangeX / 8.0;
    float exponent = floor(log(rawStep) / log(10.0));
    float base = pow(10.0, exponent);
    float gridStep;
    if (rawStep / base < 2.0) gridStep = base;
    else if (rawStep / base < 5.0) gridStep = 2.0 * base;
    else gridStep = 5.0 * base;

    float subStep = gridStep / 5.0;

    // Theme-aware grid colors
    vec3 subGridColor = u_lightTheme > 0.5 ? vec3(0.85, 0.85, 0.88) : vec3(0.35, 0.36, 0.45);
    vec3 gridColor    = u_lightTheme > 0.5 ? vec3(0.75, 0.75, 0.80) : vec3(0.35, 0.36, 0.45);
    vec3 axisColor    = u_lightTheme > 0.5 ? vec3(0.30, 0.30, 0.35) : vec3(0.55, 0.56, 0.65);

    // Start with background
    vec3 color = u_bgColor;

    // Sub-gridlines
    float distSubX = abs(mod(worldPos.x + 0.5 * subStep, subStep) - 0.5 * subStep);
    float distSubY = abs(mod(worldPos.y + 0.5 * subStep, subStep) - 0.5 * subStep);
    float subLineThick = 0.5 * worldPixSize.x;
    if (distSubX < subLineThick || distSubY < subLineThick) {
        color = mix(color, subGridColor, 0.25);
    }

    // Major gridlines
    float distGridX = abs(mod(worldPos.x + 0.5 * gridStep, gridStep) - 0.5 * gridStep);
    float distGridY = abs(mod(worldPos.y + 0.5 * gridStep, gridStep) - 0.5 * gridStep);
    float gridLineThick = 0.8 * worldPixSize.x;
    if (distGridX < gridLineThick || distGridY < gridLineThick) {
        color = mix(color, gridColor, 0.5);
    }

    // Axes (thicker)
    float axisThick = 1.2 * worldPixSize.x;
    if (abs(worldPos.x) < axisThick || abs(worldPos.y) < axisThick) {
        color = axisColor;
    }

    // -- Graph curves --
    // Compute best alpha per graph, then composite in order so overlapping
    // AA edges blend with the graph beneath, not the background.
    int samples = 16;
    float graphAlphas[16];
    for (int g = 0; g < 16; g++) graphAlphas[g] = 0.0;

    for (int dy = -(samples-1)/2; dy < (samples+1)/2; dy++) {
        for (int dx = -(samples-1)/2; dx < (samples+1)/2; dx++) {
            vec4 pix = texelFetch(u_tex, ivec2(ipx + dx, ipy + dy), 0);
            if (pix.a == 1.0) {
                int idx = int(pix.z + 0.5);
                if (idx >= 0 && idx < u_numColors) {
                    float lineRadius = u_thicknesses[idx];
                    vec2 totalOffset = vec2(float(dx), float(dy)) + pix.xy;
                    float dist = length(totalOffset);
                    float d = lineRadius - dist;
                    float alpha = 0.0;
                    if (d >= 1.0) alpha = 1.0;
                    else if (d >= -1.0) alpha = smoothstep(-1.0, 1.0, d);
                    graphAlphas[idx] = max(graphAlphas[idx], alpha);
                }
            }
        }
    }

    // Composite graphs in order: low ID first, high ID on top
    for (int g = 0; g < u_numColors; g++) {
        if (graphAlphas[g] > 0.0) {
            color = mix(color, u_colors[g], graphAlphas[g]);
        }
    }

    FragColor = vec4(color, 1.0);

    // Snap indicator: filled dot with contrasting ring
    if (u_showSnap > 0.5) {
        float sd = length(gl_FragCoord.xy - u_snapPoint);
        // float ring = smoothstep(9.5, 8.5, sd) * (1.0 - smoothstep(7.5, 6.5, sd));

        float fill = smoothstep(6.5, 5.5, sd);

        // vec3 ringCol = u_lightTheme > 0.5 ? vec3(0.85, 0.85, 0.85) : vec3(0.15, 0.15, 0.15);
        // color = mix(color, ringCol, ring);

        color = mix(color, u_snapColor, fill);
        FragColor = vec4(color, 1.0);
    }
}
`;
    this.thickenProgram = GL.createShaderProgram(gl, GL.GENERIC_VS, fs);
    this.vao = GL.createFullscreenTriangle(gl, this.thickenProgram);
    this._thickenUniforms = {
      u_resolution:   gl.getUniformLocation(this.thickenProgram, 'u_resolution'),
      u_colors:       gl.getUniformLocation(this.thickenProgram, 'u_colors'),
      u_thicknesses:  gl.getUniformLocation(this.thickenProgram, 'u_thicknesses'),
      u_numColors:    gl.getUniformLocation(this.thickenProgram, 'u_numColors'),
      u_tex:          gl.getUniformLocation(this.thickenProgram, 'u_tex'),
      u_bgColor:      gl.getUniformLocation(this.thickenProgram, 'u_bgColor'),
      u_lightTheme:   gl.getUniformLocation(this.thickenProgram, 'u_lightTheme'),
      u_rangeMin:     gl.getUniformLocation(this.thickenProgram, 'u_rangeMin'),
      u_rangeMax:     gl.getUniformLocation(this.thickenProgram, 'u_rangeMax'),
      u_snapPoint:    gl.getUniformLocation(this.thickenProgram, 'u_snapPoint'),
      u_showSnap:     gl.getUniformLocation(this.thickenProgram, 'u_showSnap'),
      u_snapColor:    gl.getUniformLocation(this.thickenProgram, 'u_snapColor'),
    };
  }

  // ── Main render entry ──────────────────────────────────────────────────

  /**
   * Render using the compiled expression cache (populated by updateExpressions()).
   * @param {number} width          Canvas pixel width
   * @param {number} height         Canvas pixel height
   * @param {boolean} lightTheme
   * @param {string|null} focusedExprId  If set, that expression renders last (on top) with +0.5 thickness
   */
  render(width, height, lightTheme, focusedExprId = null) {
    const gl = this.gl;
    width  = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));

    // Resize canvas and GPU image if needed
    this.width  = width;
    this.height = height;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width  = width;
      this.canvas.height = height;
    }
    if (!this.image || this.image.width !== width || this.image.height !== height) {
      if (this.image) this.image.destroy();
      this.image = new GPUImage(gl, width, height);
    }

    const img = this.image;
    img.clear();

    // Compute aspect-corrected bounds so pixels are square in world space.
    // X range is authoritative; Y range is derived from the Y center + aspect ratio.
    const aspect = height / width;
    const xRange = this.xMax - this.xMin;
    const yCenterStored = 0.5 * (this.yMin + this.yMax);
    const yHalf = xRange * aspect * 0.5;
    const effYMin = yCenterStored - yHalf;
    const effYMax = yCenterStored + yHalf;

    // Build rendering list from cache, attaching shared constantValues, then apply focus order
    let exprs = this._compiledExprs.map(e => ({ ...e, constantValues: this._constantValues }));
    if (focusedExprId) {
      const fi = exprs.findIndex(e => e.exprId === focusedExprId);
      if (fi !== -1) {
        const focused = { ...exprs[fi], thickness: exprs[fi].thickness + 0.5 };
        exprs = [...exprs.slice(0, fi), ...exprs.slice(fi + 1), focused];
      }
    }

    // Collect enabled expressions
    const active = [];
    for (const expr of exprs) {
      if (!expr.enabled) continue;
      // Support both legacy { glsl } and new { shaderInfo } formats
      if (!expr.glsl && !expr.shaderInfo) continue;
      active.push(expr);
    }

    // Pass 1: Thin-line pass for each graph, stacking into one buffer
    gl.bindVertexArray(this.vao);
    for (let i = 0; i < active.length; i++) {
      const expr = active[i];
      let shaderKey, shaderArg;

      if (expr.shaderInfo) {
        shaderKey = expr.shaderInfo.shaderKey;
        shaderArg = expr.shaderInfo;
      } else {
        shaderKey = expr.glsl;
        shaderArg = expr.glsl;
      }

      const entry = this._getThinLineProgram(shaderKey, shaderArg);
      if (!entry) continue;

      gl.useProgram(entry.program);
      gl.viewport(0, 0, width, height);

      gl.uniform2f(entry.u_rangeMin, this.xMin, effYMin);
      gl.uniform2f(entry.u_rangeMax, this.xMax, effYMax);
      gl.uniform2f(entry.u_resolution, width, height);
      gl.uniform1f(entry.u_graphId, i);
      gl.uniform1i(entry.u_prevTex, 0);

      // Upload custom constant uniforms
      if (entry.customUniforms && expr.constantValues) {
        for (const [name, loc] of Object.entries(entry.customUniforms)) {
          if (loc !== null && expr.constantValues.has(name)) {
            gl.uniform1f(loc, expr.constantValues.get(name));
          }
        }
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, img.frontTex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, img.backFb);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      img.swapBuffers();
    }

    // Store expr id mapping for pick queries (graphId → exprId)
    this._lastActiveExprIds = active.map(e => e.exprId || null);

    // Cache active expressions and Y bounds for CPU snap queries
    this._lastActive = active;
    this._effYMin    = effYMin;
    this._effYMax    = effYMax;

    // Pass 2: Thicken + anti-alias + grid, render to screen
    gl.useProgram(this.thickenProgram);
    gl.viewport(0, 0, width, height);
    const u = this._thickenUniforms;
    gl.uniform2f(u.u_resolution, width, height);
    gl.uniform2f(u.u_rangeMin, this.xMin, effYMin);
    gl.uniform2f(u.u_rangeMax, this.xMax, effYMax);

    // Background color
    if (lightTheme) {
      gl.uniform3f(u.u_bgColor, 1.0, 1.0, 1.0);
    } else {
      gl.uniform3f(u.u_bgColor, 0.118, 0.118, 0.180); // #1e1e2e
    }
    gl.uniform1f(u.u_lightTheme, lightTheme ? 1.0 : 0.0);

    // Upload graph colors and thicknesses
    const colorData = new Float32Array(16 * 3);
    const thicknessData = new Float32Array(16);
    for (let i = 0; i < active.length && i < 16; i++) {
      const c = this._parseColor(active[i].color);
      colorData[i * 3]     = c[0];
      colorData[i * 3 + 1] = c[1];
      colorData[i * 3 + 2] = c[2];
      thicknessData[i] = active[i].thickness != null ? active[i].thickness : 2.0;
    }
    gl.uniform3fv(u.u_colors, colorData);
    gl.uniform1fv(u.u_thicknesses, thicknessData);
    gl.uniform1i(u.u_numColors, Math.min(active.length, 16));
    gl.uniform1i(u.u_tex, 0);

    // Upload snap indicator
    if (this._snapPoint) {
      const uv_x = (this._snapPoint.wx - this.xMin) / (this.xMax - this.xMin);
      const uv_y = (this._snapPoint.wy - effYMin)   / (effYMax - effYMin);
      gl.uniform1f(u.u_showSnap, 1.0);
      gl.uniform2f(u.u_snapPoint, uv_x * width, uv_y * height);
    } else {
      gl.uniform1f(u.u_showSnap, 0.0);
      gl.uniform2f(u.u_snapPoint, 0.0, 0.0);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, img.frontTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Parse a CSS hex color to [r, g, b] floats. */
  _parseColor(hex) {
    if (!hex || hex[0] !== '#') return [1, 1, 1];
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [r, g, b];
  }

  /**
   * Copy current canvas content to a target canvas (for embedding in the document).
   * @param {HTMLCanvasElement} target
   */
  copyToCanvas(target) {
    const ctx = target.getContext('2d');
    target.width  = this.canvas.width;
    target.height = this.canvas.height;
    ctx.drawImage(this.canvas, 0, 0);
  }

  /** Invalidate all cached shaders (call when expressions change). */
  clearShaderCache() {
    const gl = this.gl;
    for (const entry of this.thinLineShaders.values()) {
      gl.deleteProgram(entry.program);
    }
    this.thinLineShaders.clear();
    this._jsEvaluators.clear();
    // Cancel any in-flight async compilations
    for (const pending of this._pendingShaders.values()) {
      if (pending) {
        const h = pending.handle || pending; // support new { handle, shaderInfo } and legacy
        if (h.program) gl.deleteProgram(h.program);
        if (h.vs) gl.deleteShader(h.vs);
        if (h.fs) gl.deleteShader(h.fs);
      }
    }
    this._pendingShaders.clear();
    if (this._pollHandle !== null) {
      cancelAnimationFrame(this._pollHandle);
      this._pollHandle = null;
    }
  }

  destroy() {
    this.clearShaderCache();
    if (this.image) { this.image.destroy(); this.image = null; }
    if (this.thickenProgram) { this.gl.deleteProgram(this.thickenProgram); }
  }
}

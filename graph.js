'use strict';

// ── LaTeX → GLSL compiler ────────────────────────────────────────────────────
//
// Converts a MathQuill LaTeX expression (e.g. "x^{2}+y^{2}=1") into a GLSL
// float expression F(x,y) suitable for implicit-curve rendering.
// Returns a string like "(pow(x,2.0)+pow(y,2.0))-(1.0)".
// Throws CompileError on parse failure.

class CompileError extends Error {
  constructor(msg) { super(msg); this.name = 'CompileError'; }
}

function latexToGlslF(latex) {
  // Split on '=' at brace-depth 0
  const eqIdx = findEqAtDepth0(latex);
  if (eqIdx === -1) {
    // No '=': treat whole thing as f(x,y)=0
    return glslExpr(latex);
  }
  const lhs = latex.slice(0, eqIdx).trim();
  const rhs = latex.slice(eqIdx + 1).trim();
  return `(${glslExpr(lhs)})-(${glslExpr(rhs)})`;
}

function findEqAtDepth0(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
    else if (c === '=' && depth === 0) return i;
  }
  return -1;
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

const TK = {
  NUM:    'NUM',
  IDENT:  'IDENT',
  CMD:    'CMD',    // \something
  LBRACE: 'LBRACE', RBRACE: 'RBRACE',
  LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  LBRACKET: 'LBRACKET', RBRACKET: 'RBRACKET',
  PLUS: 'PLUS', MINUS: 'MINUS', STAR: 'STAR', SLASH: 'SLASH',
  CARET: 'CARET', UNDERSCORE: 'UNDERSCORE',
  PIPE: 'PIPE',
  EOF: 'EOF',
};

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c >= '0' && c <= '9' || c === '.') {
      let num = '';
      while (i < src.length && (src[i] >= '0' && src[i] <= '9' || src[i] === '.')) num += src[i++];
      tokens.push({ type: TK.NUM, val: num });
      continue;
    }
    if (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
      tokens.push({ type: TK.IDENT, val: c }); i++; continue;
    }
    if (c === '\\') {
      let cmd = '\\'; i++;
      while (i < src.length && src[i] >= 'a' && src[i] <= 'z' || i < src.length && src[i] >= 'A' && src[i] <= 'Z')
        cmd += src[i++];
      if (cmd === '\\') { // single non-alpha char after backslash
        cmd += src[i++];
      }
      // \operatorname{name} → emit as \name (e.g. \sin, \ln)
      if (cmd === '\\operatorname' && i < src.length && src[i] === '{') {
        i++; // skip {
        let name = '';
        while (i < src.length && src[i] !== '}') name += src[i++];
        if (i < src.length) i++; // skip }
        cmd = '\\' + name;
      }
      tokens.push({ type: TK.CMD, val: cmd }); continue;
    }
    if (c === '{') { tokens.push({ type: TK.LBRACE }); i++; continue; }
    if (c === '}') { tokens.push({ type: TK.RBRACE }); i++; continue; }
    if (c === '(') { tokens.push({ type: TK.LPAREN }); i++; continue; }
    if (c === ')') { tokens.push({ type: TK.RPAREN }); i++; continue; }
    if (c === '[') { tokens.push({ type: TK.LBRACKET }); i++; continue; }
    if (c === ']') { tokens.push({ type: TK.RBRACKET }); i++; continue; }
    if (c === '+') { tokens.push({ type: TK.PLUS }); i++; continue; }
    if (c === '-') { tokens.push({ type: TK.MINUS }); i++; continue; }
    if (c === '*') { tokens.push({ type: TK.STAR }); i++; continue; }
    if (c === '/') { tokens.push({ type: TK.SLASH }); i++; continue; }
    if (c === '^') { tokens.push({ type: TK.CARET }); i++; continue; }
    if (c === '_') { tokens.push({ type: TK.UNDERSCORE }); i++; continue; }
    if (c === '|') { tokens.push({ type: TK.PIPE }); i++; continue; }
    // Skip other characters silently
    i++;
  }
  tokens.push({ type: TK.EOF });
  return tokens;
}

// ── Parser ────────────────────────────────────────────────────────────────────
// Grammar:
//   expr   → sum
//   sum    → product (('+' | '-') product)*
//   product→ unary (implicit_mult unary)*
//   unary  → '-' unary | power
//   power  → atom ('^' atom)?
//   atom   → number | variable | command | '(' expr ')' | '{' expr '}' | '|' expr '|'

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek()  { return this.tokens[this.pos]; }
  next()  { return this.tokens[this.pos++]; }
  eat(type) {
    const t = this.peek();
    if (t.type !== type) throw new CompileError(`Expected ${type}, got ${t.type} (${t.val || ''})`);
    return this.next();
  }
  atExprEnd() {
    const t = this.peek();
    if (t.type === TK.EOF || t.type === TK.RBRACE || t.type === TK.RPAREN ||
        t.type === TK.RBRACKET || t.type === TK.PIPE) return true;
    // \right is a delimiter, not an operand — stop parsing before it
    if (t.type === TK.CMD && t.val === '\\right') return true;
    return false;
  }

  parseExpr() { return this.parseSum(); }

  parseSum() {
    let left = this.parseProduct();
    while (this.peek().type === TK.PLUS || this.peek().type === TK.MINUS) {
      const op = this.next().type === TK.PLUS ? '+' : '-';
      // Re-check: we already advanced, recalculate
      const prevType = this.tokens[this.pos - 1].type;
      left = `(${left}${prevType === TK.PLUS ? '+' : '-'}${this.parseProduct()})`;
    }
    return left;
  }

  parseProduct() {
    let left = this.parseUnary();
    while (!this.atExprEnd() && this.peek().type !== TK.PLUS && this.peek().type !== TK.MINUS) {
      // Implicit multiplication — but don't consume operators that belong to sum
      const nextType = this.peek().type;
      if (nextType === TK.PLUS || nextType === TK.MINUS || nextType === TK.EOF ||
          nextType === TK.RBRACE || nextType === TK.RPAREN || nextType === TK.RBRACKET ||
          nextType === TK.PIPE) break;
      // Skip explicit multiplication operators (\cdot, \times, *)
      if (nextType === TK.STAR) { this.next(); continue; }
      if (nextType === TK.CMD && (this.peek().val === '\\cdot' || this.peek().val === '\\times')) {
        this.next(); continue;
      }
      left = `(${left}*${this.parseUnary()})`;
    }
    return left;
  }

  parseUnary() {
    if (this.peek().type === TK.MINUS) {
      this.next();
      return `(-(${this.parsePower()}))`;
    }
    return this.parsePower();
  }

  parsePower() {
    let base = this.parseAtom();
    if (this.peek().type === TK.CARET) {
      this.next();
      const exp = this.parseAtom();
      base = `pow(${base},${exp})`;
    }
    return base;
  }

  parseAtom() {
    const t = this.peek();

    // Number
    if (t.type === TK.NUM) {
      this.next();
      const s = t.val;
      return s.includes('.') ? s : s + '.0';
    }

    // Parenthesised group
    if (t.type === TK.LPAREN) {
      this.next();
      const inner = this.parseExpr();
      if (this.peek().type === TK.RPAREN) this.next();
      return `(${inner})`;
    }

    // Braced group
    if (t.type === TK.LBRACE) {
      this.next();
      const inner = this.parseExpr();
      if (this.peek().type === TK.RBRACE) this.next();
      return inner;
    }

    // Absolute value  | expr |
    if (t.type === TK.PIPE) {
      this.next();
      const inner = this.parseExpr();
      if (this.peek().type === TK.PIPE) this.next();
      return `abs(${inner})`;
    }

    // Command
    if (t.type === TK.CMD) return this.parseCommand();

    // Identifier (single letter variable or constant)
    if (t.type === TK.IDENT) {
      this.next();
      const v = t.val;
      if (v === 'e') return '2.718281828459045';
      return v; // x, y, or other variable — passed through
    }

    throw new CompileError(`Unexpected token: ${t.type} (${t.val || ''})`);
  }

  parseBracedArg() {
    if (this.peek().type === TK.LBRACE) {
      this.eat(TK.LBRACE);
      const v = this.parseExpr();
      this.eat(TK.RBRACE);
      return v;
    }
    // Fallback: single atom
    return this.parseAtom();
  }

  parseCommand() {
    const cmd = this.next().val; // consume the CMD token

    switch (cmd) {
      case '\\frac': {
        const num = this.parseBracedArg();
        const den = this.parseBracedArg();
        return `((${num})/(${den}))`;
      }
      case '\\sqrt': {
        // \sqrt[n]{x} or \sqrt{x}
        if (this.peek().type === TK.LBRACKET) {
          this.next(); // [
          const n = this.parseExpr();
          this.eat(TK.RBRACKET);
          const x = this.parseBracedArg();
          return `pow(${x},1.0/(${n}))`;
        }
        const x = this.parseBracedArg();
        return `sqrt(${x})`;
      }
      case '\\left': {
        // \left( ... \right) or \left| ... \right|
        const delim = this.peek();
        if (delim.type === TK.LPAREN) {
          this.next();
          const inner = this.parseExpr();
          // consume \right)
          if (this.peek().type === TK.CMD && this.peek().val === '\\right') this.next();
          if (this.peek().type === TK.RPAREN) this.next();
          return `(${inner})`;
        }
        if (delim.type === TK.PIPE) {
          this.next();
          const inner = this.parseExpr();
          if (this.peek().type === TK.CMD && this.peek().val === '\\right') this.next();
          if (this.peek().type === TK.PIPE) this.next();
          return `abs(${inner})`;
        }
        // Unknown delimiter — skip it and parse inner
        this.next();
        return this.parseExpr();
      }
      case '\\right': {
        // Encountered stray \right — just skip the delimiter and return empty
        this.next(); // delimiter token
        return '0.0';
      }
      case '\\sin':    return `sin(${this.parseFuncArg()})`;
      case '\\cos':    return `cos(${this.parseFuncArg()})`;
      case '\\tan':    return `tan(${this.parseFuncArg()})`;
      case '\\arcsin': return `asin(${this.parseFuncArg()})`;
      case '\\arccos': return `acos(${this.parseFuncArg()})`;
      case '\\arctan': return `atan(${this.parseFuncArg()})`;
      case '\\ln':     return `log(${this.parseFuncArg()})`;
      case '\\log': {
        const arg = this.parseFuncArg();
        return `(log(${arg})/log(10.0))`;
      }
      case '\\exp':    return `exp(${this.parseFuncArg()})`;
      case '\\abs':    return `abs(${this.parseBracedArg()})`;
      case '\\pi':     return '3.141592653589793';
      case '\\cdot':
      case '\\times':  throw new CompileError('unexpected multiply operator'); // handled in parseProduct
      case '\\,':
      case '\\;':
      case '\\!':
      case '\\:':      return ''; // spacing commands — ignore
      case '\\infty':  return '1e30';

      // Greek letters → variable names (GLSL doesn't know them, but user can use x,y freely;
      // we pass through so shader code uses the same names as uniforms when needed)
      case '\\alpha':  return 'alpha';
      case '\\beta':   return 'beta';
      case '\\gamma':  return 'gamma';
      case '\\delta':  return 'delta';
      case '\\theta':  return 'theta';
      case '\\lambda': return 'lambda';
      case '\\mu':     return 'mu';
      case '\\sigma':  return 'sigma';
      case '\\omega':  return 'omega';

      default:
        throw new CompileError(`Unknown command: ${cmd}`);
    }
  }

  // Parse a trig/function argument: braced {x}, parenthesised (x), \left(x\right), or single atom
  parseFuncArg() {
    if (this.peek().type === TK.LBRACE) return this.parseBracedArg();
    if (this.peek().type === TK.LPAREN) {
      this.next();
      const inner = this.parseExpr();
      if (this.peek().type === TK.RPAREN) this.next();
      return `(${inner})`;
    }
    if (this.peek().type === TK.CMD && this.peek().val === '\\left') {
      return this.parseAtom(); // delegate to parseCommand's \left handler
    }
    return this.parseAtom();
  }
}

// ── Sum parser fix ─────────────────────────────────────────────────────────────
// The parseSum method above has a subtle bug because we advance then re-read.
// Rewrite with a cleaner loop.

Parser.prototype.parseSum = function() {
  let left = this.parseProduct();
  while (this.peek().type === TK.PLUS || this.peek().type === TK.MINUS) {
    const op = this.next().type; // TK.PLUS or TK.MINUS — already advanced
    const sign = (this.tokens[this.pos - 1].type === TK.PLUS) ? '+' : '-';
    left = `(${left}${sign}${this.parseProduct()})`;
  }
  return left;
};

// Fix: parseSum reads this.next().type which returns the type of the consumed token directly.
// Rewrite to be simple and correct:
Parser.prototype.parseSum = function() {
  let left = this.parseProduct();
  for (;;) {
    const t = this.peek();
    if (t.type === TK.PLUS) {
      this.next();
      left = `(${left}+${this.parseProduct()})`;
    } else if (t.type === TK.MINUS) {
      this.next();
      left = `(${left}-${this.parseProduct()})`;
    } else {
      break;
    }
  }
  return left;
};

function glslExpr(latex) {
  const tokens = tokenize(latex);
  const parser = new Parser(tokens);
  const result = parser.parseExpr();
  if (parser.peek().type !== TK.EOF) {
    throw new CompileError(`Unexpected content after expression: ${parser.peek().type}`);
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert a MathQuill LaTeX string to a GLSL float expression F(x,y).
 * Returns { glsl: string } on success or { error: string } on failure.
 */
function compileLatexToGlsl(latex) {
  const trimmed = latex.trim();
  if (!trimmed) return { error: 'empty' };
  try {
    const glsl = latexToGlslF(trimmed);
    return { glsl };
  } catch (e) {
    return { error: e.message };
  }
}

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

    // Maps graphId (index in active[]) → expr._exprId, updated each render
    this._lastActiveExprIds = [];

    // Snap-to-curve state
    this._holding      = false;
    this._snapExprId   = null;   // _exprId of the focused expression, or null
    this._snapPoint    = null;   // { wx, wy } in world coords, or null
    this._lastActive   = [];     // active expressions from last render()
    this._effYMin      = 0;
    this._effYMax      = 0;
    this._jsEvaluators = new Map(); // glslExpr → Function(x,y) | null

    this._initThickenShader();
    this._setupInteraction();
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
      if (exprId !== null) {
        if (this._onPick) this._onPick(exprId);
        this._holding    = true;
        this._snapExprId = exprId;
        this._updateSnap(px, py);
      }
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

  /** Convert a GLSL float expression string to a JS Function(x, y). Cached. */
  _glslToJsEvaluator(glslExpr) {
    if (this._jsEvaluators.has(glslExpr)) return this._jsEvaluators.get(glslExpr);
    const js = glslExpr
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
      this._jsEvaluators.set(glslExpr, bound);
      return bound;
    } catch {
      this._jsEvaluators.set(glslExpr, null);
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

    let F;
    for (const expr of this._lastActive) {
      if (this._snapExprId !== null && expr._exprId !== this._snapExprId) continue;
      F = this._glslToJsEvaluator(expr.glsl);
      if (!F) continue;
    }

    if(F){
      const rowA = new Float64Array(GRID + 1);
      const rowB = new Float64Array(GRID + 1);
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
            if (dsq < bestDistSq) { bestDistSq = dsq; bestPoint = pt; }
          }
          if (rowA[ix] * rowB[ix] < 0) {
            const pt = this._bisect(F, cx1, cy1, cx1, cy2, rowA[ix], rowB[ix]);
            const dsq = (pt.x - wx) ** 2 + (pt.y - wy) ** 2;
            if (dsq < bestDistSq) { bestDistSq = dsq; bestPoint = pt; }
          }
        }
        // Slide row forward
        rowA.set(rowB);
      }
    }
    else{
      console.log("cursed?")
    }

    bestPoint = this._refineNearestCurvePoint(F,bestPoint.x,bestPoint.y,wx,wy);

    return bestPoint;
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
    const pt = this._findNearestCurvePoint(canvasX, canvasY);
    this._snapPoint = pt ? { wx: pt.x, wy: pt.y } : null;
  }

  // ── Shader generation ──────────────────────────────────────────────────

  _buildThinLineFS(glslExpr) {
    return `#version 300 es
precision highp float;
in vec2 v_position;

uniform vec2 u_rangeMin;   // (xMin, yMin)
uniform vec2 u_rangeMax;   // (xMax, yMax)
uniform vec2 u_resolution; // (width, height)
uniform float u_graphId;
uniform sampler2D u_prevTex;

out vec4 FragColor;

float F(float x, float y) {
    return ${glslExpr};
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

    // Sample a 7x7 subpixel grid to detect zero crossings
    for (int yD = -3; yD < 4; yD++) {
        for (int xD = -3; xD < 4; xD++) {
            vec2 off = vec2(float(xD) / 6.0 * worldPixSize.x,
                            float(yD) / 6.0 * worldPixSize.y);
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
   * Return the cached thin-line shader entry for glslExpr, or null if it is
   * still compiling. On first call for a new expression, kicks off async GPU
   * compilation and returns null; a re-render is triggered automatically once
   * the shader is ready.
   */
  _getThinLineProgram(glslExpr) {
    if (this.thinLineShaders.has(glslExpr)) return this.thinLineShaders.get(glslExpr);
    if (this._pendingShaders.has(glslExpr)) return null; // compiling

    try {
      const handle = GL.beginShaderProgram(this.gl, GL.GENERIC_VS, this._buildThinLineFS(glslExpr));
      this._pendingShaders.set(glslExpr, handle);
    } catch (e) {
      console.warn('[GraphRenderer] shader init failed:', e.message);
      this._pendingShaders.set(glslExpr, null); // mark failed so we don't retry
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

    for (const [glslExpr, handle] of this._pendingShaders) {
      if (!handle) { this._pendingShaders.delete(glslExpr); continue; }

      // With KHR_parallel_shader_compile, COMPLETION_STATUS_KHR returns false
      // without blocking if still compiling. Without the extension, we just
      // finalize immediately (getProgramParameter will block, but the GPU has
      // had at least one rAF to compile in parallel).
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
        };
        this.thinLineShaders.set(glslExpr, entry);
        anyCompleted = true;
      } catch (e) {
        console.warn('[GraphRenderer] shader compile failed:', e.message);
      }
      this._pendingShaders.delete(glslExpr);
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
   * Render a set of graph expressions.
   * @param {Array<{glsl: string, color: string, enabled: boolean}>} expressions
   * @param {number} width   Canvas pixel width
   * @param {number} height  Canvas pixel height
   */
  render(expressions, width, height, lightTheme) {
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

    // Collect enabled expressions and their colors
    const active = [];
    for (const expr of expressions) {
      if (!expr.enabled || !expr.glsl) continue;
      active.push(expr);
    }

    // Pass 1: Thin-line pass for each graph, stacking into one buffer
    gl.bindVertexArray(this.vao);
    for (let i = 0; i < active.length; i++) {
      const entry = this._getThinLineProgram(active[i].glsl);
      if (!entry) continue;

      gl.useProgram(entry.program);
      gl.viewport(0, 0, width, height);

      gl.uniform2f(entry.u_rangeMin, this.xMin, effYMin);
      gl.uniform2f(entry.u_rangeMax, this.xMax, effYMax);
      gl.uniform2f(entry.u_resolution, width, height);
      gl.uniform1f(entry.u_graphId, i);
      gl.uniform1i(entry.u_prevTex, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, img.frontTex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, img.backFb);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      img.swapBuffers();
    }

    // Store expr id mapping for pick queries (graphId → _exprId)
    this._lastActiveExprIds = active.map(e => e._exprId || null);

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
    for (const handle of this._pendingShaders.values()) {
      if (handle) {
        gl.deleteProgram(handle.program);
        gl.deleteShader(handle.vs);
        gl.deleteShader(handle.fs);
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

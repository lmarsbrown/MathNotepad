'use strict';

// ── LaTeX → AST compiler & expression analysis ─────────────────────────────
//
// Parses MathQuill LaTeX expressions into ASTs, classifies them as definitions
// or implicit equations, tracks dependencies, evaluates constants on the CPU,
// and generates GLSL with uniforms for constants and inlined xy-dependent defs.
//
// AST node types:
//   Leaf:     { type: 'number', value: <float> }
//             { type: 'variable', name: <string> }
//   Internal: { type: 'call', name: <string>, args: [<node>, ...] }
//     name is one of: 'add', 'sub', 'mul', 'div', 'pow', 'neg',
//                     'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
//                     'ln', 'log', 'exp', 'abs', 'sqrt'

class CompileError extends Error {
  constructor(msg) { super(msg); this.name = 'CompileError'; }
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
    if (t.type === TK.CMD && t.val === '\\right') return true;
    return false;
  }

  parseExpr() { return this.parseSum(); }

  parseSum() {
    let left = this.parseProduct();
    for (;;) {
      const t = this.peek();
      if (t.type === TK.PLUS) {
        this.next();
        left = { type: 'call', name: 'add', args: [left, this.parseProduct()] };
      } else if (t.type === TK.MINUS) {
        this.next();
        left = { type: 'call', name: 'sub', args: [left, this.parseProduct()] };
      } else {
        break;
      }
    }
    return left;
  }

  parseProduct() {
    let left = this.parseUnary();
    while (!this.atExprEnd() && this.peek().type !== TK.PLUS && this.peek().type !== TK.MINUS) {
      const nextType = this.peek().type;
      if (nextType === TK.PLUS || nextType === TK.MINUS || nextType === TK.EOF ||
          nextType === TK.RBRACE || nextType === TK.RPAREN || nextType === TK.RBRACKET ||
          nextType === TK.PIPE) break;
      if (nextType === TK.STAR) { this.next(); }
      else if (nextType === TK.CMD && (this.peek().val === '\\cdot' || this.peek().val === '\\times')) {
        this.next();
      }
      left = { type: 'call', name: 'mul', args: [left, this.parseUnary()] };
    }
    return left;
  }

  parseUnary() {
    if (this.peek().type === TK.MINUS) {
      this.next();
      return { type: 'call', name: 'neg', args: [this.parsePower()] };
    }
    return this.parsePower();
  }

  parsePower() {
    let base = this.parseAtom();
    if (this.peek().type === TK.CARET) {
      this.next();
      const exp = this.parseAtom();
      base = { type: 'call', name: 'pow', args: [base, exp] };
    }
    return base;
  }

  parseAtom() {
    const t = this.peek();

    // Number
    if (t.type === TK.NUM) {
      this.next();
      return { type: 'number', value: parseFloat(t.val) };
    }

    // Parenthesised group
    if (t.type === TK.LPAREN) {
      this.next();
      const inner = this.parseExpr();
      if (this.peek().type === TK.RPAREN) this.next();
      return inner;
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
      return { type: 'call', name: 'abs', args: [inner] };
    }

    // Command
    if (t.type === TK.CMD) return this.parseCommand();

    // Identifier (single letter variable or constant)
    if (t.type === TK.IDENT) {
      this.next();
      const v = t.val;
      if (v === 'e') return { type: 'number', value: Math.E };
      return { type: 'variable', name: v };
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
    return this.parseAtom();
  }

  parseCommand() {
    const cmd = this.next().val;

    switch (cmd) {
      case '\\frac': {
        const num = this.parseBracedArg();
        const den = this.parseBracedArg();
        return { type: 'call', name: 'div', args: [num, den] };
      }
      case '\\sqrt': {
        if (this.peek().type === TK.LBRACKET) {
          this.next();
          const n = this.parseExpr();
          this.eat(TK.RBRACKET);
          const x = this.parseBracedArg();
          return { type: 'call', name: 'pow', args: [x, { type: 'call', name: 'div', args: [{ type: 'number', value: 1 }, n] }] };
        }
        const x = this.parseBracedArg();
        return { type: 'call', name: 'sqrt', args: [x] };
      }
      case '\\left': {
        const delim = this.peek();
        if (delim.type === TK.LPAREN) {
          this.next();
          const inner = this.parseExpr();
          if (this.peek().type === TK.CMD && this.peek().val === '\\right') this.next();
          if (this.peek().type === TK.RPAREN) this.next();
          return inner;
        }
        if (delim.type === TK.PIPE) {
          this.next();
          const inner = this.parseExpr();
          if (this.peek().type === TK.CMD && this.peek().val === '\\right') this.next();
          if (this.peek().type === TK.PIPE) this.next();
          return { type: 'call', name: 'abs', args: [inner] };
        }
        this.next();
        return this.parseExpr();
      }
      case '\\right': {
        this.next();
        return { type: 'number', value: 0 };
      }
      case '\\sin':    return { type: 'call', name: 'sin', args: [this.parseFuncArg()] };
      case '\\cos':    return { type: 'call', name: 'cos', args: [this.parseFuncArg()] };
      case '\\tan':    return { type: 'call', name: 'tan', args: [this.parseFuncArg()] };
      case '\\arcsin': return { type: 'call', name: 'asin', args: [this.parseFuncArg()] };
      case '\\arccos': return { type: 'call', name: 'acos', args: [this.parseFuncArg()] };
      case '\\arctan': return { type: 'call', name: 'atan', args: [this.parseFuncArg()] };
      case '\\ln':     return { type: 'call', name: 'ln', args: [this.parseFuncArg()] };
      case '\\log': {
        const arg = this.parseFuncArg();
        return { type: 'call', name: 'div', args: [
          { type: 'call', name: 'ln', args: [arg] },
          { type: 'call', name: 'ln', args: [{ type: 'number', value: 10 }] }
        ]};
      }
      case '\\exp':    return { type: 'call', name: 'exp', args: [this.parseFuncArg()] };
      case '\\abs':    return { type: 'call', name: 'abs', args: [this.parseBracedArg()] };
      case '\\pi':     return { type: 'number', value: Math.PI };
      case '\\cdot':
      case '\\times':  throw new CompileError('unexpected multiply operator');
      case '\\,':
      case '\\;':
      case '\\!':
      case '\\:': {
        // Spacing commands — skip. If more tokens follow, parse the next atom.
        if (this.atExprEnd()) return { type: 'number', value: 0 };
        return this.parseAtom();
      }
      case '\\infty':  return { type: 'number', value: 1e30 };

      // Greek letters → variables
      case '\\alpha':  return { type: 'variable', name: 'alpha' };
      case '\\beta':   return { type: 'variable', name: 'beta' };
      case '\\gamma':  return { type: 'variable', name: 'gamma' };
      case '\\delta':  return { type: 'variable', name: 'delta' };
      case '\\theta':  return { type: 'variable', name: 'theta' };
      case '\\lambda': return { type: 'variable', name: 'lambda' };
      case '\\mu':     return { type: 'variable', name: 'mu' };
      case '\\sigma':  return { type: 'variable', name: 'sigma' };
      case '\\omega':  return { type: 'variable', name: 'omega' };

      default:
        throw new CompileError(`Unknown command: ${cmd}`);
    }
  }

  parseFuncArg() {
    if (this.peek().type === TK.LBRACE) return this.parseBracedArg();
    if (this.peek().type === TK.LPAREN) {
      this.next();
      const inner = this.parseExpr();
      if (this.peek().type === TK.RPAREN) this.next();
      return inner;
    }
    if (this.peek().type === TK.CMD && this.peek().val === '\\left') {
      return this.parseAtom();
    }
    return this.parseAtom();
  }
}

// ── AST utilities ────────────────────────────────────────────────────────────

/** Parse a LaTeX string into an AST. Throws CompileError on failure. */
function parseLatexToAst(latex) {
  const tokens = tokenize(latex);
  const parser = new Parser(tokens);
  const result = parser.parseExpr();
  if (parser.peek().type !== TK.EOF) {
    throw new CompileError(`Unexpected content after expression`);
  }
  return result;
}

/** Collect all variable names referenced in an AST. Returns a Set<string>. */
function collectVariables(ast) {
  const vars = new Set();
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'variable') vars.add(node.name);
    else if (node.type === 'call') for (const a of node.args) stack.push(a);
  }
  return vars;
}

// Known built-in names that are not user-defined variables
const BUILTIN_VARS = new Set(['x', 'y']);

// ── Expression parsing & classification ─────────────────────────────────────

/**
 * Parse one LaTeX expression containing '='.
 * Returns { lhs: AST, rhs: AST } or { error: string }.
 */
function parseExpression(latex) {
  const trimmed = latex.trim();
  if (!trimmed) return { error: 'empty' };
  const eqIdx = findEqAtDepth0(trimmed);
  if (eqIdx === -1) return { error: 'Expression must contain =' };
  try {
    const lhs = parseLatexToAst(trimmed.slice(0, eqIdx).trim());
    const rhs = parseLatexToAst(trimmed.slice(eqIdx + 1).trim());
    return { lhs, rhs };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Classify a parsed expression as a definition or implicit equation.
 * A definition has a single variable (not x or y) on the LHS.
 */
function classifyExpression(parsed) {
  const { lhs, rhs } = parsed;
  // Definition: LHS is a single variable not x or y
  if (lhs.type === 'variable' && !BUILTIN_VARS.has(lhs.name)) {
    const deps = collectVariables(rhs);
    deps.delete('x');
    deps.delete('y');
    const allVars = collectVariables(rhs);
    const dependsOnXY = allVars.has('x') || allVars.has('y');
    return { kind: 'definition', name: lhs.name, rhs, deps, dependsOnXY };
  }
  // Implicit equation
  const allVars = new Set([...collectVariables(lhs), ...collectVariables(rhs)]);
  const deps = new Set(allVars);
  deps.delete('x');
  deps.delete('y');
  return { kind: 'implicit', lhs, rhs, deps, allVars };
}

/**
 * Analyze all expressions in a graph box: resolve dependencies, detect errors,
 * classify definitions as constants vs xy-dependent.
 *
 * @param {Array} classifiedList - Array of { kind, exprId, ... } objects
 * @returns {Object} Analysis result
 */
function analyzeExpressions(classifiedList) {
  const errors = new Map();       // exprId → error string
  const defsMap = new Map();      // variable name → { rhs, deps, dependsOnXY, exprId }

  // Build definitions map. If a variable is defined more than once,
  // the first definition wins and subsequent ones are reclassified as implicit.
  const reclassified = [];
  for (const expr of classifiedList) {
    if (expr.kind === 'error') {
      errors.set(expr.exprId, expr.error);
      continue;
    }
    if (expr.kind === 'definition') {
      if (defsMap.has(expr.name)) {
        // Reclassify as implicit: treat "f = 1" as the equation f - 1 = 0
        const lhs = { type: 'variable', name: expr.name };
        const allVars = new Set([...collectVariables(lhs), ...collectVariables(expr.rhs)]);
        const deps = new Set(allVars);
        deps.delete('x');
        deps.delete('y');
        reclassified.push({ kind: 'implicit', lhs, rhs: expr.rhs, deps, allVars, exprId: expr.exprId });
        continue;
      }
      defsMap.set(expr.name, {
        rhs: expr.rhs,
        deps: expr.deps,
        dependsOnXY: expr.dependsOnXY,
        exprId: expr.exprId,
      });
    }
  }
  // Add reclassified expressions back so they're processed as implicits
  classifiedList = [...classifiedList, ...reclassified];

  // Resolve dependencies: detect circular refs, undefined vars, compute depth,
  // and propagate xy-dependency
  const resolved = new Map();  // name → { depth, dependsOnXY, error }
  const resolving = new Set(); // currently on the path (for cycle detection)

  function resolve(name) {
    if (resolved.has(name)) return resolved.get(name);
    if (BUILTIN_VARS.has(name)) {
      const r = { depth: 0, dependsOnXY: true, error: null };
      resolved.set(name, r);
      return r;
    }
    if (!defsMap.has(name)) {
      return { depth: 0, dependsOnXY: false, error: `Undefined variable '${name}'` };
    }
    if (resolving.has(name)) {
      return { depth: 0, dependsOnXY: false, error: `Circular dependency on '${name}'` };
    }

    resolving.add(name);
    const def = defsMap.get(name);
    let maxDepth = 0;
    let depOnXY = def.dependsOnXY;
    let error = null;

    for (const dep of def.deps) {
      const r = resolve(dep);
      if (r.error) {
        error = r.error;
        break;
      }
      if (r.dependsOnXY) depOnXY = true;
      maxDepth = Math.max(maxDepth, r.depth + 1);
    }

    resolving.delete(name);
    const result = { depth: maxDepth, dependsOnXY: depOnXY, error };
    resolved.set(name, result);
    return result;
  }

  // Resolve all definitions
  for (const [name, def] of defsMap) {
    const r = resolve(name);
    if (r.error) {
      errors.set(def.exprId, r.error);
    }
  }

  // Separate definitions into constants and xy-dependent
  const constants = [];
  const xyDefs = [];
  for (const [name, def] of defsMap) {
    if (errors.has(def.exprId)) continue;
    const r = resolved.get(name);
    if (r.dependsOnXY) {
      xyDefs.push({ name, rhs: def.rhs, deps: def.deps, depth: r.depth, exprId: def.exprId });
    } else {
      constants.push({ name, rhs: def.rhs, depth: r.depth, exprId: def.exprId });
    }
  }

  // Sort constants by depth (ascending) so dependencies are evaluated first
  constants.sort((a, b) => a.depth - b.depth);
  // Sort xyDefs by depth too for proper ordering in shader
  xyDefs.sort((a, b) => a.depth - b.depth);

  // Validate implicit expressions
  const implicits = [];
  for (const expr of classifiedList) {
    if (expr.kind !== 'implicit') continue;
    if (errors.has(expr.exprId)) continue;

    // Check for undefined variables and propagate xy-dependency
    let depOnXY = expr.allVars.has('x') || expr.allVars.has('y');
    let exprError = null;
    for (const dep of expr.deps) {
      const r = resolve(dep);
      if (r.error) { exprError = r.error; break; }
      if (r.dependsOnXY) depOnXY = true;
    }
    if (exprError) {
      errors.set(expr.exprId, exprError);
      continue;
    }
    if (!depOnXY) {
      errors.set(expr.exprId, 'Expression does not depend on x or y');
      continue;
    }
    implicits.push({ lhs: expr.lhs, rhs: expr.rhs, deps: expr.deps, exprId: expr.exprId });
  }

  return {
    constants,
    xyDefs,
    implicits,
    errors,
    constantValues: new Map(),
    defsMap,
    resolved,
  };
}

// ── Constant evaluation (CPU) ───────────────────────────────────────────────

/** Evaluate an AST node to a numeric value, given a map of known values. */
function evaluateAst(ast, values) {
  switch (ast.type) {
    case 'number': return ast.value;
    case 'variable': {
      if (values.has(ast.name)) return values.get(ast.name);
      throw new Error(`Undefined variable '${ast.name}' during evaluation`);
    }
    case 'call': {
      const args = ast.args.map(a => evaluateAst(a, values));
      switch (ast.name) {
        case 'add': return args[0] + args[1];
        case 'sub': return args[0] - args[1];
        case 'mul': return args[0] * args[1];
        case 'div': return args[0] / args[1];
        case 'pow': return Math.pow(args[0], args[1]);
        case 'neg': return -args[0];
        case 'sin': return Math.sin(args[0]);
        case 'cos': return Math.cos(args[0]);
        case 'tan': return Math.tan(args[0]);
        case 'asin': return Math.asin(args[0]);
        case 'acos': return Math.acos(args[0]);
        case 'atan': return Math.atan(args[0]);
        case 'ln':  return Math.log(args[0]);
        case 'exp': return Math.exp(args[0]);
        case 'abs': return Math.abs(args[0]);
        case 'sqrt': return Math.sqrt(args[0]);
        default: throw new Error(`Unknown function '${ast.name}'`);
      }
    }
    default: throw new Error(`Unknown AST node type '${ast.type}'`);
  }
}

/**
 * Evaluate all constant definitions in the analysis.
 * Iterates in dependency-depth order so all deps are available.
 * Stores results in analysis.constantValues.
 */
function evaluateConstants(analysis) {
  analysis.constantValues.clear();
  for (const c of analysis.constants) {
    try {
      const val = evaluateAst(c.rhs, analysis.constantValues);
      analysis.constantValues.set(c.name, val);
    } catch (e) {
      analysis.errors.set(c.exprId, e.message);
    }
  }
}

// ── AST → GLSL code generation ──────────────────────────────────────────────

/** Convert an AST to a GLSL float expression string. */
function astToGlsl(ast, constantNames, xyDefNames) {
  switch (ast.type) {
    case 'number': {
      const s = ast.value.toString();
      return s.includes('.') || s.includes('e') ? s : s + '.0';
    }
    case 'variable': {
      if (ast.name === 'x' || ast.name === 'y') return ast.name;
      if (constantNames.has(ast.name)) return 'u_' + ast.name;
      if (xyDefNames.has(ast.name)) return 'v_' + ast.name;
      return ast.name; // fallback — should be caught by analysis
    }
    case 'call': {
      const args = ast.args.map(a => astToGlsl(a, constantNames, xyDefNames));
      switch (ast.name) {
        case 'add': return `(${args[0]}+${args[1]})`;
        case 'sub': return `(${args[0]}-${args[1]})`;
        case 'mul': return `(${args[0]}*${args[1]})`;
        case 'div': return `(${args[0]}/${args[1]})`;
        case 'pow': return `pow(${args[0]},${args[1]})`;
        case 'neg': return `(-(${args[0]}))`;
        case 'sin': return `sin(${args[0]})`;
        case 'cos': return `cos(${args[0]})`;
        case 'tan': return `tan(${args[0]})`;
        case 'asin': return `asin(${args[0]})`;
        case 'acos': return `acos(${args[0]})`;
        case 'atan': return `atan(${args[0]})`;
        case 'ln':  return `log(${args[0]})`;
        case 'exp': return `exp(${args[0]})`;
        case 'abs': return `abs(${args[0]})`;
        case 'sqrt': return `sqrt(${args[0]})`;
        default: return `${ast.name}(${args.join(',')})`;
      }
    }
    default: return '0.0';
  }
}

/** Build an AST → JS evaluator function(x, y) with constant values baked in. */
function astToJsFunction(ast, constantValues) {
  function gen(node) {
    switch (node.type) {
      case 'number': return String(node.value);
      case 'variable': {
        if (node.name === 'x') return 'x';
        if (node.name === 'y') return 'y';
        if (constantValues.has(node.name)) return String(constantValues.get(node.name));
        return '0'; // fallback
      }
      case 'call': {
        const args = node.args.map(gen);
        switch (node.name) {
          case 'add': return `(${args[0]}+${args[1]})`;
          case 'sub': return `(${args[0]}-${args[1]})`;
          case 'mul': return `(${args[0]}*${args[1]})`;
          case 'div': return `(${args[0]}/${args[1]})`;
          case 'pow': return `Math.pow(${args[0]},${args[1]})`;
          case 'neg': return `(-(${args[0]}))`;
          case 'sin': return `Math.sin(${args[0]})`;
          case 'cos': return `Math.cos(${args[0]})`;
          case 'tan': return `Math.tan(${args[0]})`;
          case 'asin': return `Math.asin(${args[0]})`;
          case 'acos': return `Math.acos(${args[0]})`;
          case 'atan': return `Math.atan(${args[0]})`;
          case 'ln':  return `Math.log(${args[0]})`;
          case 'exp': return `Math.exp(${args[0]})`;
          case 'abs': return `Math.abs(${args[0]})`;
          case 'sqrt': return `Math.sqrt(${args[0]})`;
          default: return '0';
        }
      }
      default: return '0';
    }
  }
  const body = gen(ast);
  try {
    return new Function('x', 'y', `"use strict"; return (${body});`);
  } catch {
    return null;
  }
}

/**
 * Generate shader code for an implicit expression, given the analysis context.
 * Returns { shaderKey, uniformDecls, bodyCode, fExpr, constantUniforms }
 * where constantUniforms is an array of { name, glslName } for uniform uploading.
 */
function generateShaderCode(implicitExpr, analysis) {
  // Collect which constants and xy-defs this expression needs
  const neededConstants = new Set();
  const neededXYDefs = new Set();

  function collectNeeds(deps) {
    for (const dep of deps) {
      if (analysis.constantValues.has(dep)) {
        neededConstants.add(dep);
      } else {
        // It's an xy-dependent definition — collect it and its own needs
        const xyDef = analysis.xyDefs.find(d => d.name === dep);
        if (xyDef && !neededXYDefs.has(dep)) {
          neededXYDefs.add(dep);
          collectNeeds(xyDef.deps);
        }
      }
    }
  }

  collectNeeds(implicitExpr.deps);

  const constantNames = neededConstants;
  const xyDefNames = neededXYDefs;

  // Build uniform declarations
  const uniformDecls = [...neededConstants].map(name => `uniform float u_${name};`).join('\n');

  // Build xy-dependent variable definitions (sorted by depth)
  const sortedXYDefs = analysis.xyDefs
    .filter(d => neededXYDefs.has(d.name))
    .sort((a, b) => a.depth - b.depth);

  const bodyLines = sortedXYDefs.map(d => {
    const glsl = astToGlsl(d.rhs, constantNames, xyDefNames);
    return `float v_${d.name} = ${glsl};`;
  });
  const bodyCode = bodyLines.join('\n    ');

  // Generate the F = LHS - RHS expression
  const lhsGlsl = astToGlsl(implicitExpr.lhs, constantNames, xyDefNames);
  const rhsGlsl = astToGlsl(implicitExpr.rhs, constantNames, xyDefNames);
  const fExpr = `(${lhsGlsl})-(${rhsGlsl})`;

  // Shader cache key: full shader content determines uniqueness
  const shaderKey = uniformDecls + '|' + bodyCode + '|' + fExpr;

  const constantUniforms = [...neededConstants].map(name => ({ name, glslName: 'u_' + name }));

  return { shaderKey, uniformDecls, bodyCode, fExpr, constantUniforms };
}

// ── Public API: batch analysis of all expressions in a graph box ────────────

/**
 * Analyze all expressions in a graph box and prepare for rendering.
 * Returns { analysis, renderExprs } where renderExprs is an array of
 * { exprId, shaderInfo, enabled, color, thickness } ready for the renderer,
 * or null if the expression has an error.
 *
 * Also returns jsEvaluators: Map<exprId, Function(x,y)> for snap-to-curve.
 */
function compileGraphExpressions(expressions) {
  // 1. Parse all expressions
  const parsed = expressions.map(e => {
    if (!e.enabled) return { kind: 'disabled', exprId: e.id };
    const p = parseExpression(e.latex);
    if (p.error) return { kind: 'error', error: p.error, exprId: e.id };
    const classified = classifyExpression(p);
    classified.exprId = e.id;
    return classified;
  });

  // 2. Analyze dependencies
  const active = parsed.filter(p => p.kind !== 'disabled');
  const analysis = analyzeExpressions(active);

  // 3. Evaluate constants
  evaluateConstants(analysis);

  // 4. Generate shader code for each implicit expression
  const renderExprs = [];
  const jsEvaluators = new Map();

  for (const impl of analysis.implicits) {
    const expr = expressions.find(e => e.id === impl.exprId);
    if (!expr) continue;

    const shaderInfo = generateShaderCode(impl, analysis);

    // Build JS evaluator for snap-to-curve (inline xy-defs and constants)
    const fAst = { type: 'call', name: 'sub', args: [impl.lhs, impl.rhs] };
    // For JS evaluation, we need to inline xy-dependent defs too
    // We build an evaluator that computes xy-defs then F
    const jsFunc = buildImplicitJsEvaluator(impl, analysis);
    if (jsFunc) jsEvaluators.set(impl.exprId, jsFunc);

    renderExprs.push({
      exprId: impl.exprId,
      shaderInfo,
      color: expr.color,
      enabled: true,
      thickness: expr.thickness != null ? expr.thickness : 2.0,
    });
  }

  return { analysis, renderExprs, jsEvaluators };
}

/**
 * Build a JS function(x,y) that evaluates an implicit expression,
 * including all its xy-dependent definitions and constants.
 */
function buildImplicitJsEvaluator(implicitExpr, analysis) {
  const constantValues = analysis.constantValues;

  // Collect needed xy-defs in depth order
  const neededXYDefs = [];
  const visited = new Set();
  function collectXYDeps(deps) {
    for (const dep of deps) {
      if (visited.has(dep) || constantValues.has(dep) || BUILTIN_VARS.has(dep)) continue;
      const xyDef = analysis.xyDefs.find(d => d.name === dep);
      if (xyDef) {
        visited.add(dep);
        collectXYDeps(xyDef.deps);
        neededXYDefs.push(xyDef);
      }
    }
  }
  collectXYDeps(implicitExpr.deps);

  // Build JS function body: define xy-dep vars then return LHS - RHS
  function genJs(node) {
    switch (node.type) {
      case 'number': return String(node.value);
      case 'variable': {
        if (node.name === 'x') return 'x';
        if (node.name === 'y') return 'y';
        if (constantValues.has(node.name)) return String(constantValues.get(node.name));
        // xy-dependent def — use local var
        return 'v_' + node.name;
      }
      case 'call': {
        const args = node.args.map(genJs);
        switch (node.name) {
          case 'add': return `(${args[0]}+${args[1]})`;
          case 'sub': return `(${args[0]}-${args[1]})`;
          case 'mul': return `(${args[0]}*${args[1]})`;
          case 'div': return `(${args[0]}/${args[1]})`;
          case 'pow': return `Math.pow(${args[0]},${args[1]})`;
          case 'neg': return `(-(${args[0]}))`;
          case 'sin': return `Math.sin(${args[0]})`;
          case 'cos': return `Math.cos(${args[0]})`;
          case 'tan': return `Math.tan(${args[0]})`;
          case 'asin': return `Math.asin(${args[0]})`;
          case 'acos': return `Math.acos(${args[0]})`;
          case 'atan': return `Math.atan(${args[0]})`;
          case 'ln':  return `Math.log(${args[0]})`;
          case 'exp': return `Math.exp(${args[0]})`;
          case 'abs': return `Math.abs(${args[0]})`;
          case 'sqrt': return `Math.sqrt(${args[0]})`;
          default: return '0';
        }
      }
      default: return '0';
    }
  }

  let body = '';
  for (const d of neededXYDefs) {
    body += `var v_${d.name} = ${genJs(d.rhs)};\n`;
  }
  body += `return (${genJs(implicitExpr.lhs)})-(${genJs(implicitExpr.rhs)});`;

  try {
    return new Function('x', 'y', `"use strict";\n${body}`);
  } catch {
    return null;
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

    // Maps graphId (index in active[]) → expr.exprId, updated each render
    this._lastActiveExprIds = [];

    // Snap-to-curve state
    this._holding      = false;
    this._snapExprId   = null;   // exprId of the focused expression, or null
    this._snapPoint    = null;   // { wx, wy } in world coords, or null
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

    let F;
    for (const expr of this._lastActive) {
      if (this._snapExprId !== null && expr.exprId !== this._snapExprId) continue;
      F = this._getJsEvaluator(expr);
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

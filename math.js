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

// ── Physics constants ─────────────────────────────────────────────────────────
// Each entry: { varName, value, label, description }
//   varName     — normalized internal name used in the evaluator's values map.
//                 Must match what parseLatexToAst returns for the corresponding
//                 LaTeX (e.g. 'q_e' for MQ latex 'q_e', 'hbar' for '\hbar').
//   value       — SI numeric value
//   label       — short human-readable name shown in tooltips
//   description — units / full name shown in tooltips
//
// To add a constant: append to the appropriate group below.
const PHYSICS_CONSTANTS_BASIC = [
  { varName: 'c',         value: 2.99792458e8,     label: 'c',    description: 'Speed of light (2.998×10⁸ m/s)',                         unitDims: { m: 1, s: -1 } },
  { varName: 'g',         value: 9.80665,           label: 'g',    description: 'Standard gravity (9.807 m/s²)',                          unitDims: { m: 1, s: -2 } },
  { varName: 'G',         value: 6.67430e-11,       label: 'G',    description: 'Gravitational constant (6.674×10⁻¹¹ N·m²/kg²)',         unitDims: { N: 1, m: 2, kg: -2 } },
  { varName: 'h',         value: 6.62607015e-34,    label: 'h',    description: 'Planck constant (6.626×10⁻³⁴ J·s)',                     unitDims: { J: 1, s: 1 } },
  { varName: 'hbar',      value: 1.054571817e-34,   label: 'ℏ',    description: 'Reduced Planck constant (1.055×10⁻³⁴ J·s)',             unitDims: { J: 1, s: 1 } },
  { varName: 'm_e',       value: 9.1093837015e-31,  label: 'm_e',  description: 'Electron mass (9.109×10⁻³¹ kg)',                       unitDims: { kg: 1 } },
  { varName: 'm_p',       value: 1.67262192369e-27, label: 'm_p',  description: 'Proton mass (1.673×10⁻²⁷ kg)',                         unitDims: { kg: 1 } },
  { varName: 'sigma',     value: 5.670374419e-8,    label: 'σ',    description: 'Stefan–Boltzmann constant (5.670×10⁻⁸ W/(m²·K⁴))',    unitDims: { W: 1, m: -2, K: -4 } },
];

const PHYSICS_CONSTANTS_EM = [
  { varName: 'q_e',       value: 1.602176634e-19,  label: 'q_e',  description: 'Elementary charge (1.602×10⁻¹⁹ C)',                    unitDims: { C: 1 } },
  { varName: 'epsilon_0', value: 8.8541878128e-12, label: 'ε₀',   description: 'Permittivity of free space (8.854×10⁻¹² F/m)',         unitDims: { F: 1, m: -1 } },
  { varName: 'mu_0',      value: 1.25663706212e-6, label: 'μ₀',   description: 'Permeability of free space (1.257×10⁻⁶ H/m)',          unitDims: { H: 1, m: -1 } },
  { varName: 'alpha',     value: 7.2973525693e-3,  label: 'α',    description: 'Fine-structure constant (≈ 1/137)',                     unitDims: {} },
];

const PHYSICS_CONSTANTS_CHEM = [
  { varName: 'R',         value: 8.314462618,      label: 'R',    description: 'Ideal gas constant (8.314 J/(mol·K))',                  unitDims: { J: 1, mol: -1, K: -1 } },
  { varName: 'k_B',       value: 1.380649e-23,     label: 'k_B',  description: 'Boltzmann constant (1.381×10⁻²³ J/K)',                 unitDims: { J: 1, K: -1 } },
  { varName: 'N_A',       value: 6.02214076e23,    label: 'N_A',  description: 'Avogadro\'s number (6.022×10²³ mol⁻¹)',                unitDims: { mol: -1 } },
];

// Combined — used for legacy deserialization and tooltip building.
const PHYSICS_CONSTANTS = [...PHYSICS_CONSTANTS_BASIC, ...PHYSICS_CONSTANTS_EM, ...PHYSICS_CONSTANTS_CHEM];

// ── SI Units ──────────────────────────────────────────────────────────────────
// Base SI units — treated as symbolic atoms in units mode.
const SI_BASE_UNITS = new Set(['m', 's', 'kg', 'A', 'K', 'mol', 'cd']);

// Derived SI units — expanded to base units at evaluation time.
// Each entry: { coeff: number, units: { [baseUnit]: exponent } }
const DERIVED_UNIT_EXPANSIONS = {
  N:   { coeff: 1,    units: { kg: 1, m: 1, s: -2 } },
  J:   { coeff: 1,    units: { kg: 1, m: 2, s: -2 } },
  W:   { coeff: 1,    units: { kg: 1, m: 2, s: -3 } },
  Pa:  { coeff: 1,    units: { kg: 1, m: -1, s: -2 } },
  Hz:  { coeff: 1,    units: { s: -1 } },
  V:   { coeff: 1,    units: { kg: 1, m: 2, s: -3, A: -1 } },
  C:   { coeff: 1,    units: { s: 1, A: 1 } },
  F:   { coeff: 1,    units: { kg: -1, m: -2, s: 4, A: 2 } },
  H:   { coeff: 1,    units: { kg: 1, m: 2, s: -2, A: -2 } },
  T:   { coeff: 1,    units: { kg: 1, s: -2, A: -1 } },
  Wb:  { coeff: 1,    units: { kg: 1, m: 2, s: -2, A: -1 } },
  rad: { coeff: 1,    units: {} },
  'Ω':  { coeff: 1,    units: { kg: 1, m: 2, s: -3, A: -2 } },
  // Liter-based volume units (enabled only when chemistry mode is active).
  μL:  { coeff: 1e-9, units: { m: 3 } },
  mL:  { coeff: 1e-6, units: { m: 3 } },
  L:   { coeff: 1e-3, units: { m: 3 } },
};

// Unit names only valid when chemistry mode is active (L conflicts with length variable).
const CHEM_ONLY_UNITS = new Set(['μL', 'mL', 'L']);

// Scaled / prefixed unit atoms. Same format as DERIVED_UNIT_EXPANSIONS.
// Base units (m, s, kg, A) and unscaled derived units (N, J, Pa, …) are NOT duplicated here.
const SCALED_UNIT_ATOMS = {
  // Length
  nm:  { coeff: 1e-9,      units: { m: 1 } },
  μm:  { coeff: 1e-6,      units: { m: 1 } },
  mm:  { coeff: 1e-3,      units: { m: 1 } },
  cm:  { coeff: 0.01,      units: { m: 1 } },
  km:  { coeff: 1e3,       units: { m: 1 } },
  // Time (small)
  ns:  { coeff: 1e-9,      units: { s: 1 } },
  μs:  { coeff: 1e-6,      units: { s: 1 } },
  ms:  { coeff: 1e-3,      units: { s: 1 } },
  // Time (large, non-SI)
  min: { coeff: 60,        units: { s: 1 } },
  hr:  { coeff: 3600,      units: { s: 1 } },
  day: { coeff: 86400,     units: { s: 1 } },
  yr:  { coeff: 3.15576e7, units: { s: 1 } },
  // Mass (relative to kg)
  μg:  { coeff: 1e-9,      units: { kg: 1 } },
  mg:  { coeff: 1e-6,      units: { kg: 1 } },
  g:   { coeff: 1e-3,      units: { kg: 1 } },
  // Current (relative to A)
  μA:  { coeff: 1e-6,      units: { A: 1 } },
  mA:  { coeff: 1e-3,      units: { A: 1 } },
  // Energy (relative to J = kg·m²·s⁻²)
  nJ:  { coeff: 1e-9,      units: { kg: 1, m: 2, s: -2 } },
  μJ:  { coeff: 1e-6,      units: { kg: 1, m: 2, s: -2 } },
  mJ:  { coeff: 1e-3,      units: { kg: 1, m: 2, s: -2 } },
  kJ:  { coeff: 1e3,       units: { kg: 1, m: 2, s: -2 } },
  MJ:  { coeff: 1e6,       units: { kg: 1, m: 2, s: -2 } },
  GJ:  { coeff: 1e9,       units: { kg: 1, m: 2, s: -2 } },
  TJ:  { coeff: 1e12,      units: { kg: 1, m: 2, s: -2 } },
  PJ:  { coeff: 1e15,      units: { kg: 1, m: 2, s: -2 } },
  // Power (relative to W = kg·m²·s⁻³)
  nW:  { coeff: 1e-9,      units: { kg: 1, m: 2, s: -3 } },
  μW:  { coeff: 1e-6,      units: { kg: 1, m: 2, s: -3 } },
  mW:  { coeff: 1e-3,      units: { kg: 1, m: 2, s: -3 } },
  kW:  { coeff: 1e3,       units: { kg: 1, m: 2, s: -3 } },
  MW:  { coeff: 1e6,       units: { kg: 1, m: 2, s: -3 } },
  GW:  { coeff: 1e9,       units: { kg: 1, m: 2, s: -3 } },
  TW:  { coeff: 1e12,      units: { kg: 1, m: 2, s: -3 } },
  // Force (relative to N = kg·m·s⁻²)
  mN:  { coeff: 1e-3,      units: { kg: 1, m: 1, s: -2 } },
  kN:  { coeff: 1e3,       units: { kg: 1, m: 1, s: -2 } },
  MN:  { coeff: 1e6,       units: { kg: 1, m: 1, s: -2 } },
  // Pressure (relative to Pa = kg·m⁻¹·s⁻²)
  kPa: { coeff: 1e3,       units: { kg: 1, m: -1, s: -2 } },
  MPa: { coeff: 1e6,       units: { kg: 1, m: -1, s: -2 } },
  GPa: { coeff: 1e9,       units: { kg: 1, m: -1, s: -2 } },
  // Frequency (relative to Hz = s⁻¹)
  kHz: { coeff: 1e3,       units: { s: -1 } },
  MHz: { coeff: 1e6,       units: { s: -1 } },
  GHz: { coeff: 1e9,       units: { s: -1 } },
  THz: { coeff: 1e12,      units: { s: -1 } },
  // Voltage (relative to V = kg·m²·s⁻³·A⁻¹)
  μV:  { coeff: 1e-6,      units: { kg: 1, m: 2, s: -3, A: -1 } },
  mV:  { coeff: 1e-3,      units: { kg: 1, m: 2, s: -3, A: -1 } },
  kV:  { coeff: 1e3,       units: { kg: 1, m: 2, s: -3, A: -1 } },
  MV:  { coeff: 1e6,       units: { kg: 1, m: 2, s: -3, A: -1 } },
  // Charge (relative to C = s·A)
  μC:  { coeff: 1e-6,      units: { s: 1, A: 1 } },
  mC:  { coeff: 1e-3,      units: { s: 1, A: 1 } },
  // Capacitance (relative to F = kg⁻¹·m⁻²·s⁴·A²)
  pF:  { coeff: 1e-12,     units: { kg: -1, m: -2, s: 4, A: 2 } },
  nF:  { coeff: 1e-9,      units: { kg: -1, m: -2, s: 4, A: 2 } },
  μF:  { coeff: 1e-6,      units: { kg: -1, m: -2, s: 4, A: 2 } },
  mF:  { coeff: 1e-3,      units: { kg: -1, m: -2, s: 4, A: 2 } },
  // Inductance (relative to H = kg·m²·s⁻²·A⁻²)
  nH:  { coeff: 1e-9,      units: { kg: 1, m: 2, s: -2, A: -2 } },
  μH:  { coeff: 1e-6,      units: { kg: 1, m: 2, s: -2, A: -2 } },
  mH:  { coeff: 1e-3,      units: { kg: 1, m: 2, s: -2, A: -2 } },
  // Magnetic flux density (relative to T = kg·s⁻²·A⁻¹)
  μT:  { coeff: 1e-6,      units: { kg: 1, s: -2, A: -1 } },
  mT:  { coeff: 1e-3,      units: { kg: 1, s: -2, A: -1 } },
  // Weber (relative to Wb = kg·m²·s⁻²·A⁻¹)
  μWb: { coeff: 1e-6,      units: { kg: 1, m: 2, s: -2, A: -1 } },
  mWb: { coeff: 1e-3,      units: { kg: 1, m: 2, s: -2, A: -1 } },
  // Resistance (relative to Ω = kg·m²·s⁻³·A⁻²)
  'μΩ': { coeff: 1e-6,      units: { kg: 1, m: 2, s: -3, A: -2 } },
  'mΩ': { coeff: 1e-3,      units: { kg: 1, m: 2, s: -3, A: -2 } },
  'kΩ': { coeff: 1e3,       units: { kg: 1, m: 2, s: -3, A: -2 } },
  'MΩ': { coeff: 1e6,       units: { kg: 1, m: 2, s: -3, A: -2 } },
  'GΩ': { coeff: 1e9,       units: { kg: 1, m: 2, s: -3, A: -2 } },
};

// Scale series for each base/derived unit, used by _selectBestScale.
// Each entry: { name: string, p: number } where p is the prefix multiplier relative to SI.
const SCALABLE_UNITS_SERIES = {
  m:   [{name:'nm',p:1e-9},{name:'μm',p:1e-6},{name:'mm',p:1e-3},{name:'cm',p:0.01},
        {name:'m',p:1},{name:'km',p:1e3}],
  s:   [{name:'ns',p:1e-9},{name:'μs',p:1e-6},{name:'ms',p:1e-3},{name:'s',p:1},
        {name:'min',p:60},{name:'hr',p:3600},{name:'day',p:86400},{name:'yr',p:3.15576e7}],
  kg:  [{name:'μg',p:1e-9},{name:'mg',p:1e-6},{name:'g',p:1e-3},{name:'kg',p:1}],
  A:   [{name:'μA',p:1e-6},{name:'mA',p:1e-3},{name:'A',p:1}],
  J:   [{name:'nJ',p:1e-9},{name:'μJ',p:1e-6},{name:'mJ',p:1e-3},{name:'J',p:1},
        {name:'kJ',p:1e3},{name:'MJ',p:1e6},{name:'GJ',p:1e9},{name:'TJ',p:1e12},{name:'PJ',p:1e15}],
  W:   [{name:'nW',p:1e-9},{name:'μW',p:1e-6},{name:'mW',p:1e-3},{name:'W',p:1},
        {name:'kW',p:1e3},{name:'MW',p:1e6},{name:'GW',p:1e9},{name:'TW',p:1e12}],
  N:   [{name:'mN',p:1e-3},{name:'N',p:1},{name:'kN',p:1e3},{name:'MN',p:1e6}],
  Pa:  [{name:'Pa',p:1},{name:'kPa',p:1e3},{name:'MPa',p:1e6},{name:'GPa',p:1e9}],
  Hz:  [{name:'Hz',p:1},{name:'kHz',p:1e3},{name:'MHz',p:1e6},{name:'GHz',p:1e9},{name:'THz',p:1e12}],
  V:   [{name:'μV',p:1e-6},{name:'mV',p:1e-3},{name:'V',p:1},{name:'kV',p:1e3},{name:'MV',p:1e6}],
  C:   [{name:'μC',p:1e-6},{name:'mC',p:1e-3},{name:'C',p:1}],
  F:   [{name:'pF',p:1e-12},{name:'nF',p:1e-9},{name:'μF',p:1e-6},{name:'mF',p:1e-3},{name:'F',p:1}],
  H:   [{name:'nH',p:1e-9},{name:'μH',p:1e-6},{name:'mH',p:1e-3},{name:'H',p:1}],
  T:   [{name:'μT',p:1e-6},{name:'mT',p:1e-3},{name:'T',p:1}],
  Wb:  [{name:'μWb',p:1e-6},{name:'mWb',p:1e-3},{name:'Wb',p:1}],
  'Ω':  [{name:'μΩ',p:1e-6},{name:'mΩ',p:1e-3},{name:'Ω',p:1},{name:'kΩ',p:1e3},{name:'MΩ',p:1e6},{name:'GΩ',p:1e9}],
};

// Compound unit simplifications — matched at display time (power=1 only).
// These are not expanded during evaluation; they only affect how a base-unit
// result is labelled when it exactly matches the given signature.
// `units` is the SI base-unit signature; `factors` is the simplified form to display.
const COMPOUND_UNIT_SIMPLIFICATIONS = [
  { name: 'V/m',    units: { kg: 1, m: 1, s: -3, A: -1 },  factors: { V: 1, m: -1 } },
  { name: 'm/s',    units: { m: 1, s: -1 },                  factors: { m: 1, s: -1 } },
  { name: 'kg·m/s', units: { kg: 1, m: 1, s: -1 },          factors: { kg: 1, m: 1, s: -1 } },
  { name: 'm/s²',   units: { m: 1, s: -2 },                  factors: { m: 1, s: -2 } },
];

// All unit names sorted longest-first for greedy tokenizer matching.
const SI_ALL_UNIT_NAMES = [
  ...Object.keys(DERIVED_UNIT_EXPANSIONS),
  ...Object.keys(SCALED_UNIT_ATOMS),
  ...SI_BASE_UNITS,
].sort((a, b) => b.length - a.length);
const SI_ALL_UNIT_NAMES_SET = new Set(SI_ALL_UNIT_NAMES);

// Module-level flag: set in evaluateCalcExpressions before each evaluation.
let _activePhysicsChem = false;

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

/**
 * Find the first comparison or equality operator at brace-depth 0.
 * Handles: =  <  >  \leq (\le)  \geq (\ge)  \neq (\ne)
 * Returns { idx, len, op } where op is '=', '<', '>', '<=', '>=', or '!='
 * or null if no operator found. Used by evaluateCalcExpressions.
 */
function findCalcOperatorAtDepth0(s) {
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ')') { depth--; i++; continue; }
    if (depth !== 0) { i++; continue; }
    if (c === '\\') {
      // Check for LaTeX inequality commands (both full and short forms)
      const rest = s.slice(i);
      const m = rest.match(/^\\(leq?|geq?|neq|ne|le|ge)(?![a-zA-Z])/);
      if (m) {
        const cmd = m[1];
        const op = (cmd === 'le' || cmd === 'leq') ? '<='
                 : (cmd === 'ge' || cmd === 'geq') ? '>='
                 : '!=';
        return { idx: i, len: m[0].length, op };
      }
      // Skip other LaTeX commands
      i++;
      while (i < s.length && /[a-zA-Z]/.test(s[i])) i++;
      continue;
    }
    if (c === '=') return { idx: i, len: 1, op: '=' };
    if (c === '<') return { idx: i, len: 1, op: '<' };
    if (c === '>') return { idx: i, len: 1, op: '>' };
    i++;
  }
  return null;
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
  COMMA: 'COMMA',
  PRIME: 'PRIME',
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
      // Greedy match of multi-letter unit names (longest first).
      // Single-letter names are always caught by the fallback.
      let matched = null;
      for (const name of SI_ALL_UNIT_NAMES) {
        if (name.length > 1 && src.startsWith(name, i)) { matched = name; break; }
      }
      if (matched) { tokens.push({ type: TK.IDENT, val: matched }); i += matched.length; }
      else          { tokens.push({ type: TK.IDENT, val: c });       i++; }
      continue;
    }
    // Handle μ (micro prefix, U+00B5 or U+03BC) — try greedy match of μ-prefixed unit names.
    if (c === '\u00B5' || c === '\u03BC') {
      let matched = null;
      for (const name of SI_ALL_UNIT_NAMES) {
        if ((name[0] === '\u00B5' || name[0] === '\u03BC') && src.startsWith(name, i)) { matched = name; break; }
      }
      if (matched) { tokens.push({ type: TK.IDENT, val: matched }); i += matched.length; }
      else          { i++; } // skip unrecognised μ
      continue;
    }
    if (c === '\\') {
      let cmd = '\\'; i++;
      while (i < src.length && src[i] >= 'a' && src[i] <= 'z' || i < src.length && src[i] >= 'A' && src[i] <= 'Z')
        cmd += src[i++];
      if (cmd === '\\') { // single non-alpha char after backslash
        cmd += src[i++];
      }
      // Spacing commands — treat as whitespace, don't emit a token.
      // Without this, \  between terms causes parseProduct to try implicit
      // multiplication and then fail when the next token is + or -.
      // \undefined is emitted by MathQuill when spaceBehavesLikeTab is false.
      if (cmd === '\\ ' || cmd === '\\,' || cmd === '\\;' || cmd === '\\!' || cmd === '\\:' || cmd === '\\undefined') continue;
      // \operatorname{name} → emit as \name (e.g. \sin, \ln)
      if (cmd === '\\operatorname' && i < src.length && src[i] === '{') {
        i++; // skip {
        let name = '';
        while (i < src.length && src[i] !== '}') name += src[i++];
        if (i < src.length) i++; // skip }
        cmd = '\\' + name;
      }
      // \Omega → ohm unit atom (Ω). Combine with a preceding prefix letter if valid.
      if (cmd === '\\Omega') {
        const last = tokens.length ? tokens[tokens.length - 1] : null;
        if (last && last.type === TK.IDENT) {
          const combined = last.val + 'Ω';
          if (SCALED_UNIT_ATOMS[combined] !== undefined) {
            tokens[tokens.length - 1] = { type: TK.IDENT, val: combined };
            continue;
          }
        }
        tokens.push({ type: TK.IDENT, val: 'Ω' });
        continue;
      }
      tokens.push({ type: TK.CMD, val: cmd }); continue;
    }
    // Handle Ω (U+03A9) directly in source — combine with preceding prefix letter if valid.
    if (c === 'Ω') {
      const last = tokens.length ? tokens[tokens.length - 1] : null;
      if (last && last.type === TK.IDENT) {
        const combined = last.val + 'Ω';
        if (SCALED_UNIT_ATOMS[combined] !== undefined) {
          tokens[tokens.length - 1] = { type: TK.IDENT, val: combined };
          i++; continue;
        }
      }
      tokens.push({ type: TK.IDENT, val: 'Ω' });
      i++; continue;
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
    if (c === ',') { tokens.push({ type: TK.COMMA }); i++; continue; }
    if (c === "'" || c === '\u2032') { tokens.push({ type: TK.PRIME }); i++; continue; } // apostrophe or Unicode prime ′
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
        t.type === TK.RBRACKET || t.type === TK.PIPE || t.type === TK.COMMA) return true;
    if (t.type === TK.CMD && t.val === '\\right') return true;
    return false;
  }

  parseExpr() { return this.parseSum(); }

  /** After parsing a variable base name, consume an optional subscript (_x, _{...}). */
  tryParseSubscript(base) {
    if (this.peek().type !== TK.UNDERSCORE) return base;
    this.next(); // consume _
    if (this.peek().type === TK.LBRACE) {
      this.next(); // consume {
      let sub = '';
      while (this.peek().type !== TK.RBRACE && this.peek().type !== TK.EOF) {
        const tok = this.next();
        sub += (tok.val !== undefined ? tok.val : '');
      }
      if (this.peek().type === TK.RBRACE) this.next(); // consume }
      return base + '_' + sub;
    } else if (this.peek().type === TK.IDENT || this.peek().type === TK.NUM) {
      return base + '_' + this.next().val;
    }
    return base; // lone _ with nothing after — ignore
  }

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

    // Identifier (single letter variable, constant, or function call)
    if (t.type === TK.IDENT) {
      this.next();
      const name = this.tryParseSubscript(t.val);
      if (name === 'e') return { type: 'number', value: Math.E };

      // Detect prime notation.
      // Form 1: consecutive apostrophes/Unicode primes — f', f'', f'''
      // Form 2: f^{\prime}, f^{\prime\prime}  (LaTeX superscript primes)
      let primeOrder = 0;
      while (this.peek().type === TK.PRIME) {
        this.next(); primeOrder++;
      }
      if (primeOrder === 0 && this.peek().type === TK.CARET) {
        const savedPos = this.pos;
        this.next(); // consume ^
        if (this.peek().type === TK.LBRACE) {
          this.next(); // consume {
          let count = 0;
          while (this.peek().type === TK.CMD && this.peek().val === '\\prime') {
            this.next(); count++;
          }
          if (count > 0 && this.peek().type === TK.RBRACE) {
            this.next(); // consume }
            primeOrder = count;
          } else {
            this.pos = savedPos; // not a prime pattern — restore
          }
        } else {
          this.pos = savedPos; // not a brace after ^ — restore
        }
      }

      // Detect function call: f(args) or f\left(args\right)
      let isCall = false, hasLeft = false;
      if (this.peek().type === TK.LPAREN) {
        isCall = true;
      } else if (this.peek().type === TK.CMD && this.peek().val === '\\left') {
        const savedPos = this.pos;
        this.next(); // consume \left
        if (this.peek().type === TK.LPAREN) { isCall = true; hasLeft = true; }
        else this.pos = savedPos;
      }

      if (isCall) {
        this.next(); // consume (
        const args = this.parseCallArgs();
        if (this.peek().type === TK.CMD && this.peek().val === '\\right') this.next();
        if (this.peek().type === TK.RPAREN) this.next();
        if (primeOrder > 0) return { type: 'primecall', name, order: primeOrder, args };
        return { type: 'call', name, args };
      }

      if (primeOrder > 0) return { type: 'primecall', name, order: primeOrder, args: [] };
      return { type: 'variable', name };
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

  /** Parse a comma-separated argument list, up to but not including the closing ')' or '\right'. */
  parseCallArgs() {
    const args = [];
    const atEnd = () => {
      const t = this.peek();
      return t.type === TK.EOF || t.type === TK.RPAREN ||
        (t.type === TK.CMD && t.val === '\\right');
    };
    if (!atEnd()) {
      args.push(this.parseExpr());
      while (this.peek().type === TK.COMMA) {
        this.next(); // consume comma
        if (atEnd()) break; // trailing comma tolerance
        args.push(this.parseExpr());
      }
    }
    return args;
  }

  parseCommand() {
    const cmd = this.next().val;

    switch (cmd) {
      case '\\frac': {
        const num = this.parseBracedArg();
        const den = this.parseBracedArg();
        // Detect d/d<var> derivative notation: \frac{d}{dx}, \frac{d}{dt}, \frac{d}{d\alpha}, etc.
        if (
          num.type === 'variable' && num.name === 'd' &&
          den.type === 'call' && den.name === 'mul' &&
          den.args[0].type === 'variable' && den.args[0].name === 'd' &&
          den.args[1].type === 'variable'
        ) {
          const varName = den.args[1].name;
          const arg = this.parsePower();
          return { type: 'derivative', variable: varName, arg };
        }
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
      case '\\pi':     return { type: 'variable', name: 'pi' };
      case '\\cdot':
      case '\\times':  throw new CompileError('unexpected multiply operator');
      case '\\ ':
      case '\\,':
      case '\\;':
      case '\\!':
      case '\\:': {
        // Spacing commands — skip. If more tokens follow, parse the next atom.
        if (this.atExprEnd()) return { type: 'number', value: 0 };
        return this.parseAtom();
      }
      case '\\infty':  return { type: 'number', value: 1e30 };

      // Greek letters → variables (subscript allowed: \alpha_{1} → 'alpha_1')
      case '\\alpha':   return { type: 'variable', name: this.tryParseSubscript('alpha') };
      case '\\beta':    return { type: 'variable', name: this.tryParseSubscript('beta') };
      case '\\gamma':   return { type: 'variable', name: this.tryParseSubscript('gamma') };
      case '\\delta':   return { type: 'variable', name: this.tryParseSubscript('delta') };
      case '\\epsilon': return { type: 'variable', name: this.tryParseSubscript('epsilon') };
      case '\\theta':   return { type: 'variable', name: this.tryParseSubscript('theta') };
      case '\\lambda':  return { type: 'variable', name: this.tryParseSubscript('lambda') };
      case '\\mu': {
        // Check if the next token completes a μ-prefixed unit (e.g. \mu J → μJ, \mu s → μs).
        const nextTok = this.peek();
        if (nextTok.type === TK.IDENT) {
          const combined = 'μ' + nextTok.val;
          if (SCALED_UNIT_ATOMS[combined] !== undefined || DERIVED_UNIT_EXPANSIONS[combined] !== undefined) {
            this.next(); // consume the unit letters
            return { type: 'variable', name: combined };
          }
        }
        return { type: 'variable', name: this.tryParseSubscript('mu') };
      }
      case '\\sigma':   return { type: 'variable', name: this.tryParseSubscript('sigma') };
      case '\\rho':     return { type: 'variable', name: this.tryParseSubscript('rho') };
      case '\\phi':     return { type: 'variable', name: this.tryParseSubscript('phi') };
      case '\\Phi':     return { type: 'variable', name: this.tryParseSubscript('Phi') };
      case '\\omega':   return { type: 'variable', name: this.tryParseSubscript('omega') };
      case '\\hbar':    return { type: 'variable', name: this.tryParseSubscript('hbar') };

      case '\\prime':
        throw new CompileError(`'\\prime' must appear as part of a function derivative: f^{\\prime}`);

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
    else if (node.type === 'call' || node.type === 'primecall') for (const a of node.args) stack.push(a);
    else if (node.type === 'derivative') stack.push(node.arg);
  }
  return vars;
}

// Known built-in names that are not user-defined variables
const BUILTIN_VARS = new Set(['x', 'y']);

// AST call node names produced by operators/built-ins — cannot be user-defined function names
const BUILTIN_CALL_NAMES = new Set(['add', 'sub', 'mul', 'div', 'pow', 'neg', 'abs', 'sqrt',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'ln', 'exp',
  'floor', 'ceil', 'round', 'sign', 'max', 'min']);

/**
 * Deep-clone an AST, substituting variable nodes whose names appear in paramMap
 * with the corresponding AST node. Used to bind function parameters to call arguments
 * before differentiation or evaluation.
 */
function substituteAst(ast, paramMap) {
  if (ast.type === 'number') return ast;
  if (ast.type === 'variable') return paramMap.has(ast.name) ? paramMap.get(ast.name) : ast;
  if (ast.type === 'derivative') return { ...ast, arg: substituteAst(ast.arg, paramMap) };
  if (ast.type === 'call' || ast.type === 'primecall')
    return { ...ast, args: ast.args.map(a => substituteAst(a, paramMap)) };
  return ast;
}

/**
 * Scan an AST and return a Set of user-defined function names (from funcDefNames)
 * that are called within it. Used for cycle detection.
 */
function collectFunctionCalls(ast, funcDefNames) {
  const calls = new Set();
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if ((node.type === 'call' || node.type === 'primecall') && funcDefNames.has(node.name))
      calls.add(node.name);
    if (node.args) for (const a of node.args) stack.push(a);
    if (node.arg) stack.push(node.arg); // derivative node
  }
  return calls;
}

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
 * Classify a parsed expression as a definition, function definition, or implicit equation.
 * A function definition has a call node on the LHS: f(x) = x^2.
 * A variable definition has a single variable (not x or y) on the LHS.
 */
function classifyExpression(parsed) {
  const { lhs, rhs } = parsed;
  // Function definition: LHS is a call with all-variable args, e.g. f(x) = x^2
  if (lhs.type === 'call' && lhs.args.length > 0 &&
      lhs.args.every(a => a.type === 'variable') && !BUILTIN_VARS.has(lhs.name) &&
      !BUILTIN_CALL_NAMES.has(lhs.name)) {
    return {
      kind: 'funcdef',
      name: lhs.name,
      params: lhs.args.map(a => a.name),
      body: rhs,
    };
  }
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
 * classify definitions as constants vs xy-dependent, and collect function definitions.
 *
 * @param {Array} classifiedList - Array of { kind, exprId, ... } objects
 * @returns {Object} Analysis result (includes funcDefs)
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
    if (expr.kind === 'funcdef') continue; // handled separately below
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

  // ── Collect and validate function definitions ─────────────────────────────
  // Duplicate definitions (same function name) are reclassified as implicit
  // equations so they get graphed as boolean curves rather than silently ignored.
  const funcDefs = new Map(); // name → { params, body, exprId }
  const reclassifiedFuncs = [];
  for (const expr of classifiedList) {
    if (expr.kind !== 'funcdef') continue;
    if (funcDefs.has(expr.name)) {
      // Reconstruct lhs call node from name + params, treat as implicit equation
      const lhs = { type: 'call', name: expr.name, args: expr.params.map(p => ({ type: 'variable', name: p })) };
      const allVars = new Set([...collectVariables(lhs), ...collectVariables(expr.body)]);
      const deps = new Set(allVars);
      deps.delete('x');
      deps.delete('y');
      reclassifiedFuncs.push({ kind: 'implicit', lhs, rhs: expr.body, deps, allVars, exprId: expr.exprId });
      continue;
    }
    funcDefs.set(expr.name, { params: expr.params, body: expr.body, exprId: expr.exprId });
  }
  classifiedList = [...classifiedList, ...reclassifiedFuncs];

  // Cycle detection for function definitions (DFS)
  {
    const funcResolved  = new Map();
    const funcResolving = new Set();
    function resolveFunc(name) {
      if (funcResolved.has(name)) return funcResolved.get(name);
      if (!funcDefs.has(name)) return { error: null };
      if (funcResolving.has(name))
        return { error: `Circular function dependency on '${name}'` };
      funcResolving.add(name);
      const def = funcDefs.get(name);
      const calledFuncs = collectFunctionCalls(def.body, funcDefs);
      let error = null;
      for (const calledName of calledFuncs) {
        const r = resolveFunc(calledName);
        if (r.error) { error = r.error; break; }
      }
      funcResolving.delete(name);
      const result = { error };
      funcResolved.set(name, result);
      return result;
    }
    for (const [name, def] of funcDefs) {
      const r = resolveFunc(name);
      if (r.error) {
        errors.set(def.exprId, r.error);
        funcDefs.delete(name);
      }
    }
  }

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
    // Function names are recognized — not undefined variables
    if (funcDefs.has(name)) {
      const r = { depth: 0, dependsOnXY: false, error: null };
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
    funcDefs,
  };
}

// ── Constant evaluation (CPU) ───────────────────────────────────────────────

/** Evaluate an AST node to a numeric value, given a map of known values. */
function evaluateAst(ast, values, funcDefs = new Map()) {
  switch (ast.type) {
    case 'number': return ast.value;
    case 'variable': {
      if (ast.name === 'pi') return Math.PI;
      if (values.has(ast.name)) return values.get(ast.name);
      throw new Error(`Undefined variable '${ast.name}' during evaluation`);
    }
    case 'derivative': {
      const derivedAst = simplifyAst(differentiateAst(ast.arg, ast.variable, funcDefs));
      return evaluateAst(derivedAst, values, funcDefs);
    }
    case 'primecall': {
      if (!funcDefs.has(ast.name)) throw new Error(`Undefined function '${ast.name}'`);
      const def = funcDefs.get(ast.name);
      if (def.params.length !== 1)
        throw new Error(`Prime notation f' requires a single-parameter function (got ${def.params.length} params)`);
      if (ast.args.length !== def.params.length)
        throw new Error(`Function '${ast.name}' expects ${def.params.length} argument(s), got ${ast.args.length}`);
      let bodyAst = def.body;
      for (let i = 0; i < ast.order; i++)
        bodyAst = simplifyAst(differentiateAst(bodyAst, def.params[0], funcDefs));
      const innerValues = new Map(values);
      innerValues.set(def.params[0], evaluateAst(ast.args[0], values, funcDefs));
      return evaluateAst(bodyAst, innerValues, funcDefs);
    }
    case 'call': {
      // Built-in functions evaluated directly
      switch (ast.name) {
        case 'add': return evaluateAst(ast.args[0], values, funcDefs) + evaluateAst(ast.args[1], values, funcDefs);
        case 'sub': return evaluateAst(ast.args[0], values, funcDefs) - evaluateAst(ast.args[1], values, funcDefs);
        case 'mul': return evaluateAst(ast.args[0], values, funcDefs) * evaluateAst(ast.args[1], values, funcDefs);
        case 'div': return evaluateAst(ast.args[0], values, funcDefs) / evaluateAst(ast.args[1], values, funcDefs);
        case 'pow': return Math.pow(evaluateAst(ast.args[0], values, funcDefs), evaluateAst(ast.args[1], values, funcDefs));
        case 'neg': return -evaluateAst(ast.args[0], values, funcDefs);
        case 'sin': return Math.sin(evaluateAst(ast.args[0], values, funcDefs));
        case 'cos': return Math.cos(evaluateAst(ast.args[0], values, funcDefs));
        case 'tan': return Math.tan(evaluateAst(ast.args[0], values, funcDefs));
        case 'asin': return Math.asin(evaluateAst(ast.args[0], values, funcDefs));
        case 'acos': return Math.acos(evaluateAst(ast.args[0], values, funcDefs));
        case 'atan': return Math.atan(evaluateAst(ast.args[0], values, funcDefs));
        case 'ln':  return Math.log(evaluateAst(ast.args[0], values, funcDefs));
        case 'exp': return Math.exp(evaluateAst(ast.args[0], values, funcDefs));
        case 'abs': return Math.abs(evaluateAst(ast.args[0], values, funcDefs));
        case 'sqrt': return Math.sqrt(evaluateAst(ast.args[0], values, funcDefs));
        default: {
          // User-defined function call
          if (funcDefs.has(ast.name)) {
            const def = funcDefs.get(ast.name);
            if (ast.args.length !== def.params.length)
              throw new Error(`Function '${ast.name}' expects ${def.params.length} argument(s), got ${ast.args.length}`);
            const innerValues = new Map(values);
            def.params.forEach((p, i) => innerValues.set(p, evaluateAst(ast.args[i], values, funcDefs)));
            return evaluateAst(def.body, innerValues, funcDefs);
          }
          throw new Error(`Unknown function '${ast.name}'`);
        }
      }
    }
    default: throw new Error(`Unknown AST node type '${ast.type}'`);
  }
}

// ── Units-mode helpers ────────────────────────────────────────────────────────

/** Build a paramMap of derived unit names → their base-unit expansion ASTs. */
function buildDerivedUnitParamMap() {
  const map = new Map();
  for (const [name, { coeff, units }] of Object.entries(DERIVED_UNIT_EXPANSIONS)) {
    const factors = [];
    if (coeff !== 1) factors.push({ type: 'number', value: coeff });
    for (const [u, exp] of Object.entries(units)) {
      if (exp === 0) continue;
      const node = { type: 'variable', name: u };
      factors.push(exp === 1 ? node : { type: 'call', name: 'pow', args: [node, { type: 'number', value: exp }] });
    }
    if (factors.length === 0) { map.set(name, { type: 'number', value: coeff }); continue; }
    let ast = factors[0];
    for (let i = 1; i < factors.length; i++) ast = { type: 'call', name: 'mul', args: [ast, factors[i]] };
    map.set(name, ast);
  }
  return map;
}

/** Build a unit AST for a physics constant: `value * u1^e1 * u2^e2 * ...`. */
function buildConstantUnitAst(value, dims) {
  const factors = [{ type: 'number', value }];
  for (const [u, exp] of Object.entries(dims)) {
    if (exp === 0) continue;
    const node = { type: 'variable', name: u };
    factors.push(exp === 1 ? node : { type: 'call', name: 'pow', args: [node, { type: 'number', value: exp }] });
  }
  if (factors.length === 1) return factors[0]; // dimensionless
  let ast = factors[0];
  for (let i = 1; i < factors.length; i++) ast = { type: 'call', name: 'mul', args: [ast, factors[i]] };
  return ast;
}

/** Walk an AST and return the Set of SI base unit variable names found in it. */
function collectUnitVarsInAst(ast) {
  const units = new Set();
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'variable' && (SI_BASE_UNITS.has(node.name) || DERIVED_UNIT_EXPANSIONS[node.name] !== undefined || SCALED_UNIT_ATOMS[node.name] !== undefined)) units.add(node.name);
    if (node.args) for (const a of node.args) stack.push(a);
    if (node.arg)  stack.push(node.arg);
  }
  return units;
}

/**
 * Extract { coeff, units } from a simplified unit AST.
 * units maps SI base unit names to numeric exponents.
 * Returns null if the AST contains unsupported structures (e.g. non-unit variables).
 */
function astToUnitSignature(ast) {
  if (!ast) return null;
  if (ast.type === 'number') return { coeff: ast.value, units: {} };
  if (ast.type === 'variable') {
    if (SI_BASE_UNITS.has(ast.name)) return { coeff: 1, units: { [ast.name]: 1 } };
    if (DERIVED_UNIT_EXPANSIONS[ast.name]) {
      const d = DERIVED_UNIT_EXPANSIONS[ast.name];
      return { coeff: d.coeff, units: { ...d.units } };
    }
    if (SCALED_UNIT_ATOMS[ast.name]) {
      const d = SCALED_UNIT_ATOMS[ast.name];
      return { coeff: d.coeff, units: { ...d.units } };
    }
    return null;
  }
  if (ast.type !== 'call') return null;
  const [a, b] = ast.args || [];
  switch (ast.name) {
    case 'mul': {
      const la = astToUnitSignature(a), rb = astToUnitSignature(b);
      if (!la || !rb) return null;
      const units = { ...la.units };
      for (const [u, e] of Object.entries(rb.units)) {
        units[u] = (units[u] || 0) + e;
        if (units[u] === 0) delete units[u];
      }
      return { coeff: la.coeff * rb.coeff, units };
    }
    case 'div': {
      const ln = astToUnitSignature(a), ld = astToUnitSignature(b);
      if (!ln || !ld) return null;
      const units = { ...ln.units };
      for (const [u, e] of Object.entries(ld.units)) {
        units[u] = (units[u] || 0) - e;
        if (units[u] === 0) delete units[u];
      }
      return { coeff: ln.coeff / ld.coeff, units };
    }
    case 'pow': {
      const bs = astToUnitSignature(a);
      if (!bs || !b || b.type !== 'number') return null;
      const n = b.value;
      const units = {};
      for (const [u, e] of Object.entries(bs.units)) {
        const ne = e * n;
        if (ne !== 0) units[u] = ne;
      }
      return { coeff: Math.pow(bs.coeff, n), units };
    }
    case 'neg': {
      const inner = astToUnitSignature(a);
      if (!inner) return null;
      return { coeff: -inner.coeff, units: inner.units };
    }
    default: return null;
  }
}

/** Returns true if two unit-signature `units` objects have identical base-unit exponents. */
function _unitSigsMatchUnits(a, b) {
  const aKeys = Object.keys(a).filter(k => a[k] !== 0);
  const bKeys = Object.keys(b).filter(k => b[k] !== 0);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => a[k] === b[k]);
}

/**
 * Returns integer n if units === derivedUnits^n (all base-unit exponents are
 * a common integer multiple of those in derivedUnits), else null.
 */
function _derivedUnitPower(units, derivedUnits) {
  const uKeys = Object.keys(units).filter(k => units[k] !== 0);
  const dKeys = Object.keys(derivedUnits).filter(k => derivedUnits[k] !== 0);
  if (uKeys.length !== dKeys.length || uKeys.length === 0) return null;
  let power = null;
  for (const k of uKeys) {
    if (!derivedUnits[k]) return null;
    const ratio = units[k] / derivedUnits[k];
    if (!Number.isInteger(ratio)) return null;
    if (power === null) power = ratio;
    else if (power !== ratio) return null;
  }
  for (const k of dKeys) {
    if (!units[k]) return null;
  }
  return power;
}

/**
 * Given a unit signature { coeff, units }, check if units matches a derived unit
 * (or integer power thereof) from DERIVED_UNIT_EXPANSIONS.
 * Returns { name, power, coeff } or null.
 */
function matchDerivedUnit(sig) {
  if (!sig) return null;
  for (const [name, derived] of Object.entries(DERIVED_UNIT_EXPANSIONS)) {
    if (name === 'rad') continue;
    const power = _derivedUnitPower(sig.units, derived.units);
    if (power === null) continue;
    return { name, power, coeff: sig.coeff / Math.pow(derived.coeff, power) };
  }
  for (const compound of COMPOUND_UNIT_SIMPLIFICATIONS) {
    if (_unitSigsMatchUnits(sig.units, compound.units)) {
      return { name: compound.name, power: 1, coeff: sig.coeff };
    }
  }
  return null;
}

/**
 * Symbolically evaluate an AST, substituting numeric values but leaving unit
 * and (optionally) free-variable symbols intact. Returns a simplified AST node.
 *
 * @param {object}  ast       - AST to evaluate
 * @param {Map}     valueMap  - varName → number | ASTNode
 * @param {Map}     funcDefs  - funcName → { params, body }
 * @param {object}  opts
 * @param {boolean} opts.useSymbolic - keep unknown non-unit variables symbolic
 * @param {Array}   opts.warnings    - array to push { funcName, units } warnings into
 */
function evaluateAstSymbolic(ast, valueMap, funcDefs, opts = {}) {
  const { useSymbolic = false, warnings = [] } = opts;
  const recurse = a => evaluateAstSymbolic(a, valueMap, funcDefs, opts);
  const mk = v  => ({ type: 'number', value: v });

  switch (ast.type) {
    case 'number': return ast;

    case 'variable': {
      if (valueMap.has(ast.name)) {
        const v = valueMap.get(ast.name);
        return typeof v === 'number' ? mk(v) : v;
      }
      if (ast.name === 'pi') return mk(Math.PI);    // π — always numeric, never a unit
      if (SI_BASE_UNITS.has(ast.name)) return ast; // unit symbol — always symbolic
      if (DERIVED_UNIT_EXPANSIONS[ast.name] !== undefined) {
        if (!CHEM_ONLY_UNITS.has(ast.name) || _activePhysicsChem) return ast;
        // Chem-only unit (L, mL, μL) when chem mode is off — fall through to undefined
      }
      if (SCALED_UNIT_ATOMS[ast.name] !== undefined) return ast; // scaled unit — keep symbolic
      if (useSymbolic) return ast;                  // free variable — keep symbolic
      throw new Error(`Undefined variable '${ast.name}'`);
    }

    case 'call': {
      if (ast.name === 'sqrt') {
        return recurse({ type: 'call', name: 'pow', args: [ast.args[0], { type: 'number', value: 0.5 }] });
      }

      const TRIG = new Set(['sin','cos','tan','asin','acos','atan','ln','exp','abs']);
      if (TRIG.has(ast.name)) {
        const arg = simplifyAst(recurse(ast.args[0]));
        if (arg.type === 'number') {
          // Purely numeric — evaluate
          switch (ast.name) {
            case 'sin':  return mk(Math.sin(arg.value));
            case 'cos':  return mk(Math.cos(arg.value));
            case 'tan':  return mk(Math.tan(arg.value));
            case 'asin': return mk(Math.asin(arg.value));
            case 'acos': return mk(Math.acos(arg.value));
            case 'atan': return mk(Math.atan(arg.value));
            case 'ln':   return mk(Math.log(arg.value));
            case 'exp':  return mk(Math.exp(arg.value));
            case 'abs':  return mk(Math.abs(arg.value));
            case 'sqrt': return mk(Math.sqrt(arg.value));
          }
        }
        // Symbolic arg — warn if units are present
        const unitVars = collectUnitVarsInAst(arg);
        if (unitVars.size > 0) warnings.push({ funcName: ast.name, units: [...unitVars] });
        return simplifyAst({ type: 'call', name: ast.name, args: [arg] });
      }

      if (['add','sub','mul','div','pow','neg'].includes(ast.name)) {
        const args = ast.args.map(recurse);
        return simplifyAst({ type: 'call', name: ast.name, args });
      }

      // User-defined function
      if (funcDefs.has(ast.name)) {
        const def = funcDefs.get(ast.name);
        if (ast.args.length !== def.params.length)
          throw new Error(`Function '${ast.name}' expects ${def.params.length} arg(s), got ${ast.args.length}`);
        const innerMap = new Map(valueMap);
        def.params.forEach((p, i) => innerMap.set(p, recurse(ast.args[i])));
        return evaluateAstSymbolic(def.body, innerMap, funcDefs, opts);
      }
      throw new Error(`Unknown function '${ast.name}'`);
    }

    case 'derivative': {
      const derivedAst = simplifyAst(differentiateAst(ast.arg, ast.variable, funcDefs));
      return evaluateAstSymbolic(derivedAst, valueMap, funcDefs, opts);
    }

    case 'primecall': {
      if (!funcDefs.has(ast.name)) throw new Error(`Undefined function '${ast.name}'`);
      const def = funcDefs.get(ast.name);
      if (def.params.length !== 1) throw new Error(`Prime notation requires single-parameter function`);
      let body = def.body;
      for (let i = 0; i < ast.order; i++)
        body = simplifyAst(differentiateAst(body, def.params[0], funcDefs));
      const innerMap = new Map(valueMap);
      innerMap.set(def.params[0], recurse(ast.args[0]));
      return evaluateAstSymbolic(body, innerMap, funcDefs, opts);
    }

    default: throw new Error(`Unknown AST node type '${ast.type}'`);
  }
}

/** Symbolically differentiate an AST with respect to varName. Returns a new AST. */
function differentiateAst(ast, varName, funcDefs = new Map()) {
  const n0 = { type: 'number', value: 0 };
  const n1 = { type: 'number', value: 1 };
  const n2 = { type: 'number', value: 2 };
  const num = v => ({ type: 'number', value: v });
  const call = (name, ...args) => ({ type: 'call', name, args });
  const diff = node => differentiateAst(node, varName, funcDefs);

  if (ast.type === 'number') return n0;
  if (ast.type === 'variable') return ast.name === varName ? n1 : n0;

  if (ast.type === 'derivative') {
    // Nested derivative: differentiate the inner derivative result
    const inner = differentiateAst(ast.arg, ast.variable, funcDefs);
    return differentiateAst(inner, varName, funcDefs);
  }

  if (ast.type === 'primecall') {
    // d/dvar f^(n)(g(var)) — differentiate body (n+1) times w.r.t. param,
    // substitute arg for param, then differentiate result w.r.t. varName (chain rule)
    if (!funcDefs.has(ast.name))
      throw new CompileError(`Cannot differentiate: undefined function '${ast.name}'`);
    const def = funcDefs.get(ast.name);
    if (def.params.length !== 1)
      throw new CompileError(`Prime notation requires a single-parameter function`);
    let bodyAst = def.body;
    for (let i = 0; i < ast.order; i++)
      bodyAst = simplifyAst(differentiateAst(bodyAst, def.params[0], funcDefs));
    const paramMap = new Map([[def.params[0], ast.args[0]]]);
    const substituted = substituteAst(bodyAst, paramMap);
    return differentiateAst(substituted, varName, funcDefs);
  }

  const [a, b] = ast.args;
  const da = diff(a);
  const db = b !== undefined ? diff(b) : null;

  switch (ast.name) {
    case 'add': return call('add', da, db);
    case 'sub': return call('sub', da, db);
    case 'neg': return call('neg', da);
    case 'mul': // product rule: da*b + a*db
      return call('add', call('mul', da, b), call('mul', a, db));
    case 'div': // quotient rule: (da*b - a*db) / b^2
      return call('div',
        call('sub', call('mul', da, b), call('mul', a, db)),
        call('pow', b, n2));
    case 'pow': // general power: a^b * (db*ln(a) + b*da/a)
      return call('mul', { ...ast },
        call('add',
          call('mul', db, call('ln', a)),
          call('mul', b, call('div', da, a))));
    case 'sin': return call('mul', call('cos', a), da);
    case 'cos': return call('neg', call('mul', call('sin', a), da));
    case 'tan': return call('mul', call('div', n1, call('pow', call('cos', a), n2)), da);
    case 'asin': return call('mul', call('div', n1, call('sqrt', call('sub', n1, call('pow', a, n2)))), da);
    case 'acos': return call('neg', call('mul', call('div', n1, call('sqrt', call('sub', n1, call('pow', a, n2)))), da));
    case 'atan': return call('mul', call('div', n1, call('add', n1, call('pow', a, n2))), da);
    case 'ln':   return call('mul', call('div', n1, a), da);
    case 'log':  return call('mul', call('div', n1, call('mul', a, call('ln', num(10)))), da);
    case 'exp':  return call('mul', { ...ast }, da);
    case 'sqrt': return call('mul', call('div', n1, call('mul', n2, call('sqrt', a))), da);
    case 'abs':  return call('mul', call('div', a, call('abs', a)), da); // sign(a)*da
    default: {
      // User-defined function call: substitute params → args in body, then differentiate (chain rule)
      if (funcDefs.has(ast.name)) {
        const def = funcDefs.get(ast.name);
        const paramMap = new Map(def.params.map((p, i) => [p, ast.args[i]]));
        const substituted = substituteAst(def.body, paramMap);
        return differentiateAst(substituted, varName, funcDefs);
      }
      throw new CompileError(`Cannot differentiate: ${ast.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical sum-of-products simplification
//
// An expression is represented as an array of terms:
//   { coeff: number, factors: Map<atomKey, integerExponent> }
//
// "Atoms" are irreducible subexpressions: variables and function calls whose
// arguments have been recursively canonicalized. Two atoms with the same key
// are the same expression and their exponents can be added.
// ---------------------------------------------------------------------------

/** Return a stable string key for an atom node (variable or call). */
function _atomKey(ast, atomMap) {
  if (ast.type === 'variable') return ast.name;
  if (ast.type === 'number') throw new Error('numbers are not atoms');
  // Recursively simplify each argument so that e.g. sin(x+2x) → sin(3x).
  const simplifiedArgs = ast.args.map(a => simplifyAst(a));
  const argKeys = simplifiedArgs.map(a => _astCanonicalString(a, atomMap));
  const key = `${ast.name}(${argKeys.join(',')})`;
  atomMap.set(key, { ...ast, args: simplifiedArgs });
  return key;
}

/** Produce a canonical string for any AST node (used inside atom keys). */
function _astCanonicalString(ast, atomMap) {
  if (ast.type === 'number') return String(ast.value);
  if (ast.type === 'variable') return ast.name;
  const argStrs = ast.args.map(a => _astCanonicalString(a, atomMap));
  return `${ast.name}(${argStrs.join(',')})`;
}

/** Multiply two term arrays: cross-product, merging coefficients and exponents. */
function _mulTerms(ta, tb) {
  const result = [];
  for (const a of ta) {
    for (const b of tb) {
      const factors = new Map(a.factors);
      for (const [k, e] of b.factors) factors.set(k, (factors.get(k) || 0) + e);
      result.push({ coeff: a.coeff * b.coeff, factors });
    }
  }
  return result;
}

/**
 * Convert an AST node to a flat array of canonical terms.
 * atomMap accumulates atomKey → original AST node for reconstruction.
 */
function _toCanonical(ast, atomMap) {
  const num = v => [{ coeff: v, factors: new Map() }];

  if (ast.type === 'number') return num(ast.value);

  if (ast.type === 'variable') {
    const key = ast.name;
    atomMap.set(key, ast);
    return [{ coeff: 1, factors: new Map([[key, 1]]) }];
  }

  if (ast.type !== 'call') throw new Error('unsupported node type');

  const { name, args } = ast;

  switch (name) {
    case 'add': {
      return [..._toCanonical(args[0], atomMap), ..._toCanonical(args[1], atomMap)];
    }
    case 'sub': {
      const right = _toCanonical(args[1], atomMap).map(t => ({ ...t, coeff: -t.coeff }));
      return [..._toCanonical(args[0], atomMap), ...right];
    }
    case 'neg': {
      return _toCanonical(args[0], atomMap).map(t => ({ ...t, coeff: -t.coeff }));
    }
    case 'mul': {
      return _mulTerms(_toCanonical(args[0], atomMap), _toCanonical(args[1], atomMap));
    }
    case 'div': {
      // Only simplify if denominator is a single-term monomial (coeff * atoms^exps).
      const denom = _toCanonical(args[1], atomMap);
      if (denom.length !== 1) {
        // Multi-term denominator: treat whole div as atom.
        const key = _atomKey(ast, atomMap);
        return [{ coeff: 1, factors: new Map([[key, 1]]) }];
      }
      const d = denom[0];
      const numer = _toCanonical(args[0], atomMap);
      return numer.map(t => {
        const factors = new Map(t.factors);
        for (const [k, e] of d.factors) factors.set(k, (factors.get(k) || 0) - e);
        return { coeff: t.coeff / d.coeff, factors };
      });
    }
    case 'pow': {
      // Flatten nested pow: pow(pow(x, a), b) → pow(x, a*b)
      if (args[0].type === 'call' && args[0].name === 'pow' &&
          args[0].args[1].type === 'number' && args[1].type === 'number') {
        const newExp = args[0].args[1].value * args[1].value;
        return _toCanonical({ type: 'call', name: 'pow', args: [args[0].args[0], { type: 'number', value: newExp }] }, atomMap);
      }
      const expNode = args[1];
      if (expNode.type === 'number') {
        const e = expNode.value;
        if (e === 0) return num(1);
        const base = _toCanonical(args[0], atomMap);
        if (base.length === 1) {
          // Single-term base: multiply exponents directly. Works for any real e.
          const t = base[0];
          const factors = new Map();
          for (const [k, exp] of t.factors) factors.set(k, exp * e);
          return [{ coeff: Math.pow(t.coeff, e), factors }];
        }
        if (Number.isInteger(e) && e > 0 && e <= 8) {
          // Multi-term base with small positive integer exponent: expand by repeated mul.
          let result = base;
          for (let i = 1; i < e; i++) result = _mulTerms(result, base);
          return result;
        }
      }
      break; // fall through to atom
    }
    case 'sqrt': {
      return _toCanonical({ type: 'call', name: 'pow', args: [args[0], { type: 'number', value: 0.5 }] }, atomMap);
    }
    default:
      break;
  }

  // All other call nodes (sin, cos, ln, etc.) and unhandled pow: treat as atom.
  const key = _atomKey(ast, atomMap);
  return [{ coeff: 1, factors: new Map([[key, 1]]) }];
}

/** Produce a stable signature string for a factor map, for term grouping. */
function _termSignature(factors) {
  return [...factors.entries()]
    .filter(([, e]) => e !== 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, e]) => `${k}^${e}`)
    .join('*');
}

/** Expand a canonical term's factors to SI base units. Returns {coeff, siUnits} or null. */
function _termToSISignature(term) {
  let coeff = term.coeff;
  const siUnits = {};
  for (const [key, exp] of term.factors) {
    if (SI_BASE_UNITS.has(key)) {
      siUnits[key] = (siUnits[key] || 0) + exp;
    } else if (DERIVED_UNIT_EXPANSIONS[key]) {
      if (CHEM_ONLY_UNITS.has(key) && !_activePhysicsChem) return null;
      const d = DERIVED_UNIT_EXPANSIONS[key];
      coeff *= Math.pow(d.coeff, exp);
      for (const [u, e] of Object.entries(d.units))
        siUnits[u] = (siUnits[u] || 0) + e * exp;
    } else if (SCALED_UNIT_ATOMS[key]) {
      const d = SCALED_UNIT_ATOMS[key];
      coeff *= Math.pow(d.coeff, exp);
      for (const [u, e] of Object.entries(d.units))
        siUnits[u] = (siUnits[u] || 0) + e * exp;
    } else {
      return null;
    }
  }
  for (const k of Object.keys(siUnits)) if (siUnits[k] === 0) delete siUnits[k];
  return { coeff, siUnits };
}

/** Canonical string key from SI units dict. */
function _siSignatureKey(siUnits) {
  return Object.entries(siUnits).filter(([, e]) => e !== 0).sort().map(([u, e]) => `${u}^${e}`).join('*');
}

/**
 * Given a base unit name, its power, and the SI coefficient, return the best-scaled
 * unit name and display coefficient, or null if no prefix gives a display coeff in [1, 1000).
 * For m^3 when chem mode is active, liter units are preferred over length cubed.
 */
function _selectBestScale(baseName, power, siCoeff) {
  if (baseName === 'm' && power === 3 && _activePhysicsChem) {
    for (const { name, p } of [{ name: 'L', p: 1e-3 }, { name: 'mL', p: 1e-6 }, { name: 'μL', p: 1e-9 }]) {
      const d = Math.abs(siCoeff) / p;
      if (d >= 1 && d < 1000) return { name, power: 1, newCoeff: siCoeff / p };
    }
  }
  const series = SCALABLE_UNITS_SERIES[baseName];
  if (!series) return null;
  // Scan from largest prefix to smallest — first candidate with |display coeff| in [1, 1000).
  const sorted = [...series].sort((a, b) => b.p - a.p);
  for (const { name, p } of sorted) {
    const d = Math.abs(siCoeff) / Math.pow(p, power);
    if (d >= 1 && d < 1000) return { name, power, newCoeff: siCoeff / Math.pow(p, power) };
  }
  // Coefficient is out of range for all prefixes — use the largest available unit.
  const largest = sorted[0];
  return { name: largest.name, power, newCoeff: siCoeff / Math.pow(largest.p, power) };
}

/** Rewrite a term to its best-scaled named unit form, or return it unchanged if no match. */
function _simplifyTermUnits(term, atomMap) {
  const si = _termToSISignature(term);
  if (!si) return term;

  // All dimensions cancel — pure dimensionless number.
  const entries = Object.entries(si.siUnits).filter(([, e]) => e !== 0);
  if (entries.length === 0) return { coeff: si.coeff, factors: new Map() };

  let baseName, basePower, displayCoeff;

  // Try matching to a non-chem derived unit (N, J, W, Hz, …).
  // Require match.power >= 1 to avoid nonsensical units like Hz^{-1} for plain seconds.
  const match = matchDerivedUnit({ coeff: si.coeff, units: si.siUnits });
  if (match && match.power >= 1 && DERIVED_UNIT_EXPANSIONS[match.name] && !CHEM_ONLY_UNITS.has(match.name)) {
    baseName = match.name;
    basePower = match.power;
    displayCoeff = match.coeff;
  } else {
    // Check if the SI expansion reduces to a single base unit raised to an integer power.
    if (entries.length === 1) {
      const [unit, power] = entries[0];
      if (SI_BASE_UNITS.has(unit) && Number.isInteger(power)) {
        baseName = unit;
        basePower = power;
        displayCoeff = si.coeff;
      }
    }
  }

  if (!baseName) {
    // Check compound unit simplifications (e.g. V/m, m/s).
    for (const cu of COMPOUND_UNIT_SIMPLIFICATIONS) {
      const cuEntries = Object.entries(cu.units).filter(([, e]) => e !== 0);
      if (cuEntries.length === entries.length &&
          entries.every(([u, e]) => cu.units[u] === e)) {
        const factors = new Map();
        for (const [atom, exp] of Object.entries(cu.factors)) {
          if (!atomMap.has(atom)) atomMap.set(atom, { type: 'variable', name: atom });
          factors.set(atom, exp);
        }
        return { coeff: si.coeff, factors };
      }
    }
    return term;
  }

  const scaled = _selectBestScale(baseName, basePower, displayCoeff);
  // If no ideal prefix found: fall back to base unit only when the original term has mixed
  // factors (e.g. Mm²·kPa·m⁻¹·s² → kg). For single-factor terms (e.g. yr^{-1}), return
  // the original so we don't force an ugly coefficient onto a derived unit (e.g. 3e-8 Hz).
  const nonZeroFactors = [...term.factors.values()].filter(e => e !== 0).length;
  const { name, power, newCoeff } = scaled ?? (nonZeroFactors >= 2
    ? { name: baseName, power: basePower, newCoeff: displayCoeff }
    : null) ?? { name: null };
  if (!name) return term;
  if (!atomMap.has(name)) atomMap.set(name, { type: 'variable', name });
  return { coeff: newCoeff, factors: new Map([[name, power]]) };
}

/** Merge terms with identical factor maps; fall back to SI equivalence for unit terms. */
function _combineTerms(terms, atomMap) {
  const map = new Map();   // surfaceSig → term
  const siMap = new Map(); // siKey → surfaceSig

  for (const t of terms) {
    const sig = _termSignature(t.factors);
    if (map.has(sig)) {
      map.get(sig).coeff += t.coeff;
      continue;
    }

    const si = _termToSISignature(t);
    if (si !== null) {
      const siKey = _siSignatureKey(si.siUnits);
      const existSig = siMap.get(siKey);
      if (existSig !== undefined) {
        // SI-equivalent term exists — convert both to SI base units and combine
        const existTerm = map.get(existSig);
        const existSI = _termToSISignature(existTerm);
        const siFactors = new Map(Object.entries(si.siUnits).map(([u, e]) => [u, e]));
        for (const u of siFactors.keys())
          if (!atomMap.has(u)) atomMap.set(u, { type: 'variable', name: u });
        existTerm.coeff = existSI.coeff + si.coeff;
        existTerm.factors = siFactors;
        map.delete(existSig);
        const newSig = _termSignature(siFactors);
        map.set(newSig, existTerm);
        siMap.set(siKey, newSig);
        continue;
      }
      siMap.set(siKey, sig);
    }

    map.set(sig, { coeff: t.coeff, factors: new Map(t.factors) });
  }

  return [...map.values()].filter(t => t.coeff !== 0);
}

/** Reconstruct an AST from a canonical terms array. */
function _fromCanonical(terms, atomMap) {
  const mkNum = v => ({ type: 'number', value: v });
  const mkCall = (name, ...args) => ({ type: 'call', name, args });

  if (terms.length === 0) return mkNum(0);

  function termToAst(t) {
    // Split factors into positive and negative exponents for fraction display.
    const sorted = [...t.factors.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const posNodes = [];
    const negNodes = [];
    for (const [key, exp] of sorted) {
      if (exp === 0) continue;
      const atomAst = atomMap.get(key);
      if (!atomAst) throw new Error(`unknown atom: ${key}`);
      if (exp > 0) {
        posNodes.push(exp === 1 ? atomAst : mkCall('pow', atomAst, mkNum(exp)));
      } else {
        const absExp = -exp;
        negNodes.push(absExp === 1 ? atomAst : mkCall('pow', atomAst, mkNum(absExp)));
      }
    }

    const absCoeff = Math.abs(t.coeff);
    const isNeg = t.coeff < 0;

    let node;
    if (posNodes.length === 0 && negNodes.length === 0) {
      node = mkNum(t.coeff);
    } else if (negNodes.length === 0) {
      // All positive exponents — no fraction needed.
      node = posNodes.reduce((acc, f) => mkCall('mul', acc, f));
      if (absCoeff !== 1) node = mkCall('mul', mkNum(absCoeff), node);
      if (isNeg) node = mkCall('neg', node);
    } else {
      // Mixed exponents — emit as coeff * div(numerator, denominator) so the
      // coefficient appears beside the fraction rather than inside the numerator.
      const numNode = posNodes.length > 0
        ? posNodes.reduce((acc, f) => mkCall('mul', acc, f))
        : mkNum(1);
      const denNode = negNodes.reduce((acc, f) => mkCall('mul', acc, f));
      const fracNode = mkCall('div', numNode, denNode);
      node = absCoeff !== 1 ? mkCall('mul', mkNum(absCoeff), fracNode) : fracNode;
      if (isNeg) node = mkCall('neg', node);
    }
    return node;
  }

  // Build the sum, using sub for negative-coefficient subsequent terms to keep
  // output a bit cleaner (neg wrapping handled by _simplifyAstFallback post-pass).
  let result = termToAst(terms[0]);
  for (let i = 1; i < terms.length; i++) {
    const t = terms[i];
    if (t.coeff < 0) {
      // Emit as sub(result, positiveTerm) for cleanliness.
      const pos = termToAst({ ...t, coeff: -t.coeff });
      result = mkCall('sub', result, pos);
    } else {
      result = mkCall('add', result, termToAst(t));
    }
  }
  return result;
}

/** Fallback: basic constant folding, single bottom-up pass. */
function _simplifyAstFallback(ast) {
  if (ast.type !== 'call') return ast;

  const args = ast.args.map(_simplifyAstFallback);
  const isNum  = n => n.type === 'number';
  const isZero = n => isNum(n) && n.value === 0;
  const isOne  = n => isNum(n) && n.value === 1;
  const num    = v => ({ type: 'number', value: v });
  const call   = (name, ...a) => ({ type: 'call', name, args: a });

  switch (ast.name) {
    case 'add':
      if (isZero(args[0])) return args[1];
      if (isZero(args[1])) return args[0];
      if (isNum(args[0]) && isNum(args[1])) return num(args[0].value + args[1].value);
      break;
    case 'sub':
      if (isZero(args[1])) return args[0];
      if (isZero(args[0])) return _simplifyAstFallback(call('neg', args[1]));
      if (isNum(args[0]) && isNum(args[1])) return num(args[0].value - args[1].value);
      break;
    case 'mul':
      if (isZero(args[0]) || isZero(args[1])) return num(0);
      if (isOne(args[0])) return args[1];
      if (isOne(args[1])) return args[0];
      if (isNum(args[0]) && isNum(args[1])) return num(args[0].value * args[1].value);
      break;
    case 'div':
      if (isZero(args[0])) return num(0);
      if (isOne(args[1])) return args[0];
      if (isNum(args[0]) && isNum(args[1])) return num(args[0].value / args[1].value);
      break;
    case 'pow':
      if (isZero(args[1])) return num(1);
      if (isOne(args[1])) return args[0];
      if (isOne(args[0])) return num(1);
      if (isNum(args[0]) && isNum(args[1])) return num(Math.pow(args[0].value, args[1].value));
      break;
    case 'neg':
      if (isZero(args[0])) return num(0);
      if (isNum(args[0])) return num(-args[0].value);
      if (args[0].type === 'call' && args[0].name === 'neg') return args[0].args[0];
      break;
    case 'ln':
      if (isNum(args[0]) && args[0].value === 1) return num(0);
      break;
    case 'exp':
      if (isZero(args[0])) return num(1);
      break;
  }

  return { ...ast, args };
}

// ── AST → LaTeX renderer (for preview) ───────────────────────────────────────

function _numToLatex(v, sigFigs = 6) {
  if (!isFinite(v)) return String(v);
  const absV = Math.abs(v);
  if (Number.isInteger(v) && absV < 10000) return String(v);
  if (absV >= 0.001 && absV < 10000) return String(parseFloat(v.toPrecision(sigFigs)));
  if (absV < 0.001) {
    // Standard scientific notation for very small numbers.
    const exp = Math.floor(Math.log10(absV));
    const m = parseFloat((v / Math.pow(10, exp)).toPrecision(sigFigs));
    return `${m} \\times 10^{${exp}}`;
  }
  // Engineering notation for large numbers: exponent is a multiple of 3, mantissa in [1, 1000).
  const exp3 = Math.floor(Math.log10(absV) / 3) * 3;
  const m = parseFloat((v / Math.pow(10, exp3)).toPrecision(sigFigs));
  return `${m} \\times 10^{${exp3}}`;
}

/** Wrap in parens only when ast is a sum, difference, or product — for use as pow base or neg operand. */
function _latexAtom(ast, sigFigs = 6) {
  if (!ast) return '?';
  if (ast.type === 'number' || ast.type === 'variable') return astToLatex(ast, sigFigs);
  if (ast.type === 'call' && (ast.name === 'add' || ast.name === 'sub' || ast.name === 'mul' || ast.name === 'pow'))
    return `\\left(${astToLatex(ast, sigFigs)}\\right)`;
  return astToLatex(ast, sigFigs);
}

/** Convert a simplified AST to a LaTeX string. Unit symbols are wrapped in \text{}. */
function astToLatex(ast, sigFigs = 6) {
  if (!ast) return '?';
  const rec = n => astToLatex(n, sigFigs);
  const atom = n => _latexAtom(n, sigFigs);
  switch (ast.type) {
    case 'number':   return _numToLatex(ast.value, sigFigs);
    case 'variable': {
      if (SI_ALL_UNIT_NAMES_SET.has(ast.name)) return `\\text{${ast.name}}`;
      // Greek letter variable names must be re-emitted as LaTeX commands.
      // Subscripts are preserved: 'alpha_1' → '\alpha_{1}'.
      const GREEK_TO_LATEX = { alpha:'\\alpha', beta:'\\beta', gamma:'\\gamma', delta:'\\delta',
        epsilon:'\\epsilon', theta:'\\theta', lambda:'\\lambda', mu:'\\mu', sigma:'\\sigma', rho:'\\rho',
        phi:'\\phi', Phi:'\\Phi', omega:'\\omega', hbar:'\\hbar', pi:'\\pi' };
      const underscoreIdx = ast.name.indexOf('_');
      const base = underscoreIdx === -1 ? ast.name : ast.name.slice(0, underscoreIdx);
      const sub  = underscoreIdx === -1 ? ''        : ast.name.slice(underscoreIdx + 1);
      if (GREEK_TO_LATEX[base]) return GREEK_TO_LATEX[base] + (sub ? `_{${sub}}` : '');
      return ast.name;
    }
    case 'call': {
      const [a, b] = ast.args || [];
      switch (ast.name) {
        case 'add':  return `${rec(a)} + ${rec(b)}`;
        case 'sub':  return `${rec(a)} - ${rec(b)}`;
        case 'mul':  return `${rec(a)} \\, ${rec(b)}`;
        case 'div':  return `\\frac{${rec(a)}}{${rec(b)}}`;
        case 'pow':  return `${atom(a)}^{${rec(b)}}`;
        case 'neg':  return `-${atom(a)}`;
        case 'sin':  return `\\sin\\left(${rec(a)}\\right)`;
        case 'cos':  return `\\cos\\left(${rec(a)}\\right)`;
        case 'tan':  return `\\tan\\left(${rec(a)}\\right)`;
        case 'asin': return `\\arcsin\\left(${rec(a)}\\right)`;
        case 'acos': return `\\arccos\\left(${rec(a)}\\right)`;
        case 'atan': return `\\arctan\\left(${rec(a)}\\right)`;
        case 'ln':   return `\\ln\\left(${rec(a)}\\right)`;
        case 'exp':  return `e^{${rec(a)}}`;
        case 'abs':  return `\\left|${rec(a)}\\right|`;
        case 'sqrt': return `\\sqrt{${rec(a)}}`;
        default:     return `\\operatorname{${ast.name}}\\left(${(ast.args||[]).map(rec).join(', ')}\\right)`;
      }
    }
    default: return '?';
  }
}

/**
 * Wrap bare unit-name identifiers in \text{} within a LaTeX string,
 * leaving all other content (commands, operators, numbers, braces) untouched.
 * Mirrors the tokenizer's greedy longest-first unit matching.
 * \text{...} blocks already in the input are passed through verbatim.
 */
function _wrapUnitsInText(latex) {
  let result = '';
  let i = 0;
  while (i < latex.length) {
    const c = latex[i];
    if (c === '\\') {
      result += c; i++;
      let cmd = '';
      while (i < latex.length && ((latex[i] >= 'a' && latex[i] <= 'z') || (latex[i] >= 'A' && latex[i] <= 'Z')))
        { cmd += latex[i]; result += latex[i]; i++; }
      // Pass \text{...} verbatim so we don't double-wrap
      if (cmd === 'text' && i < latex.length && latex[i] === '{') {
        result += latex[i++]; // {
        while (i < latex.length && latex[i] !== '}') result += latex[i++];
        if (i < latex.length) result += latex[i++]; // }
      }
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      let matched = null;
      for (const name of SI_ALL_UNIT_NAMES) {
        if (latex.startsWith(name, i)) { matched = name; break; }
      }
      if (matched) {
        result += `\\text{${matched}}`;
        i += matched.length;
      } else {
        result += c; i++;
      }
      continue;
    }
    result += c; i++;
  }
  return result;
}

/**
 * Simplify an AST using canonical sum-of-products normalization.
 * Combines like terms and folds constants. Falls back to basic constant
 * folding if canonicalization fails (e.g. unsupported node types).
 */
function simplifyAst(ast) {
  if (ast.type !== 'call') return ast;
  try {
    const atomMap  = new Map();
    const terms    = _toCanonical(ast, atomMap);
    const reduced  = _combineTerms(terms, atomMap);
    const unitSimp = reduced.map(t => _simplifyTermUnits(t, atomMap));
    const rebuilt  = _fromCanonical(unitSimp, atomMap);
    // Post-pass: clean up any residual mul(1,x), neg(neg(x)), etc.
    return _simplifyAstFallback(rebuilt);
  } catch (_) {
    return _simplifyAstFallback(ast);
  }
}

/**
 * Expand a canonical term fully to SI base units, or return it unchanged if it contains
 * symbolic (non-unit) factors. Used by simplifyAstToBase.
 * @param {{coeff: number, factors: Map<string,number>}} term
 * @param {Map<string,object>} atomMap - atom name → AST node (mutated to add base unit entries)
 * @returns {{coeff: number, factors: Map<string,number>}}
 */
function _expandTermToBaseUnits(term, atomMap) {
  const si = _termToSISignature(term);
  if (!si) return term; // contains symbolic non-unit variables — can't expand
  const entries = Object.entries(si.siUnits).filter(([, e]) => e !== 0);
  if (entries.length === 0) return { coeff: si.coeff, factors: new Map() };
  const factors = new Map();
  for (const [u, e] of entries) {
    if (!atomMap.has(u)) atomMap.set(u, { type: 'variable', name: u });
    factors.set(u, e);
  }
  return { coeff: si.coeff, factors };
}

/**
 * Like simplifyAst but expands all unit terms to SI base units instead of
 * collapsing them to named derived units (N, J, Pa, …).
 * @param {object} ast - AST node
 * @returns {object} simplified AST with all units in SI base form
 */
function simplifyAstToBase(ast) {
  if (ast.type !== 'call') return ast;
  try {
    const atomMap = new Map();
    const terms   = _toCanonical(ast, atomMap);
    const reduced = _combineTerms(terms, atomMap);
    const expanded = reduced.map(t => _expandTermToBaseUnits(t, atomMap));
    const rebuilt  = _fromCanonical(expanded, atomMap);
    return _simplifyAstFallback(rebuilt);
  } catch (_) {
    return _simplifyAstFallback(ast);
  }
}

/**
 * Like substituteAst but recurses into the substituted value, fully expanding
 * transitive variable definitions. Safe only when varDefs is acyclic (guaranteed
 * because varDefs is built from userResolved definitions, which pass cycle detection).
 * e.g. with {c: pow(a,2), a: pow(b,3)}: variable(c) → pow(a,2) → pow(pow(b,3),2) = b^6.
 */
function _deepSubstituteVarDefs(ast, varDefs) {
  if (ast.type === 'number') return ast;
  if (ast.type === 'variable') {
    if (varDefs.has(ast.name)) return _deepSubstituteVarDefs(varDefs.get(ast.name), varDefs);
    return ast;
  }
  if (ast.type === 'derivative') return { ...ast, arg: _deepSubstituteVarDefs(ast.arg, varDefs) };
  if (ast.type === 'call' || ast.type === 'primecall')
    return { ...ast, args: ast.args.map(a => _deepSubstituteVarDefs(a, varDefs)) };
  return ast;
}

/**
 * Expand derivative nodes in an AST by substituting variable definitions into
 * their arguments before differentiating. Allows d/db a to correctly
 * differentiate a's definition (e.g. a=b^2 → 2b) rather than treating a as
 * an unrelated constant (which would give 0). Handles transitive chains
 * (e.g. c=a^2, a=b^3 → d/db c = 6b^5).
 *
 * The differentiation variable is excluded from the substitution so it stays
 * symbolic for differentiation (e.g. d/db a with a=b^2: substitute a→b^2 but
 * don't substitute b itself, then differentiate b^2 w.r.t. b → 2b).
 *
 * @param {object} ast - AST to process
 * @param {Map<string,object>} varDefs - name → definition AST (non-numeric defs only)
 * @param {Map} funcDefs - function definitions
 * @returns {object} AST with derivative nodes expanded
 */
function expandDerivatives(ast, varDefs, funcDefs) {
  if (ast.type === 'number' || ast.type === 'variable') return ast;
  if (ast.type === 'derivative') {
    // Exclude the differentiation variable so it remains symbolic for d/dv
    const filtered = new Map([...varDefs].filter(([k]) => k !== ast.variable));
    const substituted = filtered.size > 0 ? _deepSubstituteVarDefs(ast.arg, filtered) : ast.arg;
    const expandedArg = expandDerivatives(substituted, varDefs, funcDefs);
    return simplifyAst(differentiateAst(expandedArg, ast.variable, funcDefs));
  }
  if (ast.type === 'call' || ast.type === 'primecall') {
    return { ...ast, args: ast.args.map(a => expandDerivatives(a, varDefs, funcDefs)) };
  }
  return ast;
}

/**
 * Evaluate all constant definitions in the analysis.
 * Iterates in dependency-depth order so all deps are available.
 * Stores results in analysis.constantValues.
 */
function evaluateConstants(analysis) {
  analysis.constantValues.clear();
  const funcDefs = analysis.funcDefs || new Map();
  for (const c of analysis.constants) {
    try {
      const val = evaluateAst(c.rhs, analysis.constantValues, funcDefs);
      analysis.constantValues.set(c.name, val);
    } catch (e) {
      analysis.errors.set(c.exprId, e.message);
    }
  }
}

// ── AST → GLSL code generation ──────────────────────────────────────────────

/** Convert an AST to a GLSL float expression string. */
function astToGlsl(ast, constantNames, xyDefNames, funcDefs = new Map()) {
  const recurse = a => astToGlsl(a, constantNames, xyDefNames, funcDefs);
  switch (ast.type) {
    case 'number': {
      const s = ast.value.toString();
      return s.includes('.') || s.includes('e') ? s : s + '.0';
    }
    case 'derivative': {
      const derivedAst = simplifyAst(differentiateAst(ast.arg, ast.variable, funcDefs));
      return recurse(derivedAst);
    }
    case 'variable': {
      if (ast.name === 'pi') return '3.141592653589793';
      if (ast.name === 'x' || ast.name === 'y') return ast.name;
      if (constantNames.has(ast.name)) return 'u_' + ast.name;
      if (xyDefNames.has(ast.name)) return 'v_' + ast.name;
      return ast.name; // fallback — should be caught by analysis
    }
    case 'primecall': {
      if (!funcDefs.has(ast.name)) throw new CompileError(`Undefined function '${ast.name}'`);
      const def = funcDefs.get(ast.name);
      let bodyAst = def.body;
      for (let i = 0; i < ast.order; i++)
        bodyAst = simplifyAst(differentiateAst(bodyAst, def.params[0], funcDefs));
      const paramMap = new Map([[def.params[0], ast.args[0]]]);
      return recurse(substituteAst(bodyAst, paramMap));
    }
    case 'call': {
      const args = ast.args.map(recurse);
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
        default: {
          if (funcDefs.has(ast.name)) {
            const def = funcDefs.get(ast.name);
            const paramMap = new Map(def.params.map((p, i) => [p, ast.args[i]]));
            return recurse(substituteAst(def.body, paramMap));
          }
          throw new CompileError(`Undefined function '${ast.name}'`);
        }
      }
    }
    default: return '0.0';
  }
}

/** Build an AST → JS evaluator function(x, y) with constant values baked in. */
function astToJsFunction(ast, constantValues, funcDefs = new Map()) {
  function gen(node) {
    switch (node.type) {
      case 'number': return String(node.value);
      case 'variable': {
        if (node.name === 'pi') return String(Math.PI);
        if (node.name === 'x') return 'x';
        if (node.name === 'y') return 'y';
        if (constantValues.has(node.name)) return String(constantValues.get(node.name));
        return '0'; // fallback
      }
      case 'derivative': {
        const derivedAst = simplifyAst(differentiateAst(node.arg, node.variable, funcDefs));
        return gen(derivedAst);
      }
      case 'primecall': {
        if (!funcDefs.has(node.name)) return '0';
        const def = funcDefs.get(node.name);
        let bodyAst = def.body;
        for (let i = 0; i < node.order; i++)
          bodyAst = simplifyAst(differentiateAst(bodyAst, def.params[0], funcDefs));
        const paramMap = new Map([[def.params[0], node.args[0]]]);
        return gen(substituteAst(bodyAst, paramMap));
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
          default: {
            if (funcDefs.has(node.name)) {
              const def = funcDefs.get(node.name);
              const paramMap = new Map(def.params.map((p, i) => [p, node.args[i]]));
              return gen(substituteAst(def.body, paramMap));
            }
            return '0';
          }
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

  const funcDefs = analysis.funcDefs || new Map();

  const bodyLines = sortedXYDefs.map(d => {
    const glsl = astToGlsl(d.rhs, constantNames, xyDefNames, funcDefs);
    return `float v_${d.name} = ${glsl};`;
  });
  const bodyCode = bodyLines.join('\n    ');

  // Generate the F = LHS - RHS expression
  const lhsGlsl = astToGlsl(implicitExpr.lhs, constantNames, xyDefNames, funcDefs);
  const rhsGlsl = astToGlsl(implicitExpr.rhs, constantNames, xyDefNames, funcDefs);
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
    if (p.error) {
      // Bare expressions with no x/y are valid constants evaluated elsewhere — don't flag as errors
      if (p.error === 'Expression must contain =') {
        try {
          const ast = parseLatexToAst(e.latex.trim());
          const vars = collectVariables(ast);
          if (!vars.has('x') && !vars.has('y')) {
            return { kind: 'disabled', exprId: e.id };
          }
        } catch (_) {}
      }
      return { kind: 'error', error: p.error, exprId: e.id };
    }
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

    let shaderInfo;
    try {
      shaderInfo = generateShaderCode(impl, analysis);
    } catch (e) {
      analysis.errors.set(impl.exprId, e.message);
      continue;
    }

    // Build JS evaluator for snap-to-curve (inline xy-defs and constants)
    const jsFunc = buildImplicitJsEvaluator(impl, analysis, analysis.funcDefs);
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
function buildImplicitJsEvaluator(implicitExpr, analysis, funcDefs = new Map()) {
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
  function numLit(v) {
    const s = String(v);
    return s.startsWith('-') ? `(${s})` : s;
  }
  function genJs(node) {
    switch (node.type) {
      case 'number': return numLit(node.value);
      case 'variable': {
        if (node.name === 'x') return 'x';
        if (node.name === 'y') return 'y';
        if (constantValues.has(node.name)) return numLit(constantValues.get(node.name));
        // xy-dependent def — use local var
        return 'v_' + node.name;
      }
      case 'primecall': {
        if (!funcDefs.has(node.name)) return '0';
        const def = funcDefs.get(node.name);
        let bodyAst = def.body;
        for (let i = 0; i < node.order; i++)
          bodyAst = simplifyAst(differentiateAst(bodyAst, def.params[0], funcDefs));
        const paramMap = new Map([[def.params[0], node.args[0]]]);
        return genJs(substituteAst(bodyAst, paramMap));
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
          default: {
            if (funcDefs.has(node.name)) {
              const def = funcDefs.get(node.name);
              const paramMap = new Map(def.params.map((p, i) => [p, node.args[i]]));
              return genJs(substituteAst(def.body, paramMap));
            }
            return '0';
          }
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
  } catch (e) {
    console.error('buildImplicitJsEvaluator: new Function failed\n', e.message, '\nbody:\n', body);
    return null;
  }
}


// ── Calculator expression evaluation ────────────────────────────────────────

/**
 * Evaluate all expressions in a calculator box.
 * Returns Map<exprId, { value, boolValue, error }>.
 *
 * Key differences from graph mode:
 * - x and y are treated as regular user-definable variables
 * - Bare expressions (no operator) are evaluated as anonymous values
 * - Disabled expressions that are definitions still contribute their values to
 *   later enabled expressions (they act as hidden constants)
 * - Inequalities (< > <= >= !=) produce { boolValue: true|false }
 * - Equalities where LHS is not a single identifier produce
 *   { boolValue: true|false } using epsilon=1e-9 for floating-point tolerance
 */
function evaluateCalcExpressions(expressions, { usePhysicsConstants = false, usePhysicsBasic = false, usePhysicsEM = false, usePhysicsChem = false, useUnits = false, useSymbolic = false, useBaseUnits = false } = {}) {
  const results  = new Map();   // exprId → { value } | { boolValue } | { error } | { unitAst, warnings }
  const allValues = new Map();  // variable name → number (includes disabled defs)

  // Build the active constants list from enabled groups.
  // usePhysicsConstants is the legacy flag (enables all groups).
  const activeConstants = [
    ...(usePhysicsConstants || usePhysicsBasic ? PHYSICS_CONSTANTS_BASIC : []),
    ...(usePhysicsConstants || usePhysicsEM    ? PHYSICS_CONSTANTS_EM    : []),
    ...(usePhysicsConstants || usePhysicsChem  ? PHYSICS_CONSTANTS_CHEM  : []),
  ];

  // Pre-populate with physics constants so user expressions can reference them.
  // User definitions evaluated in Step 2 take priority and will overwrite any
  // physics constant whose name the user explicitly redefines.
  for (const pc of activeConstants) allValues.set(pc.varName, pc.value);

  // In units mode, build a parallel value map that stores number | ASTNode values.
  // Derived unit symbols are kept as symbolic atoms (not expanded to base units).
  // Physics constants are stored as unit ASTs (value × base-unit expression).
  _activePhysicsChem = !!(usePhysicsConstants || usePhysicsChem);
  let unitValues = null;
  if (useUnits) {
    unitValues = new Map(allValues); // start with same physics constants (as numbers)
    // Override physics constants with unit-carrying ASTs (value × SI base units).
    for (const pc of activeConstants) {
      unitValues.set(pc.varName, buildConstantUnitAst(pc.value, pc.unitDims || {}));
    }
    // Inject liter units as symbolic atoms when chemistry mode is active.
    if (_activePhysicsChem) {
      for (const name of ['μL', 'mL', 'L'])
        if (!unitValues.has(name)) unitValues.set(name, { type: 'variable', name });
    }
  }

  // Track which names have been resolved from *user* definitions (not just
  // pre-populated from physics constants), so Step 2 can override a physics
  // constant when the user explicitly defines a variable with the same name.
  const userResolved = new Set();

  // ── Step 1a: Collect all variable definitions (enabled AND disabled) ──────────
  // First definition for a name wins; subsequent redefinitions are ignored for
  // value resolution (they'll be treated as equations when enabled).
  const allDefs = new Map(); // parsed variable name → { rhsStr, exprId, enabled }
  for (const e of expressions) {
    const trimmed = e.latex.trim();
    if (!trimmed) continue;
    const op = findCalcOperatorAtDepth0(trimmed);
    if (!op || op.op !== '=') continue;
    const lhs = trimmed.slice(0, op.idx).trim();
    if (!/^(?:[a-zA-Z]|\\(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|rho|phi|Phi|omega|hbar))(?:_(?:[a-zA-Z0-9]|\{[^}]*\}))?$/.test(lhs)) continue; // must be a single variable (letter or Greek, optional subscript)
    try {
      const lhsAst = parseLatexToAst(lhs);
      if (lhsAst.type !== 'variable') continue;
      const varName = lhsAst.name; // normalized: 'x_1' for both 'x_1' and 'x_{1}'
      if (!allDefs.has(varName)) {
        allDefs.set(varName, { rhsStr: trimmed.slice(op.idx + 1).trim(), exprId: e.id, enabled: e.enabled });
      }
    } catch (_) { continue; }
  }

  // ── Step 1b: Collect function definitions ────────────────────────────────────
  // f(x) = body — params must not conflict with variable definitions.
  const funcDefs  = new Map(); // name → { params, body: AST, exprId }
  const funcErrors = new Map(); // exprId → error string
  for (const e of expressions) {
    const trimmed = e.latex.trim();
    if (!trimmed) continue;
    const op = findCalcOperatorAtDepth0(trimmed);
    if (!op || op.op !== '=') continue;
    const lhsStr = trimmed.slice(0, op.idx).trim();
    const rhsStr = trimmed.slice(op.idx + 1).trim();
    try {
      const lhsAst = parseLatexToAst(lhsStr);
      if (lhsAst.type !== 'call') continue;              // not a function-call pattern
      if (BUILTIN_CALL_NAMES.has(lhsAst.name)) continue; // e.g. k^t parses as pow(k,t) — not a funcdef
      if (!lhsAst.args.every(a => a.type === 'variable')) continue; // args must be plain variables
      const funcName = lhsAst.name;
      const params = lhsAst.args.map(a => a.name);
      if (funcDefs.has(funcName)) continue; // first definition wins
      funcDefs.set(funcName, { params, body: parseLatexToAst(rhsStr), exprId: e.id });
    } catch (err) {
      funcErrors.set(e.id, err.message);
    }
  }

  // Cycle detection for function definitions (DFS)
  {
    const funcResolved  = new Map();
    const funcResolving = new Set();
    function resolveFunc(name) {
      if (funcResolved.has(name)) return funcResolved.get(name);
      if (!funcDefs.has(name)) return { error: null };
      if (funcResolving.has(name))
        return { error: `Circular function dependency on '${name}'` };
      funcResolving.add(name);
      const def = funcDefs.get(name);
      const calledFuncs = collectFunctionCalls(def.body, funcDefs);
      let error = null;
      for (const calledName of calledFuncs) {
        const r = resolveFunc(calledName);
        if (r.error) { error = r.error; break; }
      }
      funcResolving.delete(name);
      const result = { error };
      funcResolved.set(name, result);
      return result;
    }
    for (const [name, def] of funcDefs) {
      const r = resolveFunc(name);
      if (r.error) {
        funcErrors.set(def.exprId, r.error);
        funcDefs.delete(name);
      }
    }
  }

  // Build a set of all funcDef exprIds so Step 3 can identify them quickly
  const funcDefExprIds = new Set([...funcDefs.values()].map(d => d.exprId));

  // ── Step 2: Evaluate definitions in dependency order ────────────────────────
  // Iterative resolution: each pass evaluates definitions whose dependencies are
  // now known. Stops when no new values are added or max iterations reached.
  const evalErrors = new Map(); // name → last error message
  const maxIter = allDefs.size + 1;
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const [name, def] of allDefs) {
      if (userResolved.has(name)) continue; // already resolved from user definition
      try {
        const rhs = parseLatexToAst(def.rhsStr);
        if (useUnits) {
          const val = evaluateAstSymbolic(rhs, unitValues, funcDefs, { useSymbolic });
          // Store as number in allValues (for non-units paths) if purely numeric,
          // and as number|AST in unitValues for units-mode paths.
          const numericVal = val.type === 'number' ? val.value : NaN;
          if (!isNaN(numericVal)) allValues.set(name, numericVal);
          unitValues.set(name, val.type === 'number' ? val.value : val);
        } else {
          const val = evaluateAst(rhs, allValues, funcDefs);
          allValues.set(name, val); // overrides any pre-populated physics constant
        }
        userResolved.add(name);
        changed = true;
        evalErrors.delete(name);
      } catch (err) {
        evalErrors.set(name, err.message);
      }
    }
    if (!changed) break;
  }

  // Build varAstDefs: variable name → definition AST for derivative expansion.
  // Only includes successfully-resolved definitions whose RHS contains variables
  // (pure numeric constants like b=3 are excluded so they stay symbolic during
  // differentiation and are substituted numerically at evaluation time).
  const varAstDefs = new Map();
  for (const [name, def] of allDefs) {
    if (!userResolved.has(name)) continue;
    try {
      const rhsAst = parseLatexToAst(def.rhsStr);
      if (collectVariables(rhsAst).size > 0) varAstDefs.set(name, rhsAst);
    } catch (_) {}
  }

  // ── Step 3: Evaluate all expressions (enabled and disabled) and record results
  for (const e of expressions) {
    const trimmed = e.latex.trim();
    if (!trimmed) continue;

    // Function definition rows: show error if invalid, otherwise no result
    if (funcErrors.has(e.id)) {
      results.set(e.id, { error: funcErrors.get(e.id) });
      continue;
    }
    if (funcDefExprIds.has(e.id)) continue; // valid funcdef row — no numeric result

    const op = findCalcOperatorAtDepth0(trimmed);

    // Helper: evaluate an AST and return a result object.
    // In units mode, returns { unitAst } for symbolic results; { value } for numeric.
    const evalToResult = (ast) => {
      // Expand derivative args using variable definitions before evaluating,
      // so d/db a correctly resolves a's definition (e.g. a=b^2 → 2b).
      const processed = varAstDefs.size > 0 ? expandDerivatives(ast, varAstDefs, funcDefs) : ast;
      if (useUnits) {
        const warnings = [];
        const val = evaluateAstSymbolic(processed, unitValues, funcDefs, { useSymbolic, warnings });
        if (val.type === 'number') return { value: val.value };
        let unitAst = val;
        try { unitAst = useBaseUnits ? simplifyAstToBase(val) : simplifyAst(val); } catch (_) {}
        return { unitAst, warnings };
      }
      const val = evaluateAst(processed, allValues, funcDefs);
      return { value: val };
    };

    if (!op) {
      // ── Bare expression ──────────────────────────────────────────────────────
      try {
        const ast = parseLatexToAst(trimmed);
        const res = evalToResult(ast);
        if (res.unitAst) {
          results.set(e.id, res);
        } else if (isFinite(res.value)) {
          results.set(e.id, { value: res.value });
        } else {
          results.set(e.id, { error: 'Result is not finite' });
        }
      } catch (err) {
        results.set(e.id, { error: err.message });
      }

    } else if (op.op === '=') {
      const lhsStr = trimmed.slice(0, op.idx).trim();
      const rhsStr = trimmed.slice(op.idx + 1).trim();

      const lhsVarName = (() => {
        if (!/^(?:[a-zA-Z]|\\(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|rho|phi|Phi|omega|hbar))(?:_(?:[a-zA-Z0-9]|\{[^}]*\}))?$/.test(lhsStr)) return null;
        try { const a = parseLatexToAst(lhsStr); return a.type === 'variable' ? a.name : null; } catch (_) { return null; }
      })();
      const isDefiningExpr = lhsVarName !== null && allDefs.has(lhsVarName) && allDefs.get(lhsVarName).exprId === e.id;
      if (isDefiningExpr) {
        // ── Definition (name = expr): show the computed value ────────────────
        if (useUnits && unitValues.has(lhsVarName)) {
          const v = unitValues.get(lhsVarName);
          if (typeof v === 'number') results.set(e.id, { value: v });
          else { let unitAst = v; try { unitAst = useBaseUnits ? simplifyAstToBase(v) : simplifyAst(v); } catch (_) {} results.set(e.id, { unitAst, warnings: [] }); }
        } else if (!useUnits && allValues.has(lhsVarName)) {
          results.set(e.id, { value: allValues.get(lhsVarName) });
        } else {
          const errMsg = evalErrors.get(lhsVarName) || `Could not evaluate '${lhsStr}'`;
          results.set(e.id, { error: errMsg });
        }
      } else {
        // ── Equation (non-name lhs = rhs): evaluate both sides and compare ───
        try {
          const lhsRes = evalToResult(parseLatexToAst(lhsStr));
          const rhsRes = evalToResult(parseLatexToAst(rhsStr));

          
          if (lhsRes.value !== undefined && rhsRes.value !== undefined) {
            
            //The average scale of the values so that differences in tiny values don't get marked as a rounding error. 
            let scale = 10**Math.ceil(
              Math.min(-Math.log10(0.5*(Math.abs(lhsRes.value)+Math.abs(rhsRes.value))),1e-10)
            );
            if(scale==Infinity){
              scale=1;
            }
            console.log(0.5*(Math.abs(lhsRes.value)+Math.abs(rhsRes.value)),scale);
            

            results.set(e.id, { boolValue: Math.abs(lhsRes.value - rhsRes.value)*scale < 1e-9 });
          } else if (lhsRes.unitAst && rhsRes.unitAst) {
            const lSig = astToUnitSignature(lhsRes.unitAst);
            const rSig = astToUnitSignature(rhsRes.unitAst);
            if (lSig && rSig && _unitSigsMatchUnits(lSig.units, rSig.units)) {
              results.set(e.id, { boolValue: Math.abs(lSig.coeff - rSig.coeff) < 1e-9 });
            } else if (lSig && rSig) {
              results.set(e.id, { error: 'Incompatible units' });
            } else {
              results.set(e.id, lhsRes.unitAst ? lhsRes : { error: 'Cannot compare symbolic expressions' });
            }
          } else {
            // Symbolic — can't compare numerically; show the LHS result
            results.set(e.id, lhsRes.unitAst ? lhsRes : { error: 'Cannot compare symbolic expressions' });
          }
        } catch (err) {
          results.set(e.id, { error: err.message });
        }
      }

    } else {
      // ── Inequality: evaluate both sides and compare ──────────────────────
      try {
        const lhsStr = trimmed.slice(0, op.idx).trim();
        const rhsStr = trimmed.slice(op.idx + op.len).trim();
        const lhsRes = evalToResult(parseLatexToAst(lhsStr));
        const rhsRes = evalToResult(parseLatexToAst(rhsStr));
        if (lhsRes.value !== undefined && rhsRes.value !== undefined) {
          let boolValue;
          switch (op.op) {
            case '<':  boolValue = lhsRes.value < rhsRes.value; break;
            case '>':  boolValue = lhsRes.value > rhsRes.value; break;
            case '<=': boolValue = lhsRes.value <= rhsRes.value; break;
            case '>=': boolValue = lhsRes.value >= rhsRes.value; break;
            case '!=': boolValue = Math.abs(lhsRes.value - rhsRes.value) > 1e-9; break;
            default:   boolValue = false;
          }
          results.set(e.id, { boolValue });
        } else if (lhsRes.unitAst && rhsRes.unitAst) {
          const lSig = astToUnitSignature(lhsRes.unitAst);
          const rSig = astToUnitSignature(rhsRes.unitAst);
          if (lSig && rSig && _unitSigsMatchUnits(lSig.units, rSig.units)) {
            let boolValue;
            switch (op.op) {
              case '<':  boolValue = lSig.coeff < rSig.coeff; break;
              case '>':  boolValue = lSig.coeff > rSig.coeff; break;
              case '<=': boolValue = lSig.coeff <= rSig.coeff; break;
              case '>=': boolValue = lSig.coeff >= rSig.coeff; break;
              case '!=': boolValue = Math.abs(lSig.coeff - rSig.coeff) > 1e-9; break;
              default:   boolValue = false;
            }
            results.set(e.id, { boolValue });
          } else if (lSig && rSig) {
            results.set(e.id, { error: 'Incompatible units' });
          } else {
            results.set(e.id, { error: 'Cannot compare symbolic expressions' });
          }
        } else {
          results.set(e.id, { error: 'Cannot compare symbolic expressions' });
        }
      } catch (err) {
        results.set(e.id, { error: err.message });
      }
    }
  }

  return results;
}
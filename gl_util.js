'use strict';

// ── WebGL2 Utilities ─────────────────────────────────────────────────────────
// All functions take a `gl` (WebGL2RenderingContext) parameter — no globals.

const GL = {

  GENERIC_VS: `#version 300 es
precision mediump float;
in vec2 a_position;
out vec2 v_position;
void main() {
    v_position = a_position;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`,

  createShaderProgram(gl, vsCode, fsCode) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(vs, vsCode);
    gl.shaderSource(fs, fsCode);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(vs);
      gl.deleteShader(vs); gl.deleteShader(fs);
      throw new Error('Vertex shader compile error:\n' + log);
    }
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      gl.deleteShader(vs); gl.deleteShader(fs);
      throw new Error('Fragment shader compile error:\n' + log);
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('Shader link error:\n' + log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  },

  /**
   * Start async shader compilation. Submits compile+link without blocking.
   * Call finalizeShaderProgram() once ready (poll with KHR_parallel_shader_compile
   * or just call it on the next frame — the GPU will have had time to compile).
   */
  beginShaderProgram(gl, vsCode, fsCode) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(vs, vsCode);
    gl.shaderSource(fs, fsCode);
    gl.compileShader(vs);
    gl.compileShader(fs);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    return { program, vs, fs };
  },

  /** Complete an async compile started with beginShaderProgram. May throw on error. */
  finalizeShaderProgram(gl, handle) {
    const { program, vs, fs } = handle;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('Shader link error:\n' + log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  },

  createTexture(gl, w, h, data) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  },

  /** Create a fullscreen triangle VAO (covers the clip-space quad). */
  createFullscreenTriangle(gl, program) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Large triangle that covers [-1,1]^2
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -1, 2, -1, 0, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  },
};

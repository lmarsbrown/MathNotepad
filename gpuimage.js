'use strict';

// ── GPUImage: double-buffered RGBA32F texture pair ───────────────────────────
// Used as a ping-pong render target for multi-pass GPU rendering.

class GPUImage {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} width
   * @param {number} height
   */
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    this.frontTex = GL.createTexture(gl, width, height, null);
    this.backTex  = GL.createTexture(gl, width, height, null);

    this.frontFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frontFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.frontTex, 0);

    this.backFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.backFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.backTex, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  swapBuffers() {
    let t;
    t = this.frontTex; this.frontTex = this.backTex; this.backTex = t;
    t = this.frontFb;  this.frontFb  = this.backFb;  this.backFb  = t;
  }

  /** Clear both buffers to transparent black. */
  clear() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frontFb);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.backFb);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(w, h) {
    if (w === this.width && h === this.height) return;
    this.destroy();
    const gl = this.gl;
    this.width = w;
    this.height = h;

    this.frontTex = GL.createTexture(gl, w, h, null);
    this.backTex  = GL.createTexture(gl, w, h, null);

    this.frontFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frontFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.frontTex, 0);

    this.backFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.backFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.backTex, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.frontTex);
    gl.deleteTexture(this.backTex);
    gl.deleteFramebuffer(this.frontFb);
    gl.deleteFramebuffer(this.backFb);
  }
}

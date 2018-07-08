import defined from 'defined';
import assign from 'object-assign';
import getCanvasContext from 'get-canvas-context';
import rightNow from 'right-now';
import isPromise from 'is-promise';
import PaperSize from './paper-sizes';
import { getDimensionsFromPreset, convertDistance } from './distances';
import { isWebGLContext, isCanvas, getClientAPI } from './util';
import deepEqual from 'deep-equal';
import { saveFile, saveDataURL, getFileName } from './save';

const isBrowser = () => typeof document !== 'undefined';

// When no { dimension } is passed in node, we default to HTML canvas size
const defaultNodeSize = [ 300, 150 ];

class SketchManager {
  constructor () {
    this._settings = {};
    this._props = {};
    this._sketch = undefined;
    this._raf = null;

    // Some hacky things required to get around p5.js structure
    this._lastRedrawResult = undefined;
    this._isP5Resizing = false;

    this._animateHandler = () => this.animate();

    this._resizeHandler = () => {
      const oldSizes = this._getSizeProps();
      this.resize();

      // This is to avoid unnecessary re-renders on resize,
      // as a lot of generative art projects can be slow to render.
      const newSizes = this._getSizeProps();
      if (!deepEqual(oldSizes, newSizes)) {
        this.render();
      }
    };

    this._exportHandler = ev => {
      if (this.settings.hotkeys === false) return;

      const client = getClientAPI();
      if (ev.keyCode === 83 && !ev.altKey && (ev.metaKey || ev.ctrlKey)) {
        // Cmd + S
        ev.preventDefault();
        if (ev.shiftKey) {
          if (this.props.recording) {
            this.endRecord();
            this.play();
          } else this.record();
        } else this.exportFrame();
      } else if (ev.keyCode === 32) {
        // Space
        // TODO: what to do with this? keep it, or remove it?
        if (this.props.playing) this.pause();
        else this.play();
      } else if (client && !ev.altKey && ev.keyCode === 75 && (ev.metaKey || ev.ctrlKey)) {
        // Cmd + K, only when canvas-sketch-cli is used
        ev.preventDefault();
        this.exportFrame({ commit: true });
      }
    };
  }

  get sketch () {
    return this._sketch;
  }

  get settings () {
    return this._settings;
  }

  get props () {
    return this._props;
  }

  _computePlayhead (currentTime, duration) {
    const hasDuration = typeof duration === 'number' && isFinite(duration);
    return hasDuration ? currentTime / duration : 0;
  }

  _computeFrame (playhead, time, totalFrames, fps) {
    return (isFinite(totalFrames) && totalFrames > 1)
      ? Math.floor(playhead * (totalFrames - 1))
      : Math.floor(fps * time);
  }

  _computeCurrentFrame () {
    return this._computeFrame(
      this.props.playhead, this.props.time,
      this.props.totalFrames, this.props.fps
    );
  }

  _getSizeProps () {
    const props = this.props;
    return {
      width: props.width,
      height: props.height,
      pixelRatio: props.pixelRatio,
      canvasWidth: props.canvasWidth,
      canvasHeight: props.canvasHeight,
      viewportWidth: props.viewportWidth,
      viewportHeight: props.viewportHeight
    };
  }

  run () {
    if (!this.sketch) throw new Error('should wait until sketch is loaded before trying to play()');

    // Start an animation frame loop if necessary
    if (this.settings.playing !== false) {
      this.play();
    }

    // In case we aren't playing or animated, make sure we still trigger begin message...
    if (!this.props.started) {
      this._signalBegin();
      this.props.started = true;
    }

    // Render an initial frame
    this.tick();
    this.render();
  }

  play () {
    let animate = this.settings.animate;
    if ('animation' in this.settings) {
      animate = true;
      console.warn('[canvas-sketch] { animation } has been renamed to { animate }');
    }
    if (!animate) return;
    if (!isBrowser()) {
      console.error('[canvas-sketch] WARN: Using { animate } in Node.js is not yet supported');
      return;
    }
    if (!this.props.started) {
      this._signalBegin();
      this.props.started = true;
    }
    // Start a render loop
    this.props.playing = true;
    if (this._raf != null) window.cancelAnimationFrame(this._raf);
    this._lastTime = rightNow();
    this._raf = window.requestAnimationFrame(this._animateHandler);
  }

  pause () {
    if (this.props.recording) this.endRecord();
    this.props.playing = false;
    if (this._raf != null && isBrowser()) window.cancelAnimationFrame(this._raf);
  }

  // Stop and reset to frame zero
  stop () {
    this.pause();
    this.props.frame = 0;
    this.props.playhead = 0;
    this.props.time = 0;
    this.props.deltaTime = 0;
    this.props.started = false;
    this.render();
  }

  record () {
    if (this.props.recording) return;
    if (!isBrowser()) {
      console.error('[canvas-sketch] WARN: Recording from Node.js is not yet supported');
      return;
    }
    this.stop();
    this.props.playing = true;
    this.props.recording = true;

    const frameInterval = 1 / this.props.fps;
    // Render each frame in the sequence
    if (this._raf != null) window.cancelAnimationFrame(this._raf);
    const tick = () => {
      if (!this.props.recording) return Promise.resolve();
      this.props.deltaTime = frameInterval;
      this.tick();
      return this.exportFrame({ sequence: true })
        .then(() => {
          if (!this.props.recording) return; // was cancelled before
          this.props.deltaTime = 0;
          this.props.frame++;
          if (this.props.frame < this.props.totalFrames) {
            this.props.time += frameInterval;
            this.props.playhead = this._computePlayhead(this.props.time, this.props.duration);
            this._raf = window.requestAnimationFrame(tick);
          } else {
            console.log('Finished recording');
            this._signalEnd();
            this.endRecord();
            this.stop();
            this.run();
          }
        });
    };

    // Trigger a start event before we begin recording
    if (!this.props.started) {
      this._signalBegin();
      this.props.started = true;
    }

    this._raf = window.requestAnimationFrame(tick);
  }

  _signalBegin () {
    if (this.sketch && typeof this.sketch.begin === 'function') {
      this._wrapContextScale(() => this.sketch.begin(this.props));
    }
  }

  _signalEnd () {
    if (this.sketch && typeof this.sketch.end === 'function') {
      this._wrapContextScale(() => this.sketch.end(this.props));
    }
  }

  endRecord () {
    if (this._raf != null && isBrowser()) window.cancelAnimationFrame(this._raf);
    this.props.recording = false;
    this.props.deltaTime = 0;
  }

  exportFrame (opt = {}) {
    if (!this.sketch) return Promise.all([]);
    if (typeof this.sketch.preExport === 'function') {
      this.sketch.preExport();
    }

    // Options for export function
    let exportOpts = assign({
      sequence: opt.sequence,
      frame: opt.sequence ? this.props.frame : undefined,
      file: this.settings.file,
      name: this.settings.name,
      prefix: this.settings.prefix,
      suffix: this.settings.suffix,
      timeStamp: getFileName(),
      totalFrames: isFinite(this.props.totalFrames) ? Math.max(100, this.props.totalFrames) : 1000
    });

    const client = getClientAPI();
    let p = Promise.resolve();
    if (client && opt.commit && typeof client.commit === 'function') {
      const commitOpts = assign({}, exportOpts);
      const hash = client.commit(commitOpts);
      if (isPromise(hash)) p = hash;
      else p = Promise.resolve(hash);
    }

    return p.then(hash => {
      return this._doExportFrame(assign({}, exportOpts, { hash: hash || '' }));
    });
  }

  _doExportFrame (exportOpts = {}) {
    this._props.exporting = true;

    // Resize to output resolution
    this.resize();

    // Draw at this output resolution
    let drawResult = this.render();

    // The self owned canvas (may be undefined...!)
    const canvas = this.props.canvas;

    // Get list of results from render
    if (typeof drawResult === 'undefined') {
      drawResult = [ canvas ];
    }
    drawResult = [].concat(drawResult).filter(Boolean);

    // Transform the canvas/file descriptors into a consistent format,
    // and pull out any data URLs from canvas elements
    drawResult = drawResult.map(result => {
      const hasDataObject = typeof result === 'object' && result && 'data' in result;
      const data = hasDataObject ? result.data : result;
      const opts = hasDataObject ? assign({}, result, { data }) : { data };

      if (isCanvas(data)) {
        // Provide data URL hint
        return Object.assign(opts, { url: data.toDataURL('image/png'), extension: '.png', type: 'image/png' });
      } else {
        return opts;
      }
    });

    // Now return to regular rendering mode
    this._props.exporting = false;
    this.resize();
    this.render();

    // And now we can save each result
    return Promise.all(drawResult.map((result, i, layerList) => {
      // By default, if rendering multiple layers we will give them indices
      const curOpt = assign({}, exportOpts, result, { layer: i, totalLayers: layerList.length });
      const data = result.data;
      if (result.url) {
        const url = result.url;
        delete curOpt.url; // avoid sending entire base64 data around
        return saveDataURL(url, curOpt);
      } else {
        return saveFile(data, curOpt);
      }
    })).then(ev => {
      if (ev.length > 0) {
        const eventWithOutput = ev.find(e => e.outputName);
        const isClient = ev.some(e => e.client);
        let item;
        // many files, just log how many were exported
        if (ev.length > 1) item = ev.length;
        // in CLI, we know exact path dirname
        else if (eventWithOutput) item = `${eventWithOutput.outputName}/${ev[0].filename}`;
        // in browser, we can only know it went to "browser download folder"
        else item = `${ev[0].filename}`;
        let ofSeq = '';
        if (exportOpts.sequence) {
          const hasTotalFrames = isFinite(this.props.totalFrames);
          ofSeq = hasTotalFrames ? ` (frame ${exportOpts.frame + 1} / ${this.props.totalFrames})` : ` (frame ${exportOpts.frame})`;
        }
        const client = isClient ? 'canvas-sketch-cli' : 'canvas-sketch';
        console.log(`%c[${client}]%c Exported %c${item}%c${ofSeq}`, 'color: #8e8e8e;', 'color: initial;', 'font-weight: bold;', 'font-weight: initial;');
      }
      if (typeof this.sketch.postExport === 'function') {
        this.sketch.postExport();
      }
    });
  }

  _isAutoScale () {
    return !this.props.gl && this.settings.scaleContext !== false;
  }

  _wrapContextScale (cb) {
    this._preRender();
    cb();
    this._postRender();
  }

  _preRender () {
    const props = this.props;
    const autoScale = this._isAutoScale();

    // Scale context for unit sizing
    if (autoScale && props.context && !props.p5) {
      props.context.save();
      props.context.scale(props.scaleX, props.scaleY);
    } else if (props.p5) {
      props.p5.scale(props.scaleX / props.pixelRatio, props.scaleY / props.pixelRatio);
    }
  }

  _postRender () {
    const props = this.props;
    const autoScale = this._isAutoScale();

    if (autoScale && props.context && !props.p5) {
      props.context.restore();
    }

    // Flush by default, this may be revisited at a later point.
    // We do this to ensure toDataURL can be called immediately after.
    // Most likely browsers already handle this, so we may revisit this and
    // remove it if it improves performance without any usability issues.
    if (props.gl && this.settings.flush !== false && !props.p5) {
      props.gl.flush();
    }
  }

  tick () {
    if (this.sketch && typeof this.sketch.tick === 'function') {
      this._preRender();
      this.sketch.tick(this.props);
      this._postRender();
    }
  }

  render () {
    if (this.props.p5) {
      this._lastRedrawResult = undefined;
      this.props.p5.redraw();
      return this._lastRedrawResult;
    } else {
      return this.submitDrawCall();
    }
  }

  submitDrawCall () {
    if (!this.sketch) return;

    const props = this.props;
    this._preRender();

    let drawResult;

    if (typeof this.sketch === 'function') {
      drawResult = this.sketch(props);
    } else if (typeof this.sketch.render === 'function') {
      drawResult = this.sketch.render(props);
    }

    this._postRender();

    return drawResult;
  }

  update (opt = {}) {
    // Currently update() is only focused on resizing,
    // but later we will support other options like switching
    // frames and such.
    const notYetSupported = [
      'frame', 'time', 'duration',
      'totalFrames', 'fps', 'playing', 'animation'
    ];

    Object.keys(opt).forEach(key => {
      if (notYetSupported.indexOf(key) >= 0) {
        throw new Error(`Sorry, the { ${key} } option is not yet supported with update().`);
      }
    });

    const oldCanvas = this._settings.canvas;
    const oldContext = this._settings.context;

    // Merge new options into settings
    for (let key in opt) {
      const value = opt[key];
      if (typeof value !== 'undefined') { // ignore undefined
        this._settings[key] = value;
      }
    }

    // If either canvas or context is changed, we should re-update
    if (oldCanvas !== this._settings.canvas || oldContext !== this._settings.context) {
      const { canvas, context } = this._setupCanvas(this._settings);

      this.props.canvas = canvas;
      this.props.context = context;

      // Delete or add a 'gl' prop for convenience
      this._setupGLKey();

      // Re-mount the new canvas if it has no parent
      this._appendCanvasIfNeeded();
    }

    // Special case to support P5.js
    if (opt.p5 && typeof opt.p5 !== 'function') {
      this.props.p5 = opt.p5;
      this.props.p5.draw = () => {
        if (this._isP5Resizing) return;
        this._lastRedrawResult = this.submitDrawCall();
      };
    }

    // Draw new frame
    this.resize();
    this.render();
    return this.props;
  }

  _hasDimensions () {
    const settings = this.settings;
    if (!settings.dimensions) return false;
    if (typeof settings.dimensions === 'string') return true;
    if (Array.isArray(settings.dimensions) && settings.dimensions.length >= 2) return true;
    return false;
  }

  resize () {
    let width, height;
    let styleWidth, styleHeight;
    let canvasWidth, canvasHeight;

    const settings = this.settings;

    const dimensions = settings.dimensions;
    const hasDimensions = this._hasDimensions();
    const exporting = this.props.exporting;
    const scaleToFit = hasDimensions ? settings.scaleToFit !== false : false;
    const scaleToView = (!exporting && hasDimensions) ? settings.scaleToView : true;
    const units = settings.units;
    const pixelsPerInch = (typeof settings.pixelsPerInch === 'number' && isFinite(settings.pixelsPerInch)) ? settings.pixelsPerInch : 72;
    const bleed = defined(settings.bleed, 0);

    const defaultPixelRatio = isBrowser() ? window.devicePixelRatio : 1;
    let pixelRatio = defined(settings.pixelRatio, defaultPixelRatio);
    if (typeof settings.maxPixelRatio === 'number') {
      pixelRatio = Math.min(settings.maxPixelRatio, pixelRatio);
    }

    if (!scaleToView) {
      pixelRatio = 1;
    }

    const defaultWidth = isBrowser() ? window.innerWidth : defaultNodeSize[0];
    const defaultHeight = isBrowser() ? window.innerWidth : defaultNodeSize[1];
    let parentWidth = defaultWidth;
    let parentHeight = defaultHeight;
    let trimWidth, trimHeight;

    // You can specify a dimensions in pixels or cm/m/in/etc
    if (hasDimensions) {
      const result = getDimensionsFromPreset(dimensions, units, pixelsPerInch);
      const highest = Math.max(result[0], result[1]);
      const lowest = Math.min(result[0], result[1]);
      if (settings.orientation) {
        const landscape = settings.orientation === 'landscape';
        width = landscape ? highest : lowest;
        height = landscape ? lowest : highest;
      } else {
        width = result[0];
        height = result[1];
      }

      trimWidth = width;
      trimHeight = height;

      // Apply bleed which is assumed to be in the same units
      width += bleed * 2;
      height += bleed * 2;
    } else {
      width = parentWidth;
      height = parentHeight;
      trimWidth = width;
      trimHeight = height;
    }

    // Real size in pixels after PPI is taken into account
    let realWidth = width;
    let realHeight = height;
    if (hasDimensions && units) {
      // Convert to digital/pixel units if necessary
      realWidth = convertDistance(width, units, 'px', pixelsPerInch);
      realHeight = convertDistance(height, units, 'px', pixelsPerInch);
    }

    // How big to set the 'view' of the canvas in the browser (i.e. style)
    styleWidth = Math.round(realWidth);
    styleHeight = Math.round(realHeight);

    // If we wish to scale the view to the browser window
    if (scaleToFit && !exporting && hasDimensions) {
      const aspect = width / height;
      const windowAspect = parentWidth / parentHeight;
      const scaleToFitPadding = defined(settings.scaleToFitPadding, 40);
      const maxWidth = Math.round(parentWidth - scaleToFitPadding * 2);
      const maxHeight = Math.round(parentHeight - scaleToFitPadding * 2);
      if (styleWidth > maxWidth || styleHeight > maxHeight) {
        if (windowAspect > aspect) {
          styleHeight = maxHeight;
          styleWidth = Math.round(styleHeight * aspect);
        } else {
          styleWidth = maxWidth;
          styleHeight = Math.round(styleWidth / aspect);
        }
      }
    }

    // e.g. @2x exporting for PNG sprites
    let exportPixelRatio = 1;
    if (exporting) {
      exportPixelRatio = defined(settings.exportPixelRatio, hasDimensions ? 1 : pixelRatio);
      pixelRatio = exportPixelRatio;
    }

    canvasWidth = scaleToView ? Math.round(pixelRatio * styleWidth) : Math.round(exportPixelRatio * realWidth);
    canvasHeight = scaleToView ? Math.round(pixelRatio * styleHeight) : Math.round(exportPixelRatio * realHeight);

    const viewportWidth = scaleToView ? Math.round(styleWidth) : Math.round(realWidth);
    const viewportHeight = scaleToView ? Math.round(styleHeight) : Math.round(realHeight);

    const scaleX = canvasWidth / width;
    const scaleY = canvasHeight / height;

    // Assign to current props
    Object.assign(this._props, {
      bleed,
      pixelRatio,
      width,
      height,
      scaleX,
      scaleY,
      viewportWidth,
      viewportHeight,
      canvasWidth,
      canvasHeight,
      trimWidth,
      trimHeight,
      styleWidth,
      styleHeight
    });

    // Update canvas settings
    const canvas = this.props.canvas;
    if (canvas && settings.resizeCanvas !== false) {
      if (this.props.p5) {
        // P5.js specific edge case
        if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
          this._isP5Resizing = true;
          // This causes a re-draw :\ so we ignore draws in the mean time... sorta hacky
          this.props.p5.pixelDensity(pixelRatio);
          this.props.p5.resizeCanvas(canvasWidth / pixelRatio, canvasHeight / pixelRatio, false);
          this._isP5Resizing = false;
        }
      } else {
        // Force canvas size
        if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
        if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
      }
      // Update canvas style
      if (isBrowser()) {
        canvas.style.width = `${styleWidth}px`;
        canvas.style.height = `${styleHeight}px`;
      }
    }

    // Send resize event to sketch
    if (this.sketch && typeof this.sketch.resize === 'function') {
      this.sketch.resize(this.props);
    }
  }

  animate () {
    if (!this.props.playing) return;
    if (!isBrowser()) {
      console.error('[canvas-sketch] WARN: Animation in Node.js is not yet supported');
      return;
    }
    this._raf = window.requestAnimationFrame(this._animateHandler);

    let now = rightNow();

    const fps = this.props.fps;
    const frameIntervalMS = 1000 / fps;
    let deltaTimeMS = now - this._lastTime;

    const duration = this.props.duration;
    const hasDuration = typeof duration === 'number' && isFinite(duration);

    let isNewFrame = true;
    const playbackRate = this.settings.playbackRate;
    if (playbackRate === 'fixed') {
      deltaTimeMS = frameIntervalMS;
    } else if (playbackRate === 'throttle') {
      if (deltaTimeMS > frameIntervalMS) {
        now = now - (deltaTimeMS % frameIntervalMS);
        this._lastTime = now;
      } else {
        isNewFrame = false;
      }
    } else {
      this._lastTime = now;
    }

    const deltaTime = deltaTimeMS / 1000;
    let newTime = this.props.time + deltaTime * this.props.timeScale;

    // Handle reverse time scale
    if (newTime < 0 && hasDuration) {
      newTime = duration + newTime;
    }

    // Re-start animation
    let isFinished = false;
    let isLoopStart = false;

    const looping = this.settings.loop !== false;
    if (hasDuration && newTime >= duration) {
      // Re-start animation
      if (looping) {
        isNewFrame = true;
        newTime = newTime % duration;
        isLoopStart = true;
      } else {
        isNewFrame = false;
        newTime = duration;
        isFinished = true;
      }

      this._signalEnd();
    }

    if (isNewFrame) {
      this.props.deltaTime = deltaTime;
      this.props.time = newTime;
      this.props.playhead = this._computePlayhead(newTime, duration);
      const lastFrame = this.props.frame;
      this.props.frame = this._computeCurrentFrame();
      if (isLoopStart) this._signalBegin();
      if (lastFrame !== this.props.frame) this.tick();
      this.render();
      this.props.deltaTime = 0;
    }

    if (isFinished) {
      this.pause();
    }
  }

  mount () {
    this._appendCanvasIfNeeded();
  }

  unmount () {
    if (isBrowser()) {
      window.removeEventListener('resize', this._resizeHandler);
      window.removeEventListener('keydown', this._exportHandler);
    }
  }

  _appendCanvasIfNeeded () {
    if (!isBrowser()) return;
    if (this.props.canvas && !this.props.canvas.parentElement) {
      // At some point we can let this be configurable...
      const defaultParent = document.body;
      defaultParent.appendChild(this.props.canvas);
    }
  }

  _createCanvas () {
    if (!isBrowser()) {
      throw new Error('It appears you are runing from Node.js or a non-browser environment. Try passing in an existing { canvas } interface instead.');
    }
    return document.createElement('canvas');
  }

  _setupCanvas (settings) {
    let context, canvas;
    if (settings.canvas !== false) {
      // Determine the canvas and context to create
      context = settings.context;
      if (!context || typeof context === 'string') {
        const newCanvas = settings.canvas || this._createCanvas();
        const type = context || '2d';
        context = getCanvasContext(type, assign({}, settings.attributes, { canvas: newCanvas }));
        if (!context) {
          throw new Error(`Failed at canvas.getContext('${type}') - the browser may not support this context, or a different context may already be in use with this canvas.`);
        }
      }

      canvas = context.canvas;
      // Ensure context matches user's canvas expectations
      if (settings.canvas && canvas !== settings.canvas) {
        throw new Error('The { canvas } and { context } settings must point to the same underlying canvas element');
      }

      // Apply pixelation to canvas if necessary, this is mostly a convenience utility
      if (settings.pixelated) {
        context.imageSmoothingEnabled = false;
        context.mozImageSmoothingEnabled = false;
        context.oImageSmoothingEnabled = false;
        context.webkitImageSmoothingEnabled = false;
        context.msImageSmoothingEnabled = false;
        canvas.style['image-rendering'] = 'pixelated';
      }
    }
    return { canvas, context };
  }

  _setupGLKey () {
    if (this.props.context) {
      if (isWebGLContext(this.props.context)) {
        this._props.gl = this.props.context;
      } else {
        delete this._props.gl;
      }
    }
  }

  setup (settings = {}) {
    if (this.sketch) throw new Error('Multiple setup() calls not yet supported.');

    this._settings = Object.assign({}, settings, this._settings);

    // Get initial canvas & context
    const { context, canvas } = this._setupCanvas(this._settings);

    // Get timing data
    let duration = settings.duration;
    let totalFrames = settings.totalFrames;
    const timeScale = defined(settings.timeScale, 1);
    const fps = defined(settings.fps, 30);
    const hasDuration = typeof duration === 'number' && isFinite(duration);
    const hasTotalFrames = typeof totalFrames === 'number' && isFinite(totalFrames);

    const totalFramesFromDuration = hasDuration ? Math.floor(fps * duration) : undefined;
    const durationFromTotalFrames = hasTotalFrames ? (totalFrames / fps) : undefined;
    if (hasDuration && hasTotalFrames && totalFramesFromDuration !== totalFrames) {
      throw new Error('You should specify either duration or totalFrames, but not both. Or, they must match exactly.');
    }

    totalFrames = defined(totalFrames, totalFramesFromDuration, Infinity);
    duration = defined(duration, durationFromTotalFrames, Infinity);

    const startTime = settings.time;
    const startFrame = settings.frame;
    const hasStartTime = typeof startTime === 'number' && isFinite(startTime);
    const hasStartFrame = typeof startFrame === 'number' && isFinite(startFrame);

    // start at zero unless user specifies frame or time (but not both mismatched)
    let time = 0;
    let frame = 0;
    let playhead = 0;
    if (hasStartTime && hasStartFrame) {
      throw new Error('You should specify either start frame or time, but not both.');
    } else if (hasStartTime) {
      // User specifies time, we infer frames from FPS
      time = startTime;
      playhead = this._computePlayhead(time, duration);
      frame = this._computeFrame(
        playhead, time,
        totalFrames, fps
      );
    } else if (hasStartFrame) {
      // User specifies frame number, we infer time from FPS
      frame = startFrame;
      time = frame / fps;
      playhead = this._computePlayhead(time, duration);
    }

    // Initial render state features
    this._props = {
      canvas,
      context,
      fps,
      frame,
      time,
      deltaTime: 0,
      playhead,
      duration,
      started: false,
      exporting: false,
      playing: false,
      recording: false,
      totalFrames,
      timeScale,
      settings: this.settings,

      // Export some specific actions to the sketch
      render: () => this.render(),
      tick: () => this.tick(),
      resize: () => this.resize(),
      update: (opt) => this.update(opt),
      exportFrame: opt => this.exportFrame(opt),
      record: () => this.record(),
      play: () => this.play(),
      pause: () => this.pause(),
      stop: () => this.stop()
    };

    // For WebGL sketches, a gl variable reads a bit better
    this._setupGLKey();

    // Trigger initial resize now so that canvas is already sized
    // by the time we load the sketch
    this.resize();
  }

  load (createSketch) {
    // User didn't specify a function
    if (typeof createSketch !== 'function') {
      throw new Error('The function must take in a function as the first parameter. Example:\n  canvasSketcher(() => { ... }, settings)');
    }

    // This is a bit of a tricky case; we set up the auto-scaling here
    // in case the user decides to render anything to the context *before* the
    // render() function... However, users should instead use begin() function for that.
    this._preRender();

    let preload = Promise.resolve();

    // Because of P5.js's unusual structure, we have to do a bit of
    // library-specific changes to support it properly.
    if (this.settings.p5) {
      if (!isBrowser()) {
        throw new Error('[canvas-sketch] ERROR: Using p5.js in Node.js is not supported');
      }
      preload = new Promise(resolve => {
        let P5Constructor = this.settings.p5;
        let preload;
        if (P5Constructor.p5) {
          preload = P5Constructor.preload;
          P5Constructor = P5Constructor.p5;
        }

        // The sketch setup; disable loop, set sizing, etc.
        const p5Sketch = p5 => {
          // Hook in preload if necessary
          if (preload) p5.preload = () => preload(p5);
          p5.setup = () => {
            const props = this.props;
            const isGL = this.settings.context === 'webgl';
            const renderer = isGL ? p5.WEBGL : p5.P2D;
            p5.noLoop();
            p5.pixelDensity(props.pixelRatio);
            p5.createCanvas(props.viewportWidth, props.viewportHeight, renderer);
            if (isGL && this.settings.attributes) {
              p5.setAttributes(this.settings.attributes);
            }

            this.update({ p5, canvas: p5.canvas, context: p5._renderer.drawingContext });
            resolve();
          };
        };

        // Support global and instance P5.js modes
        if (typeof P5Constructor === 'function') {
          new P5Constructor(p5Sketch);
        } else {
          if (typeof window.createCanvas !== 'function') {
            throw new Error("{ p5 } setting is passed but can't find p5.js in global (window) scope. Maybe you did not create it globally?\nnew p5(); // <-- attaches to global scope");
          }
          p5Sketch(window);
        }
      });
    }

    return preload.then(() => {
      // Load the user's sketch
      let loader = createSketch(this.props);
      if (!isPromise(loader)) {
        loader = Promise.resolve(loader);
      }
      return loader;
    }).then(sketch => {
      if (!sketch) sketch = {};
      this._sketch = sketch;

      // Once the sketch is loaded we can add the events
      if (isBrowser()) {
        window.addEventListener('keydown', this._exportHandler);
        window.addEventListener('resize', this._resizeHandler);
      }

      this._postRender();

      // Send an initial 'resize' event now that the sketch
      // has been configured and loaded
      if (typeof this._sketch.resize === 'function') {
        this.sketch.resize(this.props);
      }
    }).catch(err => {
      console.warn('Could not start sketch, the async loading function rejected with an error:\n    Error: ' + err.message);
      throw err;
    });
  }
}

export { default as PaperSize } from './paper-sizes';

function canvasSketch (sketch, settings = {}) {
  if (settings.p5) {
    if (settings.canvas || (settings.context && typeof settings.context !== 'string')) {
      throw new Error(`In { p5 } mode, you can't pass your own canvas or context, unless the context is a "webgl" or "2d" string`);
    }

    // Do not create a canvas on startup, since P5.js does that for us
    const context = typeof settings.context === 'string' ? settings.context : false;
    settings = Object.assign({}, settings, { canvas: false, context });
  }

  const manager = new SketchManager();
  if (sketch) {
    // Apply settings and create a canvas
    manager.setup(settings);
    // Mount the sketch to its parent element (or document.body)
    manager.mount();
    // Load the sketch
    return manager.load(sketch).then(() => {
      // Start playback/rendering
      manager.run();
      return manager;
    });
  }
  return Promise.resolve(manager);
}

// TODO: Figure out a nice way to export things.
canvasSketch.canvasSketch = canvasSketch;
canvasSketch.PaperSizes = PaperSize;

export default canvasSketch;
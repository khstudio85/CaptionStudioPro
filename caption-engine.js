// ═══════════════════════════════════════════════════════════════════
// CAPTION STUDIO PRO — RENDERING ENGINE v1.0
// Single source of truth for all caption rendering
// USED BY: Preview + Export (guarantee identical output)
// ═══════════════════════════════════════════════════════════════════

(function(global) {
  'use strict';

  // ═══════════════════════════════════════════
  // 0. SHARED TYPOGRAPHY PRIMITIVES
  // Single source of truth for font resolution, used by the layout engine,
  // the canvas renderer AND the DOM preview (via CaptionEngine.FONT_STYLE_MAP).
  // Previously each had its own copy, which is how preview and export drifted.
  // ═══════════════════════════════════════════

  // UI font-style value → { weight, style }.
  // NOTE: 'condensed' used to be missing here while the DOM preview had it, so
  // choosing Condensed rendered at 700 in the editor but 400 in the export.
  const FONT_STYLE_MAP = {
    'regular':    { weight: 400, style: 'normal' },
    'bold':       { weight: 700, style: 'normal' },
    'italic':     { weight: 400, style: 'italic' },
    'bolditalic': { weight: 700, style: 'italic' },
    'light':      { weight: 300, style: 'normal' },
    'medium':     { weight: 500, style: 'normal' },
    'semibold':   { weight: 600, style: 'normal' },
    'black':      { weight: 900, style: 'normal' },
    'thin':       { weight: 100, style: 'normal' },
    'extralight': { weight: 200, style: 'normal' },
    'extrabold':  { weight: 800, style: 'normal' },
    'condensed':  { weight: 700, style: 'normal' }
  };

  // The ONE canvas font shorthand. Keeps the full family list (so the fallback
  // chain matches CSS) and the exact weight/style.
  function fontShorthand(spec, sizePx) {
    return (spec.fontStyle || 'normal') + ' ' + (spec.fontWeight || 400) +
           ' ' + sizePx + 'px ' + spec.fontFamily;
  }

  // Apply the same letter-spacing to a context that drawing uses. Measuring
  // without it made every word narrower than drawn → wrong wrapping/positions.
  function applyLetterSpacing(ctx, spec, scale) {
    if('letterSpacing' in ctx) {
      ctx.letterSpacing = ((spec.letterSpacing || 0) * (scale || 1)) + 'px';
    }
  }

  // ── Optical centre of the letters, shared by the canvas renderer AND the DOM
  // preview so highlight bars sit identically in both. Returns the y offset from
  // the em-box centre to the centre of the cap/ascender→baseline block.
  // (Glyphs centre on the em box, which reserves descender space, so a word with
  // no descenders — "would" — otherwise sits high in its bar.)
  // Returns { centerY, letterH } in the same px units as fontPx:
  //   letterH  = height of the visible letter block (cap top → baseline)
  //   centerY  = y of that block's centre, measured from the drawing origin
  //              (the origin is the em-box centre, where textBaseline='middle' sits)
  // Sizing a bar as letterH + 2*padV and centring it on centerY puts EXACTLY padV
  // above the letter tops and padV below the baseline — equal space top and bottom.
  const _ocCache = Object.create(null);
  function letterMetrics(spec, fontPx) {
    const key = fontPx + '|' + spec.fontFamily + '|' + spec.fontWeight + '|' + spec.fontStyle;
    if(key in _ocCache) return _ocCache[key];
    let out = { centerY: 0, letterH: fontPx * 0.72, baseline: fontPx * 0.30 };
    try {
      const m = (letterMetrics._ctx ||
        (letterMetrics._ctx = document.createElement('canvas').getContext('2d')));
      m.font = fontShorthand(spec, fontPx);
      m.textBaseline = 'alphabetic';
      const cap = m.measureText('H');
      const box = m.measureText('Hg');
      const capH = (cap.actualBoundingBoxAscent > 0) ? cap.actualBoundingBoxAscent : fontPx * 0.72;
      const A = (box.fontBoundingBoxAscent  != null) ? box.fontBoundingBoxAscent  : fontPx * 0.80;
      const D = (box.fontBoundingBoxDescent != null) ? box.fontBoundingBoxDescent : fontPx * 0.20;
      const baseline = (A - D) / 2;          // where textBaseline='middle' puts it
      out = { centerY: baseline - capH / 2, letterH: capH, baseline: baseline };
    } catch(_) {}
    _ocCache[key] = out;
    return out;
  }
  // Back-compat: just the centre offset
  function opticalCenterOffset(spec, fontPx) { return letterMetrics(spec, fontPx).centerY; }

  // CSS cubic-bezier(x1,y1,x2,y2) evaluator, so canvas animations use the SAME
  // timing curve the preview's CSS keyframes use (Newton-Raphson on x, then y).
  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sampleX = t => ((ax * t + bx) * t + cx) * t;
    const sampleY = t => ((ay * t + by) * t + cy) * t;
    const slopeX  = t => (3 * ax * t + 2 * bx) * t + cx;
    return function(x) {
      if(x <= 0) return 0;
      if(x >= 1) return 1;
      let t = x;
      for(let i = 0; i < 8; i++) {
        const err = sampleX(t) - x;
        if(Math.abs(err) < 1e-6) break;
        const d = slopeX(t);
        if(Math.abs(d) < 1e-6) break;
        t -= err / d;
      }
      return sampleY(t);
    };
  }
  
  // ═══════════════════════════════════════════
  // 1. CAPTION STYLE SPECIFICATION
  // Every property that affects rendering
  // ═══════════════════════════════════════════
  
  class CaptionStyleSpec {
    constructor(options = {}) {
      // === TYPOGRAPHY ===
      this.fontFamily      = options.fontFamily      || "'Montserrat', sans-serif";
      this.fontSize        = options.fontSize        || 60;    // canvas-space pixels
      this.fontWeight      = options.fontWeight      || 700;
      this.fontStyle       = options.fontStyle       || 'normal';
      this.fontVariant     = options.fontVariant     || 'normal';
      this.letterSpacing   = options.letterSpacing   || 0;
      this.lineHeight      = options.lineHeight      || 1.2;
      this.wordSpacing     = options.wordSpacing     || 0;
      this.textTransform   = options.textTransform   || 'none'; // none|upper|lower|cap
      this.textAlign       = options.textAlign       || 'center';
      
      // === COLOR ===
      this.color           = options.color           || '#FFFFFF';
      this.opacity         = options.opacity !== undefined ? options.opacity : 1;
      
      // === GRADIENT ===
      this.gradientEnabled = options.gradientEnabled || false;
      this.gradientColor1  = options.gradientColor1  || '#FF512F';
      this.gradientColor2  = options.gradientColor2  || '#F09819';
      this.gradientAngle   = options.gradientAngle   || 135;
      
      // === STROKE ===
      this.strokeEnabled   = options.strokeEnabled   || false;
      this.strokeColor     = options.strokeColor     || '#000000';
      this.strokeWidth     = options.strokeWidth     || 0;
      
      // === SHADOW ===
      this.shadows         = options.shadows         || []; // array of shadow objects
      
      // === GLOW ===
      this.glowEnabled     = options.glowEnabled     || false;
      this.glowColor       = options.glowColor       || '#FFFFFF';
      this.glowIntensity   = options.glowIntensity   || 12;
      this.glowSpread      = options.glowSpread      || 20;
      
      // === HIGHLIGHT (Active word) ===
      this.highlightEnabled     = options.highlightEnabled     !== false;
      this.highlightBgColor     = options.highlightBgColor     || '#FFE500';
      this.highlightTextColor   = options.highlightTextColor   || '#000000';
      this.highlightPadH        = options.highlightPadH        || 8;
      this.highlightPadV        = options.highlightPadV        || 4;
      this.highlightRadius      = options.highlightRadius      || 5;
      this.highlightScale       = options.highlightScale       || 1.12;
      
      // === CAPTION BACKGROUND ===
      this.bgEnabled       = options.bgEnabled       || false;
      this.bgColor         = options.bgColor         || '#000000';
      this.bgOpacity       = options.bgOpacity       || 0;
      this.bgPadH          = options.bgPadH          || 14;
      this.bgPadV          = options.bgPadV          || 10;
      this.bgRadius        = options.bgRadius        || 8;
      
      // === POSITION (normalized 0-100 %) ===
      this.positionX       = options.positionX       || 50;  // % from left
      this.positionY       = options.positionY       || 70;  // % from top
      this.maxWidth        = options.maxWidth        || 85;  // % of canvas width
      this.maxWordsPerLine = options.maxWordsPerLine || 6;   // keep short captions on one line
      
      // === ANIMATION ===
      this.animationStyle  = options.animationStyle  || 0;   // 0-8 (which style)
      this.animationDuration = options.animationDuration || 400;
      this.animationEasing = options.animationEasing || 'cubic-bezier(0.34,1.56,0.64,1)';
      
      // === STYLE-SPECIFIC PROPERTIES ===
      this.styleProps      = options.styleProps      || {};
      
      // === LINE BREAK ===
      this.lineBreakEnabled = options.lineBreakEnabled || false;
      this.lineBreakAt      = options.lineBreakAt      || 1;
      
      // === WORDS PER GROUP ===
      this.wordsPerGroup   = options.wordsPerGroup   || 3;
      
      // === CANVAS REFERENCE (for scale calculations) ===
      this.canvasWidth     = options.canvasWidth     || 1920;
      this.canvasHeight    = options.canvasHeight    || 1080;
    }
    
    // Serialize to plain object (for transport/storage)
    toJSON() {
      return { ...this };
    }
    
    // Clone with overrides
    clone(overrides = {}) {
      return new CaptionStyleSpec({ ...this.toJSON(), ...overrides });
    }
    
    // THE typography scale — authored reference-space px → target-canvas px.
    // Every getScaled* below and every effect scale in CaptionRenderer goes
    // through here, so a caption cannot be responsive in one metric and fixed in
    // another. `targetWidth` is optional only for older 1-arg call sites; when
    // omitted it is derived from this spec's own canvas aspect so min() still
    // means the same thing.
    typeScale(targetWidth, targetHeight) {
      const h = +targetHeight > 0 ? +targetHeight : this.canvasHeight;
      const w = +targetWidth > 0
        ? +targetWidth
        : h * ((this.canvasWidth || CANVAS_REF_W) / (this.canvasHeight || CANVAS_REF_H));
      return canvasTypeScale(w, h);
    }

    // Get scaled font size for a target canvas
    getScaledFontSize(targetHeight, targetWidth) {
      return Math.max(4, Math.round(this.fontSize * this.typeScale(targetWidth, targetHeight)));
    }

    // Get scaled stroke width for a target canvas
    getScaledStrokeWidth(targetHeight, targetWidth) {
      return this.strokeWidth * this.typeScale(targetWidth, targetHeight);
    }

    // Get scaled letter spacing
    getScaledLetterSpacing(targetHeight, targetWidth) {
      return this.letterSpacing * this.typeScale(targetWidth, targetHeight);
    }
    
    // Get position in pixels for target canvas
    getPixelPosition(targetWidth, targetHeight) {
      return {
        x: (this.positionX / 100) * targetWidth,
        y: (this.positionY / 100) * targetHeight
      };
    }
  }
  
  // ═══════════════════════════════════════════
  // RESPONSIVE CANVAS TYPOGRAPHY SCALE
  // ═══════════════════════════════════════════
  // Every typography metric — font size, letter/word spacing, line spacing,
  // stroke, shadow distance & blur, glow, highlight & bar padding — is authored
  // against ONE reference frame and scaled to whatever canvas is active.
  //
  // Before this, `fontSize` was a literal canvas-space pixel value. Swapping a
  // 9:16 canvas (1080x1920) for a 16:9 one (1920x1080) kept the same px while the
  // frame got 1.78x NARROWER, so the caption grew to 1.78x its relative width and
  // ran off the left/right edges. Auto-fit only rescued the overflow *after* it
  // happened, which is why some styles looked fine and others clipped.
  //
  // min() — a "fit" scale — is deliberate. It makes the font a constant fraction
  // of frame HEIGHT at every aspect ratio (the perceptual measure for type), and
  // because no supported preset is narrower than the reference, the caption's
  // horizontal footprint can only ever SHRINK as the frame widens. Clipping
  // becomes structurally impossible instead of something auto-fit must catch.
  //
  //   9:16 1080x1920 -> 1.0000      16:9 1920x1080 -> 0.5625
  //   1:1  1080x1080 -> 0.5625      4:5  1080x1350 -> 0.7031
  //
  // Exported as CaptionEngine.canvasTypeScale so the DOM preview scales by the
  // exact same number — one formula, no second implementation to drift.
  const CANVAS_REF_W = 1080;
  const CANVAS_REF_H = 1920;
  // Safety margin (percentage points) held back from the position-derived half of
  // the max-width box. Shared with the DOM preview via CaptionEngine.
  const EDGE_INSET_PCT = 1;
  function canvasTypeScale(canvasW, canvasH) {
    const w = +canvasW > 0 ? +canvasW : CANVAS_REF_W;
    const h = +canvasH > 0 ? +canvasH : CANVAS_REF_H;
    return Math.min(w / CANVAS_REF_W, h / CANVAS_REF_H);
  }

  // ═══════════════════════════════════════════
  // STYLE REGISTRY  —  data-driven, not hardcoded per style
  // ═══════════════════════════════════════════
  // An animation style is DECLARED here with everything the pipeline needs to
  // render, export and validate it. The exporter never switches on a style id:
  // it reads this registry, so a style added or edited here is automatically
  // export-compatible with no export-side code.
  //
  //   registerStyle(id, {
  //     name,        human label, used in validation messages
  //     calculate,   (spec, group, t) -> animation state  [REQUIRED]
  //     produces,    the per-word/container channels this style drives. Declared
  //                  so validateProject() can check the renderer supports them
  //                  instead of silently dropping an unsupported one.
  //     requires,    styleProps keys the style reads. Missing ones are reported
  //                  with the style name rather than becoming NaN mid-render.
  //     defaults,    fallback styleProps, applied when the project omits them —
  //                  this is what keeps OLD projects rendering after a style
  //                  gains a new property.
  //     domOwnsAnimation  true when the DOM preview drives transform/opacity from
  //                  its own CSS keyframes, so the shared frame must not claim
  //                  those two channels for this style.
  //   })
  //
  // PRODUCES vocabulary — every channel the two backends know how to apply. A
  // style declaring anything outside this set fails validation loudly, which is
  // the guard against "new style silently exports wrong".
  const RENDER_CHANNELS = [
    'opacity', 'scale', 'x', 'y', 'rotation', 'color', 'bgColor',
    'highlighted', 'visible', 'anchorBottom', 'glow', 'wordBar',
    'containerOpacity', 'containerBg'
  ];

  const STYLE_REGISTRY = {};

  function registerStyle(id, def) {
    if(def == null || typeof def.calculate !== 'function') {
      throw new Error('registerStyle(' + id + '): a calculate(spec, group, t) function is required');
    }
    const produces = def.produces || [];
    const unknown = produces.filter(c => RENDER_CHANNELS.indexOf(c) < 0);
    if(unknown.length) {
      throw new Error('registerStyle(' + id + ' "' + (def.name || '') + '"): declares channel(s) no ' +
                      'renderer supports: ' + unknown.join(', ') +
                      '. Add them to RENDER_CHANNELS and teach BOTH backends, or remove them.');
    }
    STYLE_REGISTRY[id] = {
      id: id,
      name: def.name || ('style ' + id),
      calculate: def.calculate,
      produces: produces,
      requires: def.requires || [],
      defaults: def.defaults || {},
      domOwnsAnimation: !!def.domOwnsAnimation
    };
    return STYLE_REGISTRY[id];
  }

  function getStyleDef(id) { return STYLE_REGISTRY[id] || null; }
  function listStyles() {
    return Object.keys(STYLE_REGISTRY)
      .map(k => STYLE_REGISTRY[k])
      .sort((a, b) => a.id - b.id);
  }

  // Fill in a style's declared defaults for any styleProps key the project omits,
  // so a project saved before a style gained a property still renders.
  function resolveStyleProps(spec, styleId) {
    const def = getStyleDef(styleId);
    const given = ((spec && spec.styleProps) || {})[styleId] || {};
    if(!def) return given;
    const out = {};
    Object.keys(def.defaults).forEach(k => { out[k] = def.defaults[k]; });
    Object.keys(given).forEach(k => { if(given[k] !== undefined) out[k] = given[k]; });
    return out;
  }

  // ═══════════════════════════════════════════
  // SHARED EFFECT LAYER MODEL  (single source of truth)
  // ═══════════════════════════════════════════
  // Drop shadow and glow are expanded into layer DESCRIPTORS here, exactly once:
  //
  //     { dx, dy, blur, color }        px in the caller's space, colour is rgba()
  //
  // ORDER CONVENTION: descriptor lists are FRONT TO BACK — index 0 is the layer
  // nearest the glyph. That is CSS text-shadow's own convention (an earlier entry
  // paints on top of later ones), and it is the order the original design intended:
  // the tight dark CONTACT shadow sits in front of the wide faint halo, not behind
  // it. So layersToCSS() emits the list as-is, and the canvas backend — where a
  // later draw wins — walks it in REVERSE. Getting this backwards is what made the
  // exported shadow stack read inverted against the preview: the canvas painted
  // contact first, letting the 0.18-alpha far halo wash over it.
  //
  // The canvas backend casts each descriptor with _castShadow(); the DOM preview
  // formats the SAME descriptors into a CSS text-shadow list via layersToCSS().
  // Neither side owns the maths.
  //
  // This replaces two hand-mirrored implementations — buildShadowCSS() in
  // index.html and _castShadowStack() here — which had to be kept in step by
  // hand. They already disagreed: the canvas side treated `opacity` as a 0-1
  // alpha when the UI slider emits 0-100, so every exported shadow was fully
  // opaque, and it painted ONE flat layer against the DOM's seven.
  //
  // `scale` is whatever space the caller wants the numbers in: the exporter
  // passes spec.typeScale(W,H) for target pixels, the preview passes its
  // _fontScale for on-screen pixels. Same descriptors, different space.
  function _rgbaStr(hex, alpha) {
    if(typeof hex !== 'string') return hex;
    let c = hex.replace('#', '');
    if(c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    const r = parseInt(c.substring(0,2),16) || 0;
    const g = parseInt(c.substring(2,4),16) || 0;
    const b = parseInt(c.substring(4,6),16) || 0;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha == null ? 1 : alpha) + ')';
  }

  // Normalise the opacity slider. It is authored 0-100; a value <= 1 is taken as
  // an already-normalised alpha so older projects do not render invisible.
  function _normOpacity(v) {
    const raw = (v == null) ? 100 : +v;
    return raw > 1 ? raw / 100 : raw;
  }

  // ONE drop-shadow entry -> its 7-layer stack, back to front.
  // contact / key / mid / soft penumbra / far halo / ambient spread x2 / rim.
  function shadowLayers(sh, scale) {
    if(!sh) return [];
    // Opacity 0 means OFF. Without this the contact layer's `op + 0.15` boost
    // kept painting a 0.15-alpha shadow at opacity 0, so the slider could never
    // actually turn the shadow off. (Inherited from the original buildShadowCSS,
    // so the preview did it too — consistent, but still wrong.)
    if(_normOpacity(sh.opacity) <= 0) return [];
    const k    = (scale == null ? 1 : scale);
    const rad  = ((sh.angle || 0) * Math.PI) / 180;
    const x    = Math.cos(rad) * (sh.dist || 0) * k;
    const y    = Math.sin(rad) * (sh.dist || 0) * k;
    const blur = (sh.size || 0) * k;
    const sp   = (sh.spread || 0) * k;
    const op   = _normOpacity(sh.opacity);
    const col  = sh.color || '#000000';
    const out  = [];
    const push = (dx, dy, b, a) => {
      if(a <= 0.004) return;
      out.push({ dx: dx, dy: dy, blur: Math.max(0, b), color: _rgbaStr(col, +a.toFixed(4)) });
    };
    push(x * 0.15, y * 0.15, Math.max(1, Math.round(blur * 0.15)), Math.min(0.95, op + 0.15)); // contact
    push(x * 0.5,  y * 0.5,  Math.max(2, Math.round(blur * 0.5)),  op * 0.85);                 // key
    push(x,        y,        blur,                                 op);                        // mid
    push(x * 1.3,  y * 1.3,  Math.round(blur * 2.0 + 6),           op * 0.4);                  // penumbra
    push(x * 1.6,  y * 1.6,  Math.round(blur * 3.5 + 12),          op * 0.18);                 // far halo
    if(sp > 0) {
      push(0, 0, Math.round(blur * 0.8 + sp * 2), op * 0.5);
      push(0, 0, Math.round(blur * 1.8 + sp * 4), op * 0.25);
    }
    if(blur > 4) push(-x * 0.08, -y * 0.08, Math.max(1, Math.round(blur * 0.3)), op * 0.15);    // rim
    return out;
  }

  // Glow -> its 3-layer stack: intensity core, spread, wide halo.
  // 0x88 = 0.533 and 0x44 = 0.267 are the alphas the CSS preset uses.
  // A per-word animation glow carries no spread and is a single layer.
  function glowLayers(glow, scale) {
    if(!glow) return [];
    const k  = (scale == null ? 1 : scale);
    const gi = (glow.size || 0) * k;
    const gs = (glow.spread != null ? glow.spread : 0) * k;
    const col = glow.color || '#ffffff';
    const out = [];
    if(gi > 0) out.push({ dx: 0, dy: 0, blur: gi, color: col });
    if(gs > 0) {
      out.push({ dx: 0, dy: 0, blur: gs,       color: _rgbaStr(col, 0.533) });
      out.push({ dx: 0, dy: 0, blur: gs * 1.8, color: _rgbaStr(col, 0.267) });
    }
    return out;
  }

  // All effect layers for a word, in the order they must PAINT (back to front):
  // drop shadow furthest back, then glow, then the caller draws sharp text.
  // `wordState` is the per-word animation state, so an animation-supplied glow
  // (styles 5/7) wins over the UI glow panel exactly as the renderer does.
  function effectLayers(spec, wordState, scale) {
    const ws = wordState || {};
    const shadows = Array.isArray(spec.shadows) ? spec.shadows : [];
    const sh = [];
    shadows.forEach(e => { shadowLayers(e, scale).forEach(l => sh.push(l)); });
    const glow = ws.glow || (spec.glowEnabled
      ? { color: spec.glowColor, size: spec.glowIntensity, spread: spec.glowSpread }
      : null);
    return { shadow: sh, glow: glowLayers(glow, scale) };
  }

  // Format descriptors as a CSS text-shadow / box-shadow value list.
  function layersToCSS(layers) {
    if(!layers || !layers.length) return '';
    // As-is: descriptors are already in CSS's front-to-back order.
    return layers.map(l =>
      (+l.dx).toFixed(1) + 'px ' + (+l.dy).toFixed(1) + 'px ' +
      Math.round(l.blur) + 'px ' + l.color
    ).join(', ');
  }

  // ═══════════════════════════════════════════
  // 2. ANIMATION ENGINE
  // Frame-accurate animation calculations
  // ═══════════════════════════════════════════
  
  class AnimationEngine {
    constructor() {
      // The registry is populated at module load (see the registerBuiltinStyles()
      // call at the bottom of this file) so listStyles() / validateProject() work
      // before any renderer exists. Kept here too for safety if an AnimationEngine
      // is somehow constructed first.
      this._registerBuiltins();
      this.styles = {};
      listStyles().forEach(d => { this.styles[d.id] = d.calculate; });
    }

    // Declare the built-ins. Each entry states what it DRIVES (produces) and what
    // styleProps it READS (requires/defaults), which is what lets the exporter
    // handle it without knowing anything style-specific.
    _registerBuiltins() {
      if(STYLE_REGISTRY[0]) return;   // already declared by another instance
      const B = (fn) => fn.bind(this);
      registerStyle(0, {
        name: 'None',
        calculate: B(this.styleNone),
        produces: ['opacity', 'color', 'highlighted', 'bgColor']
      });
      registerStyle(1, {
        name: 'Background Bar',
        calculate: B(this.styleBackgroundBar),
        produces: ['opacity', 'color', 'bgColor', 'highlighted', 'containerOpacity', 'containerBg'],
        requires: ['bgOpacity', 'barRadius', 'inDuration', 'outDuration'],
        defaults: { bgOpacity: 0.85, barRadius: 6, inDuration: 200, outDuration: 200 }
      });
      registerStyle(2, {
        name: 'Pop In Bounce',
        calculate: B(this.stylePopBounce),
        produces: ['opacity', 'scale', 'color', 'bgColor', 'highlighted', 'visible', 'anchorBottom'],
        requires: ['startScale', 'bounceScale', 'inDuration', 'outDuration'],
        defaults: { startScale: 0, bounceScale: 115, inDuration: 180, outDuration: 120,
                    originX: 50, originY: 100 }
      });
      registerStyle(3, {
        name: 'Opacity Cascade',
        calculate: B(this.styleOpacityCascade),
        produces: ['opacity', 'scale', 'color', 'highlighted', 'anchorBottom'],
        requires: ['dimOpacity', 'spokenOpacity', 'activeOpacity', 'activeScale'],
        defaults: { dimOpacity: 18, spokenOpacity: 45, activeOpacity: 100, activeScale: 106,
                    activeColor: '#04FD00', transitionMs: 120, randomColors: false,
                    activeSizeOn: false, activeSizeMul: 1.6, wordGapExtra: 0 }
      });
      registerStyle(4, {
        name: 'Slide Stack',
        calculate: B(this.styleSlideStack),
        produces: ['opacity', 'scale', 'x', 'y', 'color', 'visible'],
        requires: ['slideFrom', 'inDuration', 'fadeOpacity', 'maxWords'],
        defaults: { slideFrom: 'bottom', inDuration: 200, fadeOpacity: 20, maxWords: 4 },
        // The DOM preview animates this one with injected CSS keyframes.
        domOwnsAnimation: true
      });
      registerStyle(5, {
        name: 'Karaoke Line',
        calculate: B(this.styleKaraokeLine),
        produces: ['opacity', 'color', 'highlighted', 'glow'],
        requires: ['dimOpacity', 'spokenOpacity'],
        defaults: { dimOpacity: 20, spokenOpacity: 75, activeColor: '', glowColor: '', glowSize: 8 }
      });
      registerStyle(6, {
        name: 'Apple Reveal',
        calculate: B(this.styleAppleReveal),
        produces: ['opacity', 'scale', 'y', 'color', 'containerOpacity'],
        requires: ['line1Dur', 'line2Dur', 'line2Delay'],
        defaults: { line1Dur: 200, line2Dur: 600, line2Delay: 210, scaleStart: 99,
                    direction: 'up', line1Color: '#db6a00', line2Color: '#FFFFFF',
                    line1SizeMul: 0.4, line2SizeMul: 0.9, line1Weight: 300, line2Weight: 900,
                    trackingLine1: 0.07, trackingLine2: 0, lineGap: -13, glowAmt: 14, splitAt: 5 },
        domOwnsAnimation: true
      });
      registerStyle(7, {
        name: 'Border Pop Up',
        calculate: B(this.styleBorderPopUp),
        produces: ['opacity', 'scale', 'color', 'highlighted', 'wordBar', 'anchorBottom'],
        requires: ['bgOpacity', 'barRadius', 'padH', 'padV', 'bounceScale'],
        defaults: { bgOpacity: 100, barRadius: 7, padH: 8, padV: 5, startDelay: 50,
                    bounceScale: 104, bouncePeakAt: 70,
                    bez1x: 0.25, bez1y: 1.0, bez2x: 0.5, bez2y: 1.0 }
      });
      registerStyle(8, {
        name: 'Pro Typographic',
        calculate: B(this.styleProTypographic),
        produces: ['opacity', 'scale', 'color', 'visible'],
        requires: ['wordDelay', 'animDuration'],
        defaults: { wordDelay: 260, animDuration: 900, sizeVariation: 'low',
                    randomFonts: false, randomColors: false,
                    accentColor1: '#e74c3c', accentColor2: '#3498db',
                    baseColor: '#ffffff', animType: 'smoothNormal', lineBreakStyle: 'auto' }
      });
    }
    
    // Calculate animation state for a specific time
    // Returns: { words: [{ opacity, scale, x, y, color, bgColor, highlighted }] }
    calculate(spec, group, currentTime) {
      // Dispatch through the REGISTRY, not a hardcoded map. An unregistered style
      // is a hard error rather than a silent fall back to "None" — falling back is
      // exactly how an unsupported style used to export as plain static text while
      // the preview animated it.
      const def = getStyleDef(spec.animationStyle);
      if(!def) {
        throw new Error('Animation style ' + spec.animationStyle + ' is not registered. ' +
                        'Declare it with CaptionEngine.registerStyle() so both the preview ' +
                        'and the exporter can render it.');
      }
      return def.calculate(spec, group, currentTime);
    }
    
    // Find active word index at time t
    getActiveWordIndex(group, currentTime) {
      if(!group.wordTimes) return -1;
      for(let i = 0; i < group.wordTimes.length; i++) {
        const wt = group.wordTimes[i];
        if(currentTime >= wt.start && currentTime < wt.end) return i;
      }
      // Past last word but within group end → return last word
      const lastWt = group.wordTimes[group.wordTimes.length - 1];
      if(lastWt && currentTime >= lastWt.end && currentTime < group.end) {
        return group.wordTimes.length - 1;
      }
      return -1;
    }
    
    // === STYLE 0: None — Plain text ===
    styleNone(spec, group, currentTime) {
      return {
        words: group.words.map(() => ({
          opacity: 1,
          scale: 1,
          x: 0, y: 0,
          color: spec.color,
          bgColor: null,
          highlighted: false
        })),
        containerOpacity: 1
      };
    }
    
    // === STYLE 1: Background Bar ===
    styleBackgroundBar(spec, group, currentTime) {
      const activeIdx = this.getActiveWordIndex(group, currentTime);
      return {
        words: group.words.map((_, i) => {
          const isActive = i === activeIdx && spec.highlightEnabled;
          return {
            opacity: 1,
            scale: isActive ? spec.highlightScale : 1,
            x: 0, y: 0,
            color: isActive ? spec.highlightTextColor : spec.color,
            bgColor: isActive ? spec.highlightBgColor : null,
            highlighted: isActive
          };
        }),
        containerOpacity: 1,
        containerBg: spec.bgEnabled && spec.bgOpacity > 0 ? {
          color: spec.bgColor,
          opacity: spec.bgOpacity / 100,
          padH: spec.bgPadH,
          padV: spec.bgPadV,
          radius: spec.bgRadius
        } : null
      };
    }
    
    // === STYLE 2: Pop In Bounce ===
    stylePopBounce(spec, group, currentTime) {
      const activeIdx = Math.max(0, this.getActiveWordIndex(group, currentTime));
      const props = spec.styleProps[2] || {};
      const startScale = (props.startScale || 0) / 100;
      const bounceScale = (props.bounceScale || 115) / 100;
      const inDuration = (props.inDuration || 180) / 1000;
      const outDuration = (props.outDuration || 120) / 1000;
      
      const wt = group.wordTimes[activeIdx];
      if(!wt) return this.styleNone(spec, group, currentTime);
      
      const wordDur = wt.end - wt.start;
      const localTime = currentTime - wt.start;
      const inPhase = Math.min(inDuration, wordDur * 0.2);
      const outPhase = Math.min(outDuration, wordDur * 0.15);
      const holdEnd = wordDur - outPhase;
      
      let scale = 1, opacity = 1;
      
      if(localTime < inPhase * 0.55) {
        // Rising to bounce
        const t = localTime / (inPhase * 0.55);
        scale = startScale + (bounceScale - startScale) * this.easeOutBack(t);
        opacity = Math.min(1, t * 1.5);
      } else if(localTime < inPhase) {
        // Settling from bounce to 1
        const t = (localTime - inPhase * 0.55) / (inPhase * 0.45);
        scale = bounceScale - (bounceScale - 1) * t;
        opacity = 1;
      } else if(localTime < holdEnd) {
        scale = 1; opacity = 1;
      } else {
        // Exit
        const t = (localTime - holdEnd) / outPhase;
        scale = 1 - (1 - 0.85) * t;
        opacity = 1 - t;
      }
      
      // Only render active word (Style 2 shows one word at a time)
      const words = group.words.map((_, i) => ({
        opacity: i === activeIdx ? opacity : 0,
        scale: i === activeIdx ? scale : 1,
        x: 0, y: 0,
        color: spec.color,
        bgColor: spec.highlightEnabled && spec.bgOpacity > 0 ? spec.highlightBgColor : null,
        highlighted: i === activeIdx,
        visible: i === activeIdx
      }));
      
      return {
        words,
        containerOpacity: 1,
        transformOrigin: (props.originX || 50) + '% ' + (props.originY || 100) + '%'
      };
    }
    
    // === STYLE 3: Opacity Cascade ===
    styleOpacityCascade(spec, group, currentTime) {
      const activeIdx = this.getActiveWordIndex(group, currentTime);
      const props = spec.styleProps[3] || {};
      const dimOp = (props.dimOpacity || 18) / 100;
      const spokenOp = (props.spokenOpacity || 45) / 100;
      const activeOp = (props.activeOpacity || 100) / 100;
      const activeScale = (props.activeScale || 106) / 100;
      const activeColor = props.activeColor || spec.color;
      // Optional active-word size boost, folded into `scale`.
      // IMPORTANT: this is a pure TRANSFORM, not a layout change. Laying the word
      // out at the bigger size reserved extra width and pushed every other word
      // sideways (and could force an extra line). A transform grows the word in
      // place, so all inactive words keep their exact positions.
      const sizeOn  = !!props.activeSizeOn;
      const sizeMul = sizeOn ? (+props.activeSizeMul || 1) : 1;

      return {
        words: group.words.map((_, i) => {
          const isActive = i === activeIdx;
          const isSpoken = i < activeIdx;
          return {
            opacity: isActive ? activeOp : (isSpoken ? spokenOp : dimOp),
            scale: isActive ? activeScale * sizeMul : 1,
            anchorBottom: true,          // grow UPWARD from the baseline
            x: 0, y: 0,
            color: isActive ? activeColor : spec.color,
            bgColor: null,
            highlighted: isActive
          };
        }),
        containerOpacity: 1
      };
    }
    
    // === STYLE 4: Slide Stack (simplified for now) ===
    styleSlideStack(spec, group, currentTime) {
      const activeIdx = Math.max(0, this.getActiveWordIndex(group, currentTime));
      const props = spec.styleProps[4] || {};
      const maxVis = props.maxWords || 4;
      const fadeOp = (props.fadeOpacity || 20) / 100;
      
      return {
        words: group.words.map((_, i) => {
          if(i > activeIdx) return { opacity: 0, scale: 1, x: 0, y: 0, color: spec.color, visible: false };
          const age = activeIdx - i;
          const opacity = age === 0 ? 1 : Math.max(fadeOp, 1 - (age / maxVis) * (1 - fadeOp));
          return {
            opacity,
            scale: 1, x: 0, y: 0,
            color: spec.color,
            bgColor: null,
            highlighted: i === activeIdx,
            visible: age < maxVis
          };
        }),
        containerOpacity: 1
      };
    }
    
    // === STYLE 5: Karaoke Line ===
    styleKaraokeLine(spec, group, currentTime) {
      const activeIdx = this.getActiveWordIndex(group, currentTime);
      const props = spec.styleProps[5] || {};
      const dimOp = (props.dimOpacity || 20) / 100;
      const spokenOp = (props.spokenOpacity || 75) / 100;
      const activeColor = props.activeColor || spec.highlightBgColor;
      const glowSize = props.glowSize || 8;
      const glowColor = props.glowColor || activeColor;
      
      return {
        words: group.words.map((_, i) => {
          const isActive = i === activeIdx;
          const isSpoken = i < activeIdx;
          return {
            opacity: isActive ? 1 : (isSpoken ? spokenOp : dimOp),
            scale: isActive ? 1.08 : 1,
            x: 0, y: 0,
            color: isActive ? activeColor : spec.color,
            bgColor: null,
            highlighted: isActive,
            glow: isActive && glowSize > 0 ? { color: glowColor, size: glowSize } : null
          };
        }),
        containerOpacity: 1
      };
    }
    
    // === STYLE 6: Apple Reveal (simplified) ===
    styleAppleReveal(spec, group, currentTime) {
      // For now, treat as fade in
      const groupProgress = Math.min(1, (currentTime - group.start) / 0.6);
      const opacity = this.easeOut(groupProgress);
      const scale = 0.95 + 0.05 * this.easeOut(groupProgress);
      
      return {
        words: group.words.map(() => ({
          opacity: 1,
          scale: 1,
          x: 0, y: 0,
          color: spec.color,
          bgColor: null,
          highlighted: false
        })),
        containerOpacity: opacity,
        containerScale: scale
      };
    }
    
    // === STYLE 7: Border Pop Up ===
    styleBorderPopUp(spec, group, currentTime) {
      const activeIdx = this.getActiveWordIndex(group, currentTime);
      const props = spec.styleProps[7] || {};
      // Defaults match the inline preview's subtle Border Pop Up (bar 100%,
      // gentle 104% bounce) so export and preview agree.
      const bounceScale = (props.bounceScale || 104) / 100;
      const padH = props.padH || 8;
      const padV = props.padV || 5;
      const radius = props.barRadius || 7;
      const bgOp = (props.bgOpacity != null ? props.bgOpacity : 100) / 100;

      // ── Match the DOM preview EXACTLY (renderStyle7 in index.html) ──
      // There, two separate things happen to an active word:
      //   1. the CHIP (word + bar) gets a STATIC transform: scale(hlScale/100)
      //      — the "Active Words Highlights → Scale" value. It is NOT animated.
      //   2. the BAR (a child span) runs the bounce keyframes:
      //        0% → 1.0 · delayPct% → 1.0 · peakPct% → bounceScale · 100% → 1.0
      //      over the word's duration, eased with the style's cubic-bezier.
      // The export used to bounce the WORD itself (and never the bar), which is
      // why exported words scaled up while the preview only popped the bar.
      const hlScale = spec.highlightScale || 1;   // static word scale
      const b1x = props.bez1x != null ? props.bez1x : 0.25;
      const b1y = props.bez1y != null ? props.bez1y : 1.0;
      const b2x = props.bez2x != null ? props.bez2x : 0.5;
      const b2y = props.bez2y != null ? props.bez2y : 1.0;
      const ease = cubicBezier(b1x, b1y, b2x, b2y);

      return {
        words: group.words.map((_, i) => {
          const isActive = i === activeIdx && spec.highlightEnabled;
          if(!isActive) {
            return {
              opacity: 1, scale: 1, x: 0, y: 0,
              color: spec.color, bgColor: null, highlighted: false, wordBar: null
            };
          }

          // Bar bounce, evaluated from the frame timestamp (deterministic)
          const wt = group.wordTimes[i] || { start: currentTime, end: currentTime + 0.4 };
          const wordDurMs  = Math.max(120, Math.round((wt.end - wt.start) * 1000));
          const startDelay = Math.min(props.startDelay != null ? props.startDelay : 50, wordDurMs * 0.35);
          const delayPct   = +(startDelay / wordDurMs * 100).toFixed(1);
          const peakPct    = Math.max(delayPct + 8,
                              Math.min(props.bouncePeakAt != null ? props.bouncePeakAt : 70, 78));
          // CSS animations run once with `forwards`, so clamp past 100%
          const pct = Math.max(0, Math.min(100, ((currentTime - wt.start) * 1000 / wordDurMs) * 100));

          let barScale;
          if(pct <= delayPct) {
            barScale = 1;                                        // pre-delay hold
          } else if(pct <= peakPct) {
            const seg = (peakPct - delayPct) > 0 ? (pct - delayPct) / (peakPct - delayPct) : 1;
            barScale = 1 + (bounceScale - 1) * ease(seg);         // rise to the bounce
          } else {
            const seg = (100 - peakPct) > 0 ? (pct - peakPct) / (100 - peakPct) : 1;
            barScale = bounceScale + (1 - bounceScale) * ease(seg); // settle back to 1
          }

          return {
            opacity: 1,
            scale: hlScale,          // STATIC — same as the DOM chip transform
            x: 0, y: 0,
            color: spec.highlightTextColor,
            bgColor: null,
            highlighted: true,
            wordBar: {
              color: this.hexAlpha(spec.highlightBgColor, bgOp),
              radius, padH, padV,
              scale: barScale        // ONLY the bar animates
            }
          };
        }),
        containerOpacity: 1
      };
    }
    
    // === STYLE 8: Pro Typographic (simplified) ===
    styleProTypographic(spec, group, currentTime) {
      const activeIdx = this.getActiveWordIndex(group, currentTime);
      return {
        words: group.words.map((_, i) => {
          const isVisible = currentTime >= (group.wordTimes[i]?.start || 0);
          return {
            opacity: isVisible ? 1 : 0,
            scale: 1,
            x: 0, y: 0,
            color: spec.color,
            bgColor: null,
            highlighted: i === activeIdx
          };
        }),
        containerOpacity: 1
      };
    }
    
    // === EASING FUNCTIONS ===
    easeOut(t) { return 1 - Math.pow(1 - t, 3); }
    easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
    easeOutBack(t) {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    
    // Helper: hex color + alpha → rgba
    hexAlpha(hex, alpha) {
      const clean = hex.replace('#', '');
      const r = parseInt(clean.substring(0, 2), 16);
      const g = parseInt(clean.substring(2, 4), 16);
      const b = parseInt(clean.substring(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
  }
  
  // ═══════════════════════════════════════════
  // 3. TEXT LAYOUT ENGINE
  // Consistent text measurement for preview & export
  // ═══════════════════════════════════════════
  
  class TextLayoutEngine {
    constructor() {
      // Create offscreen canvas for measurement
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
    }
    
    // Apply text transform (case)
    applyCase(text, transform) {
      // Skip RTL scripts
      const RTL = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u0870-\u089F\uFB50-\uFDFF\uFE70-\uFEFF]/;
      if(RTL.test(text)) return text;
      
      switch(transform) {
        case 'upper': return text.toUpperCase();
        case 'lower': return text.toLowerCase();
        case 'cap':   return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
        default:      return text;
      }
    }
    
    // Measure single word width
    measureWord(word, spec, targetHeight, sizeMul, targetWidth) {
      // sizeMul lets one word (e.g. the Opacity Cascade active word) be measured
      // at a larger size so the line reserves the right width for it.
      const fontSize = spec.getScaledFontSize(targetHeight, targetWidth) * (sizeMul || 1);
      // Measure with EXACTLY what we draw with:
      //  • the full family list (was: first family only → different fallback,
      //    so metrics diverged from the drawn glyphs)
      //  • the same letter-spacing (was: omitted → every word measured narrower
      //    than it renders, shifting positions and changing line wrapping)
      this.ctx.font = fontShorthand(spec, fontSize);
      applyLetterSpacing(this.ctx, spec, spec.typeScale(targetWidth, targetHeight));
      return this.ctx.measureText(this.applyCase(word, spec.textTransform)).width;
    }
    
    // Layout entire caption group — returns positions for each word
    layoutGroup(group, spec, targetWidth, targetHeight, sizeMulFn) {
      const tScale   = spec.typeScale(targetWidth, targetHeight);
      const fontSize = spec.getScaledFontSize(targetHeight, targetWidth);
      const letterSp = spec.getScaledLetterSpacing(targetHeight, targetWidth);
      const wordGap  = spec.wordSpacing === 0
        ? fontSize * 0.27
        : Math.max(0, (fontSize * 0.27) + (spec.wordSpacing * tScale));
      
      const pos = spec.getPixelPosition(targetWidth, targetHeight);
      const maxLineWidth = (spec.maxWidth / 100) * targetWidth;
      
      const wordData = group.words.map((word, wi) => {
        const mul = sizeMulFn ? (sizeMulFn(wi) || 1) : 1;
        return {
          text: this.applyCase(word, spec.textTransform),
          width: this.measureWord(word, spec, targetHeight, mul, targetWidth),
          size: fontSize * mul,   // px size this word is drawn at
          mul: mul
        };
      });

      // Build lines respecting maxWidth and line breaks
      const lines = [];
      let currentLine = [];
      let currentWidth = 0;
      // Keep short captions on a single line (auto-fit handles any overflow)
      const maxWordsPerLine = spec.maxWordsPerLine || 6;
      const keepOneLine = !spec.lineBreakEnabled && group.words.length <= maxWordsPerLine;

      wordData.forEach((word, i) => {
        const wordWidthWithGap = word.width + (currentLine.length > 0 ? wordGap : 0);
        
        // Manual line break
        if(spec.lineBreakEnabled && i === spec.lineBreakAt) {
          if(currentLine.length > 0) lines.push(currentLine);
          currentLine = [word];
          currentWidth = word.width;
          return;
        }
        
        // Auto wrap.
        // A short caption (≤ maxWordsPerLine, default 6) is kept on ONE line even
        // if it's slightly wider than the box — the renderer's auto-fit shrinks it
        // instead. Wrapping a 5-word caption to a second line for a few pixels is
        // what produced the stray word on its own line.
        if(keepOneLine) {
          currentLine.push(word);
          currentWidth += wordWidthWithGap;
          return;
        }
        if(currentWidth + wordWidthWithGap > maxLineWidth && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = [word];
          currentWidth = word.width;
        } else {
          currentLine.push(word);
          currentWidth += wordWidthWithGap;
        }
      });
      
      if(currentLine.length > 0) lines.push(currentLine);
      
      // Calculate line dimensions
      const lineHeight = fontSize * spec.lineHeight;
      const totalHeight = lines.length * lineHeight;
      
      // Position each word
      let wordIdx = 0;
      const positioned = [];
      
      lines.forEach((line, lineIdx) => {
        const lineWidth = line.reduce((sum, w, i) => sum + w.width + (i > 0 ? wordGap : 0), 0);
        const lineY = pos.y - (totalHeight / 2) + (lineIdx * lineHeight) + (lineHeight / 2);
        
        let cursorX;
        switch(spec.textAlign) {
          case 'left':  cursorX = pos.x - (maxLineWidth / 2); break;
          case 'right': cursorX = pos.x + (maxLineWidth / 2) - lineWidth; break;
          default:      cursorX = pos.x - (lineWidth / 2); break;
        }
        
        line.forEach((word, i) => {
          positioned.push({
            index: wordIdx++,
            text: word.text,
            x: cursorX + (word.width / 2), // center X of word
            y: lineY,
            width: word.width,
            height: fontSize,
            size: word.size || fontSize,   // px size THIS word is drawn at
            lineIdx: lineIdx
          });
          cursorX += word.width + wordGap;
        });
      });
      
      return {
        words: positioned,
        totalWidth: Math.max(...lines.map(l => l.reduce((s, w, i) => s + w.width + (i > 0 ? wordGap : 0), 0))),
        totalHeight,
        lineHeight,
        fontSize,
        wordGap,
        centerX: pos.x,
        centerY: pos.y
      };
    }
  }
  
  // ═══════════════════════════════════════════
  // 4. VIDEO METADATA DETECTOR
  // ═══════════════════════════════════════════
  
  class VideoMetadata {
    static async detect(fileOrUrl) {
      return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        
        const src = fileOrUrl instanceof File 
          ? URL.createObjectURL(fileOrUrl) 
          : fileOrUrl;
        
        video.src = src;
        
        const cleanup = () => {
          if(fileOrUrl instanceof File) URL.revokeObjectURL(src);
        };
        
        video.addEventListener('loadedmetadata', () => {
          const metadata = {
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration,
            aspectRatio: video.videoWidth / video.videoHeight,
            resolution: video.videoWidth + 'x' + video.videoHeight,
            // FPS detection (approximate — need frame counting for exact)
            fps: 30, // default, will refine below
          };
          
          // Try to detect FPS more accurately using requestVideoFrameCallback
          if('requestVideoFrameCallback' in video) {
            let lastMediaTime = 0;
            let frameCount = 0;
            let startTime = 0;
            
            const measureFps = (now, metadata2) => {
              if(startTime === 0) startTime = now;
              frameCount++;
              
              if(frameCount >= 10 || (now - startTime) > 1000) {
                const elapsed = (now - startTime) / 1000;
                const detectedFps = Math.round(frameCount / elapsed);
                
                // Snap to common FPS values
                const commonFps = [24, 25, 30, 50, 60];
                metadata.fps = commonFps.reduce((prev, curr) => 
                  Math.abs(curr - detectedFps) < Math.abs(prev - detectedFps) ? curr : prev
                );
                
                video.pause();
                cleanup();
                resolve(metadata);
              } else {
                video.requestVideoFrameCallback(measureFps);
              }
            };
            
            video.play().then(() => {
              video.requestVideoFrameCallback(measureFps);
            }).catch(() => {
              // Play failed, return with default FPS
              cleanup();
              resolve(metadata);
            });
          } else {
            cleanup();
            resolve(metadata);
          }
        });
        
        video.addEventListener('error', (e) => {
          cleanup();
          reject(new Error('Failed to load video metadata: ' + (e.message || 'unknown')));
        });
      });
    }
  }
  
  // ═══════════════════════════════════════════
  // 5. STYLE COLLECTOR
  // Extract current UI state → CaptionStyleSpec
  // ═══════════════════════════════════════════
  
  class StyleCollector {
    static fromUI() {
      const g = (id, prop = 'value', def = '') => {
        const el = document.getElementById(id);
        return el ? el[prop] : def;
      };
      const gn = (id, def = 0) => parseFloat(g(id, 'value', def)) || def;
      const gc = (id, def = false) => {
        const el = document.getElementById(id);
        return el ? el.checked : def;
      };
      
      // Font weight mapping
      const fontStyleValue = g('fontStyleSelect', 'value', 'regular');
      // Shared map — the DOM preview reads the same table, so a weight can never
      // mean one thing in the editor and another in the export.
      const fs = FONT_STYLE_MAP[fontStyleValue] || FONT_STYLE_MAP.regular;
      
      // Detect canvas size
      const canvasW = typeof getCanvasWidth === 'function' ? getCanvasWidth() : 1920;
      const canvasH = typeof getCanvasHeight === 'function' ? getCanvasHeight() : 1080;
      
      // Get current animation style
      const currentStyle = typeof currentAnimStyle !== 'undefined' ? currentAnimStyle : 0;
      const styleProps = typeof animStyleProps !== 'undefined' ? animStyleProps : {};
      
      // Bold override
      const isBold = typeof captionBold !== 'undefined' ? captionBold : false;
      const isItalic = typeof captionItalic !== 'undefined' ? captionItalic : false;
      const textCase = typeof captionTextCase !== 'undefined' ? captionTextCase : 'none';
      const textAlign = typeof captionAlign !== 'undefined' ? captionAlign : 'center';
      
      // Words per group
      const wpg = typeof wordsPerGroup !== 'undefined' ? wordsPerGroup : 3;
      
      // Line break
      const lbEnabled = typeof lineBreakEnabled !== 'undefined' ? lineBreakEnabled : false;
      const lbAt = typeof lineBreakAt !== 'undefined' ? lineBreakAt : 1;
      
      // Shadows — gated on the Text-panel toggle. buildShadowCSS() in index.html
      // returns '' when shadowEnabled is off, but this collector used to hand the
      // shadows[] array over unconditionally, so turning shadows OFF removed them
      // from the preview while the export still burned them in.
      const shadowsOn = gc('shadowEnabled', false);
      const shadowsArr = (shadowsOn && typeof shadows !== 'undefined' && Array.isArray(shadows))
        ? shadows : [];
      
      return new CaptionStyleSpec({
        // Typography
        fontFamily:     g('fontFamily', 'value', "'Montserrat', sans-serif"),
        fontSize:       gn('fontSize', 60),
        fontWeight:     isBold ? 900 : fs.weight,
        fontStyle:      isItalic ? 'italic' : fs.style,
        letterSpacing:  gn('letterSpacing', 0),
        lineHeight:     1 + (gn('lineSpacing', 0) / 100),
        // Global Word Spacing (Text panel) + the active style's optional extra
        // offset, so the export uses the same single effective value as the preview.
        wordSpacing:    gn('wordGap', 0) +
                        (((styleProps && styleProps[currentStyle]) || {}).wordGapExtra || 0),
        textTransform:  textCase,
        textAlign:      textAlign,
        
        // Color
        color:          g('textColor', 'value', '#FFFFFF'),
        
        // Gradient
        gradientEnabled: gc('textGradientOn', false),
        gradientColor1: g('gradientColor1', 'value', '#FF512F'),
        gradientColor2: g('gradientColor2', 'value', '#F09819'),
        gradientAngle:  gn('gradientAngle', 135),
        
        // Stroke
        strokeEnabled:  gc('strokeEnabled', false),
        strokeColor:    g('strokeColor', 'value', '#000000'),
        strokeWidth:    gn('textStroke', 0),
        
        // Shadows
        shadows:        shadowsArr.slice(),
        
        // Glow
        glowEnabled:    gc('textGlowEnabled', false),
        glowColor:      g('glowColorHidden', 'value', '#FFFFFF'),
        glowIntensity:  gn('glowIntensity', 12),
        glowSpread:     gn('glowSpread', 20),
        
        // Highlight
        highlightEnabled:   gc('highlightOn', true),
        highlightBgColor:   g('hlBgColor', 'value', '#FFE500'),
        highlightTextColor: g('hlTextColor', 'value', '#000000'),
        highlightPadH:      gn('hlPadH', 8),
        highlightPadV:      gn('hlPadV', 4),
        highlightRadius:    gn('hlRadius', 5),
        highlightScale:     gn('hlScale', 112) / 100,
        
        // Background
        bgEnabled:      gn('captionBgAlpha', 0) > 0,
        bgColor:        g('captionBg', 'value', '#000000'),
        bgOpacity:      gn('captionBgAlpha', 0),
        
        // Position
        positionX:      gn('posX', 50),
        positionY:      gn('posY', 70),
        maxWidth:       gn('maxWidth', 85),
        maxWordsPerLine: (typeof wordsPerGroup !== 'undefined' ? Math.max(6, wordsPerGroup) : 6),
        
        // Animation
        animationStyle:    currentStyle,
        animationDuration: 400,
        styleProps:        JSON.parse(JSON.stringify(styleProps)),
        
        // Line break
        lineBreakEnabled: lbEnabled,
        lineBreakAt:      lbAt,
        
        // Words per group
        wordsPerGroup:    wpg,
        
        // Canvas
        canvasWidth:  canvasW,
        canvasHeight: canvasH
      });
    }
  }
  
  // ═══════════════════════════════════════════
  // 6. CAPTION RENDERER (Canvas 2D)
  // The ONE draw routine — consumed by both the
  // preview and the export so pixels match.
  // Deterministic: renderFrame(ctx, spec, group, t, W, H)
  // draws the caption for time t at any resolution.
  // ═══════════════════════════════════════════

  class CaptionRenderer {
    constructor() {
      this.anim   = new AnimationEngine();
      this.layout = new TextLayoutEngine();
      // Reusable offscreen canvas for per-word glyph compositing (shadows/glow).
      this._wc = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
      this._wctx = this._wc ? this._wc.getContext('2d') : null;
    }

    // ── Font readiness (fail loudly, never silently fall back) ──
    // Canvas 2D substitutes a fallback SILENTLY, and document.fonts.check() can
    // report true for a family that canvas won't actually resolve at the wanted
    // weight. So we (1) load the exact weight/style, (2) wait for fonts.ready,
    // (3) verify by MEASURING: if the requested family renders identically to a
    // deliberately bogus family, the browser fell back → report failure.
    // Returns { ok, family, weight, style, reason }.
    async ensureFont(spec) {
      const family = (spec.fontFamily || '').replace(/['"]/g, '').split(',')[0].trim();
      const weight = spec.fontWeight || 400;
      const style  = spec.fontStyle || 'normal';
      const out = { ok: true, family, weight, style, reason: '' };
      if(typeof document === 'undefined' || !document.fonts) return out;

      const decl = style + ' ' + weight + ' 64px "' + family + '"';
      try { await document.fonts.load(decl); } catch(_) {}
      try { await document.fonts.ready; } catch(_) {}

      if(!document.fonts.check(decl)) {
        out.ok = false;
        out.reason = 'not loaded';
        return out;
      }

      // Measurement proof: compare against a family that cannot exist.
      try {
        const c = document.createElement('canvas').getContext('2d');
        const probe = 'AGWMinq 123 — wm';
        c.font = style + ' ' + weight + ' 64px "' + family + '", monospace';
        const w1 = c.measureText(probe).width;
        c.font = style + ' ' + weight + ' 64px "__csp_no_such_font__", monospace';
        const w2 = c.measureText(probe).width;
        if(Math.abs(w1 - w2) < 0.01) {
          out.ok = false;
          out.reason = 'canvas fell back to a substitute font';
        }
      } catch(_) { /* keep the fonts.check() result */ }
      return out;
    }

    // Delegates to the shared builder so layout + drawing can never diverge
    fontString(spec, sizePx) { return fontShorthand(spec, sizePx); }

    // hex (#rgb/#rrggbb) + alpha → rgba() string
    // Linear gradient across a text box, matching the CSS gradientAngle used in
    // the preview (0deg = to top, clockwise). Mirrors makeTextGradient in index.html.
    _makeGradient(ctx, spec, x0, y0, x1, y1) {
      const angle = (Number(spec.gradientAngle) || 135) * Math.PI / 180;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const w = x1 - x0, h = y1 - y0;
      const len = Math.sqrt(w*w + h*h) / 2 || 1;
      const dx = Math.sin(angle), dy = -Math.cos(angle);
      const g = ctx.createLinearGradient(cx - dx*len, cy - dy*len, cx + dx*len, cy + dy*len);
      g.addColorStop(0, spec.gradientColor1 || '#FF512F');
      g.addColorStop(1, spec.gradientColor2 || '#F09819');
      return g;
    }

    // ── Optical vertical centre of the letters ──────────────────────────────
    // Glyphs are drawn with textBaseline='middle', which centres the EM BOX —
    // and the em box reserves descender space. So a word with no descenders
    // ("would") ends up sitting high in its highlight bar, with a visible gap
    // underneath. This returns the y offset from the drawing origin to the
    // optical centre of the cap/ascender→baseline block, so bars can be centred
    // on the letters instead of on the em box.
    // Font-level metrics (not per-word bounds) keep every word's bar aligned.
    _opticalCenterY(spec, fontPx) { return opticalCenterOffset(spec, fontPx); }

    _roundRectPath(ctx, x, y, w, h, r) {
      r = Math.max(0, Math.min(r, w/2, h/2));
      ctx.beginPath();
      ctx.moveTo(x+r, y);
      ctx.arcTo(x+w, y,   x+w, y+h, r);
      ctx.arcTo(x+w, y+h, x,   y+h, r);
      ctx.arcTo(x,   y+h, x,   y,   r);
      ctx.arcTo(x,   y,   x+w, y,   r);
      ctx.closePath();
    }

    // Render a single styled word (stroke + fill/gradient) into the reusable
    // offscreen canvas, centered. Returns { canvas, w, h }.
    _renderWordGlyph(text, spec, fillStyle, fontPx, scale) {
      const ctx = this._wctx;
      ctx.font = this.fontString(spec, fontPx);
      const metrics = ctx.measureText(text);
      const strokeW = (spec.strokeEnabled && spec.strokeWidth > 0)
        ? Math.max(1, spec.strokeWidth * scale) : 0;
      const pad = Math.ceil(strokeW + fontPx * 0.35 + 4);
      const w = Math.ceil(metrics.width) + pad * 2;
      const h = Math.ceil(fontPx * 1.6) + pad * 2;
      this._wc.width = w;
      this._wc.height = h;
      // ALWAYS clear explicitly. Assigning width/height is only guaranteed to
      // reset the bitmap when the value actually CHANGES, and this canvas is
      // reused for every word of every frame — so a word the same size as the
      // previous one could inherit its ink. The frame-parity test caught this as
      // "identical frame signature, different pixels": two frames with the same
      // values rendered differently because the canvas state they inherited
      // differed, depending on what the frame BEFORE them had drawn.
      ctx.clearRect(0, 0, w, h);

      // measure/font reset after resize (resizing clears context state)
      ctx.font = this.fontString(spec, fontPx);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if('letterSpacing' in ctx) ctx.letterSpacing = (spec.letterSpacing ? spec.letterSpacing * scale : 0) + 'px';
      ctx.lineJoin = 'round';

      const cx = w/2, cy = h/2;

      // Fill: gradient (spans this word's box) takes precedence — matches the
      // DOM's -webkit-text-fill-color behavior where gradient overrides color.
      let fill = fillStyle;
      if(spec.gradientEnabled) {
        fill = this._makeGradient(ctx, spec, pad, pad, w - pad, h - pad);
      }

      // Stroke first, then fill on top (paint-order: stroke fill).
      if(strokeW > 0) {
        ctx.strokeStyle = spec.strokeColor || '#000';
        ctx.lineWidth = strokeW * 2; // canvas stroke is centered; *2 ≈ CSS text-stroke width outside
        ctx.strokeText(text, cx, cy);
      }
      ctx.fillStyle = fill;
      ctx.fillText(text, cx, cy);

      return { canvas: this._wc, w, h };
    }

    // Cast a blurred shadow of `srcCanvas` onto ctx at (dx,dy) using the
    // off-canvas shift trick so only the shadow (not the source) is visible.
    _castShadow(ctx, srcCanvas, dx, dy, offX, offY, blur, color) {
      const SHIFT = 20000;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = offX + SHIFT;
      ctx.shadowOffsetY = offY;
      ctx.drawImage(srcCanvas, dx - SHIFT, dy);
      ctx.restore();
    }

    // ── EFFECT PAINTING (descriptors -> canvas) ───────────────────────────
    // The maths lives in shadowLayers()/glowLayers()/effectLayers() above and is
    // shared with the DOM preview. These two only turn descriptors into draws,
    // so there is nothing here that can drift from the preview.
    _paintLayers(ctx, glyphCanvas, gx, gy, layers) {
      if(!layers) return;
      // REVERSE: descriptors are front-to-back (see the ORDER CONVENTION note on
      // the shared model), and on canvas a later draw paints on top — so walk from
      // the furthest layer forwards.
      for(let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        if(!l || l.blur < 0) continue;
        this._castShadow(ctx, glyphCanvas, gx, gy, l.dx, l.dy, l.blur, l.color);
      }
    }

    // ── ONE-UNIT WORD LAYER: text + glow + drop shadow ───────────────────
    // Everything belonging to a word is rasterised into a single offscreen layer
    // under an IDENTITY transform, then drawn ONCE under the word's transform.
    // Two reasons this is the only correct structure:
    //
    // 1. CORRECTNESS. ctx.shadowOffsetX/Y are NOT transformed by the CTM, but
    //    drawImage() coordinates ARE. _castShadow() hides its source by drawing
    //    it at -SHIFT and pulling the shadow back with +SHIFT, so the two cancel
    //    ONLY while the CTM has no scale. Under ctx.scale(s) the shadow lands
    //    20000*(s-1) px away — ~800px off for style 7's 1.04 bounce, ~12000px
    //    for style 3's 1.6 active word — i.e. far off-canvas and invisible. Glow
    //    and drop shadows silently vanished on exactly the frames where a word
    //    was mid-animation, which is why exported glow looked like detached
    //    blobs instead of a halo following the text. Compositing at identity
    //    transform makes the SHIFT trick exact again.
    //
    // 2. NO EFFECT DRIFT. Text, glow and shadow inherit ONE transform matrix, so
    //    they translate, scale and fade as a single visual unit and cannot drift
    //    apart. This also matches the DOM, where a CSS transform on a chip
    //    scales the element together with its text-shadow output.
    //
    // Paint order inside the layer is back→front: DROP SHADOW → GLOW → SHARP
    // TEXT, so the glow sits between the shadow and the crisp glyph and the
    // original font is never obscured.
    //
    // The layer is padded by the widest bleed any effect can cast, otherwise the
    // glow would clip to a hard-edged box at the layer boundary.
    _composeWordLayer(text, spec, fillColor, wSize, scale, layers) {
      const glyph = this._renderWordGlyph(text, spec, fillColor, wSize, scale);

      // How far outside the glyph box can anything paint? shadowBlur B is a
      // Gaussian of sigma B/2, so 2*B covers >4 sigma — visually all of it.
      // Derived from the descriptors themselves, so it tracks the shared model.
      // Bleed straight off the descriptors, so it can never under-estimate a
      // layer the shared model added. shadowBlur B is a Gaussian of sigma B/2,
      // so |offset| + 2B covers >4 sigma of every layer.
      let bleed = 0;
      const _allLayers = (layers.shadow || []).concat(layers.glow || []);
      for(let i = 0; i < _allLayers.length; i++) {
        const l = _allLayers[i];
        bleed = Math.max(bleed, Math.hypot(l.dx, l.dy) + l.blur * 2);
      }
      bleed = Math.ceil(Math.min(bleed, 4000));   // sanity cap

      // No effects → hand back the glyph itself, no extra buffer or copy.
      if(bleed <= 0) {
        return { canvas: glyph.canvas, cx: glyph.w / 2, cy: glyph.h / 2 };
      }

      const lw = Math.ceil(glyph.w + bleed * 2);
      const lh = Math.ceil(glyph.h + bleed * 2);
      if(!this._lc) {
        this._lc   = document.createElement('canvas');
        this._lctx = this._lc.getContext('2d');
      }
      if(this._lc.width !== lw)  this._lc.width  = lw;
      if(this._lc.height !== lh) this._lc.height = lh;
      const lctx = this._lctx;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalAlpha = 1;
      lctx.clearRect(0, 0, lw, lh);

      const gx = bleed, gy = bleed;          // glyph origin inside the layer
      // Groups back to front: DROP SHADOW is furthest, then GLOW, then the sharp
      // glyph. Within each group _paintLayers handles front-to-back ordering.
      // Matches the DOM, where the caption's text-shadow list is [glow, shadow]
      // and CSS puts the earlier group on top.
      this._paintLayers(lctx, glyph.canvas, gx, gy, layers.shadow);
      this._paintLayers(lctx, glyph.canvas, gx, gy, layers.glow);
      lctx.drawImage(glyph.canvas, gx, gy);   // sharp text always on top

      return { canvas: this._lc, cx: lw / 2, cy: lh / 2 };
    }

    // Draw one caption group at time t. Caller sets up ctx; does NOT clear.
    // Draw one caption group at time t. Caller sets up ctx; does NOT clear.
    // Thin wrapper: compute the shared frame, then hand it to the canvas backend.
    renderFrame(ctx, spec, group, t, W, H) {
      const frame = computeFrame(spec, group, t, W, H,
                                 { anim: this.anim, layout: this.layout });
      this.drawFrame(ctx, frame, spec);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CANVAS BACKEND
    // ═══════════════════════════════════════════════════════════════════════
    // Consumes a computeFrame() result and draws it. It computes NO geometry,
    // timing, metric or effect value of its own — every number comes from
    // `frame`. The DOM preview backend consumes the very same object, which is
    // what makes "what I see is what I get" structural rather than maintained.
    //
    // `spec` is still passed because drawing needs the raw glyph paint settings
    // (font shorthand, gradient stops, stroke colour). Those are style INPUTS,
    // not computed values.
    drawFrame(ctx, frame, spec) {
      if(!frame) return;
      const containerOpacity = frame.containerOpacity;
      if(containerOpacity <= 0) return;
      const scale = frame.scale;

      ctx.save();
      ctx.globalAlpha = 1;

      // ── AUTO-FIT (computed in computeFrame; applied here) ──
      if(frame.fit < 1) {
        ctx.translate(frame.centerX, frame.centerY);
        ctx.scale(frame.fit, frame.fit);
        ctx.translate(-frame.centerX, -frame.centerY);
      }

      // ── Container background box ──
      const bg = frame.containerBg;
      if(bg) {
        const padH = (bg.padH || 0) * scale, padV = (bg.padV || 0) * scale;
        const x0 = frame.centerX - frame.totalWidth/2 - padH;
        const y0 = frame.centerY - frame.totalHeight/2 - padV;
        ctx.save();
        ctx.globalAlpha = containerOpacity * (bg.opacity == null ? 1 : bg.opacity);
        ctx.fillStyle = bg.color || '#000';
        this._roundRectPath(ctx, x0, y0,
                            frame.totalWidth + padH*2, frame.totalHeight + padV*2,
                            (bg.radius || 0) * scale);
        ctx.fill();
        ctx.restore();
      }

      // ── Per-word draw, in the shared paint order ──
      frame.drawOrder.forEach((i) => {
        const w = frame.words[i];
        if(!w || !w.visible || w.opacity <= 0) return;

        ctx.save();
        ctx.globalAlpha = containerOpacity * w.opacity;
        ctx.translate(w.x, w.y);
        if(w.rotation) ctx.rotate(w.rotation * Math.PI / 180);
        // Anchor extra scale at the BOTTOM (baseline) so a bigger word grows
        // UPWARD instead of shifting the line.
        if(w.scale !== 1) {
          if(w.anchorBottom) {
            ctx.translate(0, w.baseline);
            ctx.scale(w.scale, w.scale);
            ctx.translate(0, -w.baseline);
          } else {
            ctx.scale(w.scale, w.scale);
          }
        }

        // Border/Pop-up bar behind the word (style 7).
        if(w.wordBar) {
          const padH = (w.wordBar.padH || 0) * scale;
          const padV = (w.wordBar.padV || 0) * scale;
          const bw = w.width + padH*2;
          const bh = w.letterH + padV*2;   // hug the letters, not the em box
          const barScale = (w.wordBar.scale == null ? 1 : w.wordBar.scale);
          ctx.save();
          // transform-origin is the bar's OWN centre, matching the DOM's
          // .s7-word-bar { transform-origin: center center }. Scaling about the
          // word origin instead moved the bar by opticalY*(barScale-1) each frame.
          if(barScale !== 1) {
            ctx.translate(0, w.opticalY);
            ctx.scale(barScale, barScale);
            ctx.translate(0, -w.opticalY);
          }
          ctx.fillStyle = w.wordBar.color;
          this._roundRectPath(ctx, -bw/2, w.opticalY - bh/2, bw, bh,
                              (w.wordBar.radius || 0) * scale);
          ctx.fill();
          ctx.restore();
        }

        // Highlight pill behind the word (styles 1/2).
        if(w.bgColor) {
          const padH = (spec.highlightPadH || 0) * scale;
          const padV = (spec.highlightPadV || 0) * scale;
          const bw = w.width + padH*2;
          const bh = frame.fontPx + padV*2;   // em-box pill — matches the DOM
          ctx.fillStyle = w.bgColor;
          this._roundRectPath(ctx, -bw/2, -bh/2, bw, bh,
                              (spec.highlightRadius || 0) * scale);
          ctx.fill();
        }

        // Word + its effects as ONE composited unit. Effects are baked into the
        // layer, never cast onto this transformed context — see _composeWordLayer.
        const layer = this._composeWordLayer(w.text, spec, w.color, w.fontPx,
                                             scale, w.effects);
        ctx.drawImage(layer.canvas, -layer.cx, -layer.cy);
        ctx.restore();
      });

      ctx.restore();
    }

    // Clear the target and draw whatever is active at time t.
    // computeFrame() owns "which group is active" (and returns null in a gap), so
    // that decision is not duplicated here.
    renderComposite(ctx, spec, groups, t, W, H, clear) {
      if(clear !== false) ctx.clearRect(0, 0, W, H);
      const frame = this.computeFrame(spec, groups, t, W, H);
      this.drawFrame(ctx, frame, spec);
      return frame;
    }

    // Compute the shared frame with THIS renderer's engines (so font metrics are
    // measured against the same reusable canvas context). Exposed so a caller can
    // get the frame without drawing — the DOM preview backend and the debug
    // comparison both use this.
    computeFrame(spec, groups, t, W, H) {
      return computeFrame(spec, groups, t, W, H,
                          { anim: this.anim, layout: this.layout });
    }
  }

  // ═══════════════════════════════════════════
  // 7. COMPUTE FRAME  —  THE SINGLE SOURCE OF TRUTH
  // ═══════════════════════════════════════════
  // Everything that decides how a caption LOOKS at time t is computed here, once,
  // and handed to whichever backend is drawing:
  //
  //     spec + groups + t + (W,H)
  //              |
  //         computeFrame()          <-- animation, layout, metrics, effects, fit
  //              |
  //      +-------+-------+
  //      |               |
  //   DOM preview     canvas export
  //   (applies as     (draws to
  //    CSS)            canvas)
  //
  // Neither backend may recompute any of these values. If a style needs to change,
  // it changes in AnimationEngine / TextLayoutEngine / the shared effect model and
  // both backends follow automatically.
  //
  // Returns null when no caption is active at t — the callers must then render
  // nothing, which is what makes gaps between caption layers genuinely empty in
  // both the preview and the exported file.
  function computeFrame(spec, groups, t, W, H, deps) {
    const anim   = (deps && deps.anim)   || new AnimationEngine();
    const layoutEngine = (deps && deps.layout) || new TextLayoutEngine();

    // `groups` may be the whole array (the active one is picked by time) or a
    // single group object (used as-is). The array form is what makes gaps between
    // caption layers genuinely empty in both backends.
    let active = null, activeIndex = -1;
    if(Array.isArray(groups)) {
      for(let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if(t >= g.start && t < g.end) { active = g; activeIndex = i; break; }
      }
    } else if(groups) {
      active = groups; activeIndex = 0;
    }
    if(!active || !active.words || !active.words.length) return null;

    const state  = anim.calculate(spec, active, t);
    const layout = layoutEngine.layoutGroup(active, spec, W, H);
    const scale  = spec.typeScale(W, H);
    const fontPx = layout.fontSize;

    // ── AUTO-FIT (shared) ────────────────────────────────────────────────
    // The containment box and the overhang charged against it must be identical
    // in both backends or an off-centre or heavily-stroked caption fits in one
    // and clips in the other.
    const spProps   = (spec.styleProps || {})[spec.animationStyle] || {};
    const pX        = spec.positionX == null ? 50 : spec.positionX;
    const safePct   = Math.max(20, Math.min(spec.maxWidth || 85,
                                            pX * 2 - EDGE_INSET_PCT,
                                            (100 - pX) * 2 - EDGE_INSET_PCT));
    const availW    = W * (Math.min(safePct, 100) / 100);
    const strokeOut = (spec.strokeEnabled && spec.strokeWidth > 0) ? spec.strokeWidth : 0;
    const bgPad     = state.containerBg
      ? (state.containerBg.padH || 0)
      : ((spec.bgEnabled && spec.bgOpacity > 0) ? (spec.bgPadH || 0) : 0);

    let wordOut = spProps.padH || 0, scaleGrow = 0;
    const stWords = state.words || [];
    for(let i = 0; i < stWords.length; i++) {
      const ws = stWords[i]; if(!ws) continue;
      const wb    = ws.wordBar;
      const wbPad = wb ? (wb.padH || 0) * Math.max(1, wb.scale || 1) : 0;
      const hlPad = ws.bgColor ? (spec.highlightPadH || 0) : 0;
      wordOut = Math.max(wordOut, wbPad, hlPad);
      const wsScale = ws.scale || 1;
      const pw = layout.words[i];
      if(wsScale > 1 && pw) scaleGrow = Math.max(scaleGrow, (wsScale - 1) * (pw.width || 0));
    }
    if(!stWords.length && spec.highlightEnabled) {
      wordOut = Math.max(wordOut, spec.highlightPadH || 0);
    }
    const padOut = 2 * (strokeOut + Math.max(bgPad, wordOut)) * scale;
    const fitW   = layout.totalWidth + scaleGrow + padOut;
    const fit    = (fitW > availW && fitW > 0) ? (availW / fitW) : 1;

    // ── Per-word resolved values ─────────────────────────────────────────
    // One entry per word with EVERYTHING a backend needs. No backend may derive
    // any of this for itself.
    const lmBase = letterMetrics(spec, fontPx);
    const words = layout.words.map((pw, i) => {
      const ws      = stWords[i] || {};
      const wSize   = pw.size || fontPx;
      const lm      = (wSize === fontPx) ? lmBase : letterMetrics(spec, wSize);
      const baseline = pw.y + lmBase.baseline;
      return {
        index:      i,
        text:       pw.text,
        visible:    ws.visible !== false,
        x:          pw.x + (ws.x || 0) * scale,
        y:          baseline - lm.baseline + (ws.y || 0) * scale,
        width:      pw.width,
        fontPx:     wSize,
        letterH:    lm.letterH,
        baseline:   lm.baseline,
        opticalY:   lm.centerY,
        scale:      ws.scale == null ? 1 : ws.scale,
        opacity:    ws.opacity == null ? 1 : ws.opacity,
        rotation:   ws.rotation || 0,
        color:      ws.color || spec.color || '#fff',
        highlighted: !!ws.highlighted,
        anchorBottom: !!ws.anchorBottom,
        bgColor:    ws.bgColor || null,
        wordBar:    ws.wordBar || null,
        effects:    effectLayers(spec, ws, scale)
      };
    });

    // Paint order: inactive words first, the highlighted one LAST so it sits on
    // top. Canvas has no z-index (a later draw wins) and the DOM needs the same
    // decision expressed as z-index — so the decision itself is made here, once.
    const drawOrder = words.map((_, i) => i)
      .sort((a, b) => (words[a].highlighted ? 1 : 0) - (words[b].highlighted ? 1 : 0));

    return {
      // identity
      t: t, groupIndex: activeIndex, group: active,
      drawOrder: drawOrder,
      // frame geometry
      width: W, height: H, scale: scale, fit: fit,
      availWidth: availW, safePct: safePct,
      // typography resolved once
      fontFamily: spec.fontFamily, fontWeight: spec.fontWeight, fontStyle: spec.fontStyle,
      fontPx: fontPx,
      letterSpacing: spec.getScaledLetterSpacing(H, W),
      strokeWidth: (spec.strokeEnabled ? spec.strokeWidth : 0) * scale,
      strokeColor: spec.strokeColor,
      lineHeight: spec.lineHeight,
      // layout
      centerX: layout.centerX, centerY: layout.centerY,
      totalWidth: layout.totalWidth, totalHeight: layout.totalHeight,
      lines: layout.lines,
      // animation
      containerOpacity: state.containerOpacity == null ? 1 : state.containerOpacity,
      containerBg: state.containerBg || null,
      animationStyle: spec.animationStyle,
      // per-word
      words: words,
      // raw state/layout for anything a backend still needs verbatim
      _state: state, _layout: layout
    };
  }

  // ── DEBUG / VALIDATION (requirement 12) ──────────────────────────────────
  // Flatten a frame to a comparable, log-friendly record. Both backends can be
  // asked to describe what they actually applied, and the two records diffed, so
  // a divergence is a failing key rather than something spotted by eye.
  function describeFrame(frame) {
    if(!frame) return { active: false };
    const r = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
    return {
      active: true,
      t: r(frame.t), groupIndex: frame.groupIndex,
      frame: frame.width + 'x' + frame.height,
      scale: r(frame.scale), fit: r(frame.fit), safePct: r(frame.safePct),
      font: frame.fontFamily + ' / ' + frame.fontWeight + ' / ' + frame.fontStyle,
      fontPx: r(frame.fontPx), letterSpacing: r(frame.letterSpacing),
      strokeWidth: r(frame.strokeWidth), strokeColor: frame.strokeColor,
      centerX: r(frame.centerX), centerY: r(frame.centerY),
      totalWidth: r(frame.totalWidth), totalHeight: r(frame.totalHeight),
      containerOpacity: r(frame.containerOpacity),
      containerBg: frame.containerBg
        ? { padH: r(frame.containerBg.padH), padV: r(frame.containerBg.padV),
            radius: r(frame.containerBg.radius), color: frame.containerBg.color,
            opacity: r(frame.containerBg.opacity) }
        : null,
      animationStyle: frame.animationStyle,
      words: frame.words.map(w => ({
        i: w.index, text: w.text,
        x: r(w.x), y: r(w.y), width: r(w.width), fontPx: r(w.fontPx),
        scale: r(w.scale), opacity: r(w.opacity), rotation: r(w.rotation),
        color: w.color, highlighted: w.highlighted, bgColor: w.bgColor,
        wordBar: w.wordBar ? { padH: r(w.wordBar.padH), padV: r(w.wordBar.padV),
                               radius: r(w.wordBar.radius), color: w.wordBar.color,
                               scale: r(w.wordBar.scale) } : null,
        shadowLayers: w.effects.shadow.length,
        glowLayers: w.effects.glow.length,
        shadowCSS: layersToCSS(w.effects.shadow),
        glowCSS: layersToCSS(w.effects.glow)
      }))
    };
  }

  // Deep-diff two describeFrame() records. Returns [] when identical.
  // Used by the regression test and available at runtime for debugging.
  function diffFrames(a, b, pathPrefix) {
    const out = [];
    const p = pathPrefix || '';
    const isObj = (v) => v && typeof v === 'object';
    if(!isObj(a) || !isObj(b)) {
      if(a !== b) out.push({ path: p || '(root)', preview: a, exportv: b });
      return out;
    }
    const keys = {};
    Object.keys(a).forEach(k => keys[k] = 1);
    Object.keys(b).forEach(k => keys[k] = 1);
    Object.keys(keys).forEach(k => {
      const av = a[k], bv = b[k];
      if(isObj(av) || isObj(bv)) {
        diffFrames(av, bv, p ? p + '.' + k : k).forEach(d => out.push(d));
      } else if(av !== bv) {
        out.push({ path: p ? p + '.' + k : k, preview: av, exportv: bv });
      }
    });
    return out;
  }

  // ═══════════════════════════════════════════
  // 8. DOM BACKEND  —  the preview consumes the SAME frame
  // ═══════════════════════════════════════════
  // applyFrameToDOM() is the preview's counterpart to drawFrame(). It takes a
  // computeFrame() result and writes those exact numbers onto the caption DOM as
  // CSS. It runs as a POST-PASS after a style block has built its markup, so it
  // is authoritative: whatever a per-style block computed for these properties is
  // overwritten by the shared frame. That is what stops the preview and the export
  // drifting — the DOM cannot hold an opinion about a value the frame owns.
  //
  // Deliberate limits, so this cannot silently fight a style's own animation:
  //
  //   • Container geometry, typography and the auto-fit are ALWAYS applied. These
  //     are never animated by CSS keyframes in any style.
  //   • Per-word colour and the effect stack (shadow + glow, formatted from the
  //     SAME descriptors the canvas casts) are ALWAYS applied.
  //   • Per-word transform/opacity are applied only when `opts.ownsAnimation` is
  //     false. Styles 4 and 6 drive transform/opacity from injected CSS keyframes;
  //     hard-setting those would freeze their animation. Those two still need
  //     their timing ported into AnimationEngine — until then their transform and
  //     opacity are the one thing not frame-driven, and this is the single place
  //     that exception lives.
  //
  // Returns a record of what it actually applied, so the debug comparison can
  // diff DOM-applied values against the frame instead of relying on eyeballing.
  function applyFrameToDOM(disp, frame, spec, opts) {
    if(!disp) return null;
    const o = opts || {};
    if(!frame) {
      // No caption at this time — the exporter paints nothing, so neither may the
      // preview, or a gap between caption layers would show text in the editor
      // that the exported file does not have.
      disp.style.visibility = 'hidden';
      return { active: false };
    }
    disp.style.visibility = '';

    // previewScale converts frame (canvas-space) px into on-screen px. The frame
    // itself is resolution-independent; only this last hop differs from export.
    const k = (o.previewScale == null ? 1 : o.previewScale);
    const px = (v) => (v * k).toFixed(2) + 'px';

    // ── Container: typography + geometry, straight from the frame ──
    disp.style.fontFamily    = frame.fontFamily;
    disp.style.fontWeight    = String(frame.fontWeight);
    disp.style.fontStyle     = frame.fontStyle;
    disp.style.fontSize      = px(frame.fontPx);
    disp.style.letterSpacing = px(frame.letterSpacing);
    // lineHeight and maxWidth are deliberately NOT set here. The per-style blocks
    // drive the flex layout (rowGap / columnGap / flexWrap) and already derive
    // maxWidth from the SAME shared safe box, so writing them again would only
    // risk fighting a layout this pass does not model.
    if(!o.ownsAnimation) disp.style.opacity = String(frame.containerOpacity);

    // ── Auto-fit: the frame already decided it; the DOM just applies it. ──
    // Both backends therefore shrink by the identical factor.
    const base = 'translate(-50%, -50%)';
    disp.style.transform = base + (frame.fit < 0.999
      ? ' scale(' + frame.fit.toFixed(4) + ')' : '');

    const applied = {
      active: true,
      fontPx: frame.fontPx, letterSpacing: frame.letterSpacing,
      fit: frame.fit, safePct: frame.safePct,
      containerOpacity: o.ownsAnimation ? null : frame.containerOpacity,
      words: []
    };

    // ── Per-word ──
    const chips = disp.querySelectorAll('.word-chip');
    for(let i = 0; i < frame.words.length && i < chips.length; i++) {
      const w = frame.words[i], chip = chips[i];
      if(!chip) continue;

      // Effects: formatted from the SAME descriptors drawFrame() casts. Glow is
      // listed BEFORE the shadow so CSS paints it nearer the glyph, matching the
      // canvas group order (shadow furthest back, then glow, then sharp text).
      const shadowCSS = layersToCSS(w.effects.shadow);
      const glowCSS   = layersToCSS(w.effects.glow);
      const stack     = [glowCSS, shadowCSS].filter(Boolean).join(', ');
      // A gradient fill makes the glyph's own fill transparent, so text-shadow
      // would paint OVER the visible gradient. filter:drop-shadow() is a
      // post-composite effect and stays behind it.
      if(spec.gradientEnabled && stack) {
        chip.style.textShadow = '';
        chip.style.filter = stack.split(/,(?![^()]*\))/)
          .map(l => 'drop-shadow(' + l.trim() + ')').join(' ');
      } else {
        chip.style.filter = '';
        chip.style.textShadow = stack;
      }

      chip.style.color = w.color;
      // Shared paint order expressed as z-index (canvas uses draw order).
      chip.style.zIndex = String(frame.drawOrder.indexOf(i) + 1);

      if(!o.ownsAnimation) {
        chip.style.transformOrigin = w.anchorBottom ? 'center bottom' : 'center center';
        const parts = [];
        if(w.rotation) parts.push('rotate(' + w.rotation + 'deg)');
        if(w.scale !== 1) parts.push('scale(' + w.scale.toFixed(4) + ')');
        chip.style.transform = parts.join(' ');
        chip.style.opacity   = String(w.opacity);
        chip.style.visibility = w.visible ? '' : 'hidden';
      }

      applied.words.push({
        i: i, text: w.text, color: w.color,
        scale: o.ownsAnimation ? null : w.scale,
        opacity: o.ownsAnimation ? null : w.opacity,
        shadowCSS: shadowCSS, glowCSS: glowCSS
      });
    }
    return applied;
  }

  // ── DEBUG COMPARISON (requirement 12) ────────────────────────────────────
  // Diff what the DOM actually applied against the authoritative frame. Any
  // non-empty result is a preview/export divergence, named by key.
  function compareDOMToFrame(applied, frame, opts) {
    const o = opts || {};
    const out = [];
    if(!applied || !frame) {
      if(!!applied !== !!frame) out.push({ path: 'active', preview: !!applied, exportv: !!frame });
      return out;
    }
    const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);
    const cmp = (path, a, b, tol) => {
      if(typeof a === 'number' && typeof b === 'number') {
        if(!near(a, b, tol)) out.push({ path: path, preview: a, exportv: b });
      } else if(a !== b) out.push({ path: path, preview: a, exportv: b });
    };
    cmp('fontPx', applied.fontPx, frame.fontPx);
    cmp('letterSpacing', applied.letterSpacing, frame.letterSpacing);
    cmp('fit', applied.fit, frame.fit);
    cmp('safePct', applied.safePct, frame.safePct);
    if(!o.ownsAnimation) cmp('containerOpacity', applied.containerOpacity, frame.containerOpacity);
    applied.words.forEach((aw, i) => {
      const fw = frame.words[i];
      if(!fw) { out.push({ path: 'words['+i+']', preview: aw.text, exportv: '(missing)' }); return; }
      cmp('words['+i+'].text', aw.text, fw.text);
      cmp('words['+i+'].color', aw.color, fw.color);
      cmp('words['+i+'].shadowCSS', aw.shadowCSS, layersToCSS(fw.effects.shadow));
      cmp('words['+i+'].glowCSS', aw.glowCSS, layersToCSS(fw.effects.glow));
      if(!o.ownsAnimation) {
        cmp('words['+i+'].scale', aw.scale, fw.scale);
        cmp('words['+i+'].opacity', aw.opacity, fw.opacity);
      }
    });
    return out;
  }

  // ═══════════════════════════════════════════
  // 9. EXPORT PREFLIGHT  —  fail loudly, never export something wrong
  // ═══════════════════════════════════════════
  // Run before a single frame is rendered. It is driven entirely by the style
  // REGISTRY, so a style added later is checked automatically — the whole point
  // being that an unsupported or half-declared style produces a clear error
  // instead of a silently incorrect video.
  //
  // Returns { ok, errors[], warnings[], styles[], notes[] }.
  //   errors   -> refuse to export
  //   warnings -> export, but tell the user what was substituted
  //
  // `styleOf(groupIndex)` lets the caller supply per-layer styles (the app allows
  // a different animation per caption layer); omitted, spec.animationStyle is used.
  function validateProject(spec, groups, opts) {
    const o = opts || {};
    const errors = [], warnings = [], notes = [];
    const usedStyles = {};

    if(!spec) {
      return { ok: false, errors: ['No caption style available — the style panel could not be read.'],
               warnings: [], styles: [], notes: [] };
    }
    if(!groups || !groups.length) {
      return { ok: false, errors: ['No captions to export.'], warnings: [], styles: [], notes: [] };
    }

    // ── 1. every style in use must be registered, with the props it declares ──
    groups.forEach((g, gi) => {
      const sid = o.styleOf ? o.styleOf(gi) : spec.animationStyle;
      usedStyles[sid] = (usedStyles[sid] || 0) + 1;
    });

    Object.keys(usedStyles).forEach(k => {
      const sid = isNaN(+k) ? k : +k;
      const def = getStyleDef(sid);
      if(!def) {
        errors.push('Caption layer(s) use animation style ' + sid + ', which is not registered. ' +
                    'Register it with CaptionEngine.registerStyle() — the exporter reads the ' +
                    'registry, so an unregistered style cannot be rendered.');
        return;
      }
      // Required styleProps: resolveStyleProps() fills declared defaults, so only
      // a key with NO default and NO project value is a genuine problem.
      const resolved = resolveStyleProps(spec, sid);
      const missing = def.requires.filter(k2 => resolved[k2] === undefined);
      if(missing.length) {
        errors.push('"' + def.name + '" is missing required propert' +
                    (missing.length > 1 ? 'ies' : 'y') + ': ' + missing.join(', ') +
                    '. Add a default in its registerStyle() declaration.');
      }
      // Any prop the project supplies that the style never declared: harmless, but
      // it is usually a rename that will silently stop taking effect.
      const declared = {};
      def.requires.forEach(k2 => declared[k2] = 1);
      Object.keys(def.defaults).forEach(k2 => declared[k2] = 1);
      const given = ((spec.styleProps || {})[sid]) || {};
      const undeclared = Object.keys(given).filter(k2 => !declared[k2]);
      if(undeclared.length) {
        warnings.push('"' + def.name + '" is given propert' +
                      (undeclared.length > 1 ? 'ies' : 'y') + ' it does not declare: ' +
                      undeclared.join(', ') + ' (ignored by the renderer).');
      }
      // Declared channels must be ones both backends can apply.
      const unsupported = def.produces.filter(c => RENDER_CHANNELS.indexOf(c) < 0);
      if(unsupported.length) {
        errors.push('"' + def.name + '" drives channel(s) the renderer does not support: ' +
                    unsupported.join(', ') + '.');
      }
      if(def.domOwnsAnimation) {
        notes.push('"' + def.name + '" animates transform/opacity from CSS keyframes in the ' +
                   'preview, so those two channels are not yet shared with the exporter. ' +
                   'Position, typography, colour and effects are.');
      }
    });

    // ── 2. timing data must be sane ──
    groups.forEach((g, gi) => {
      const label = 'Caption ' + (gi + 1);
      if(!(typeof g.start === 'number' && typeof g.end === 'number') ||
         !isFinite(g.start) || !isFinite(g.end)) {
        errors.push(label + ' has invalid start/end times.');
        return;
      }
      if(g.end <= g.start) errors.push(label + ' ends at or before it starts (' + g.start + ' -> ' + g.end + ').');
      if(!g.words || !g.words.length) { errors.push(label + ' has no words.'); return; }
      if(g.wordTimes && g.wordTimes.length !== g.words.length) {
        warnings.push(label + ' has ' + g.words.length + ' words but ' + g.wordTimes.length +
                      ' word timings — word-by-word animation will fall back to even spacing.');
      }
      if(g.wordTimes) {
        for(let i = 0; i < g.wordTimes.length; i++) {
          const wt = g.wordTimes[i];
          if(!wt || !isFinite(wt.start) || !isFinite(wt.end) || wt.end < wt.start) {
            warnings.push(label + ' word ' + (i + 1) + ' has invalid timing.');
            break;
          }
        }
      }
    });

    // ── 3. effects the project asks for must be renderable ──
    // NOTE: there is deliberately no "glow size is 0" check. CaptionStyleSpec and
    // the preview BOTH default glowIntensity/glowSpread with `|| 12` / `|| 20`, so
    // a 0 from the UI becomes the default and the value can never actually be 0.
    // The two layers agree, so it is not a parity bug — but it does mean the glow
    // sliders cannot be set to 0. Fixing that needs `??` in both places at once.
    // NOTE: no "glow is invisible" check exists on purpose. CaptionStyleSpec and
    // the preview BOTH apply falsy defaults (glowIntensity `|| 12`, glowSpread
    // `|| 20`, glowColor `|| '#FFFFFF'`), so 0 / '' from the UI becomes the
    // default and no invalid value can reach here. The two layers agree, so it is
    // not a parity bug — but it does mean the glow sliders cannot be set to 0.
    // Fixing that needs `??` in both places at once, which is a behaviour change.
    if(Array.isArray(spec.shadows) && spec.shadows.length) {
      const dead = spec.shadows.filter(sh => sh && _normOpacity(sh.opacity) <= 0).length;
      if(dead) warnings.push(dead + ' drop shadow layer(s) have opacity 0 and will not render.');
    }
    if(spec.strokeEnabled && !(spec.strokeWidth > 0)) {
      warnings.push('Stroke is enabled but its width is 0 — it will not be visible.');
    }
    if(spec.gradientEnabled && !(spec.gradientColor1 && spec.gradientColor2)) {
      errors.push('Gradient fill is on but its colours are incomplete.');
    }

    // ── 4. the frame must actually compute for every style in use ──
    // Cheapest possible end-to-end proof: if computeFrame throws or returns an
    // incomplete frame, the export would have produced garbage.
    try {
      const probeW = spec.canvasWidth || CANVAS_REF_W;
      const probeH = spec.canvasHeight || CANVAS_REF_H;
      const anim = new AnimationEngine(), layout = new TextLayoutEngine();
      Object.keys(usedStyles).forEach(k => {
        const sid = isNaN(+k) ? k : +k;
        if(!getStyleDef(sid)) return;             // already reported above
        const g = groups.find(gr => gr.words && gr.words.length) || groups[0];
        const probeSpec = spec.clone ? spec.clone({ animationStyle: sid }) : spec;
        [0, 0.5, 1].forEach(p => {
          const t = g.start + (g.end - g.start) * p - (p === 1 ? 0.001 : 0);
          const f = computeFrame(probeSpec, g, t, probeW, probeH, { anim: anim, layout: layout });
          if(!f) return;                          // legitimately nothing at t
          if(!f.words.length || !f.words.every(w => isFinite(w.x) && isFinite(w.y) && w.fontPx > 0)) {
            errors.push('"' + getStyleDef(sid).name + '" produced an invalid frame at ' +
                        Math.round(p * 100) + '% of a caption — refusing to export it.');
          }
        });
      });
    } catch(err) {
      errors.push('Frame computation failed: ' + (err && err.message ? err.message : String(err)));
    }

    const styleList = Object.keys(usedStyles).map(k => {
      const sid = isNaN(+k) ? k : +k;
      const def = getStyleDef(sid);
      return { id: sid, name: def ? def.name : '(unregistered)', layers: usedStyles[k],
               registered: !!def };
    });

    return {
      ok: errors.length === 0,
      errors: errors, warnings: warnings, notes: notes, styles: styleList
    };
  }

  // ── FRAME SIGNATURE  (performance: §6) ───────────────────────────────────
  // A compact, EXACT fingerprint of everything in a frame that affects pixels.
  // drawFrame() is deterministic given (frame, spec), and spec is constant for
  // the duration of an export — so two frames with the same signature rasterise
  // to byte-identical images, and the second one need not be drawn or encoded.
  //
  // This is what lets the exporter skip the expensive step (canvas.toDataURL is
  // ~14.6 ms/frame at 1080x1920 against ~0.5 ms to draw, so PNG encoding is ~96%
  // of the render phase). Captions hold still between word changes and gaps are
  // fully empty, so a large fraction of frames are exact repeats.
  //
  // Deliberately NOT a pixel hash: hashing pixels would require rendering the
  // frame first, which is the cost being avoided.
  //
  // EXACT, NOT ROUNDED. An earlier version quantised to 3 decimals, which let
  // consecutive frames of a continuous easing curve (style 7's bounce produces
  // scale 1.0399 then 1.0401) collide and reuse a frame that should have been
  // marginally different — measured as ~0.02% of pixels off by 1-3 levels. Tiny,
  // but it is still trading accuracy for speed, so the signature carries full
  // precision. The large wins do not depend on rounding: empty gaps and the
  // holds between word changes are bit-identical anyway.
  function frameSignature(frame) {
    if(!frame) return 'e';                       // empty gap — one shared blank frame
    const q = (v) => (v == null ? '' : v);
    const parts = [
      frame.groupIndex, q(frame.fontPx), q(frame.letterSpacing), q(frame.fit),
      q(frame.containerOpacity), q(frame.centerX), q(frame.centerY),
      q(frame.totalWidth), q(frame.totalHeight), q(frame.strokeWidth),
      frame.containerBg
        ? [q(frame.containerBg.padH), q(frame.containerBg.padV), q(frame.containerBg.radius),
           frame.containerBg.color, q(frame.containerBg.opacity)].join(',')
        : '-',
      frame.drawOrder.join('.')
    ];
    const w = frame.words;
    for(let i = 0; i < w.length; i++) {
      const x = w[i];
      parts.push([
        x.text, q(x.x), q(x.y), q(x.width), q(x.fontPx),
        q(x.scale), q(x.opacity), q(x.rotation), x.color,
        x.visible ? 1 : 0, x.anchorBottom ? 1 : 0, x.bgColor || '-',
        x.wordBar ? [q(x.wordBar.padH), q(x.wordBar.padV), q(x.wordBar.radius),
                     x.wordBar.color, q(x.wordBar.scale)].join(',') : '-',
        // effect layers affect pixels, so they belong in the signature
        x.effects.shadow.map(l => q(l.dx)+','+q(l.dy)+','+q(l.blur)+','+l.color).join(';'),
        x.effects.glow.map(l => q(l.dx)+','+q(l.dy)+','+q(l.blur)+','+l.color).join(';')
      ].join('|'));
    }
    return parts.join('~');
  }

  // Human-readable preflight summary, for a dialog or the console.
  function formatValidation(v) {
    if(!v) return '';
    const L = [];
    L.push('Styles in use: ' + (v.styles.length
      ? v.styles.map(s2 => s2.name + ' (' + s2.layers + ' layer' + (s2.layers > 1 ? 's' : '') + ')').join(', ')
      : 'none'));
    v.errors.forEach(e => L.push('ERROR: ' + e));
    v.warnings.forEach(w => L.push('Warning: ' + w));
    v.notes.forEach(n => L.push('Note: ' + n));
    return L.join('\n');
  }

  // ═══════════════════════════════════════════
  // EXPORT PUBLIC API
  // ═══════════════════════════════════════════

  const CaptionEngine = {
    CaptionStyleSpec,
    AnimationEngine,
    TextLayoutEngine,
    VideoMetadata,
    StyleCollector,
    CaptionRenderer,
    // Shared typography primitives — the DOM preview imports these so it and the
    // export renderer resolve fonts identically (single source of truth).
    FONT_STYLE_MAP,
    fontShorthand,
    applyLetterSpacing,
    opticalCenterOffset,
    // The responsive canvas typography scale. The DOM preview MUST call this
    // rather than reimplement min(w/1080, h/1920), or preview and export drift
    // the moment one of them is tweaked.
    canvasTypeScale,
    CANVAS_REF_W,
    CANVAS_REF_H,
    EDGE_INSET_PCT,
    // ── Shared effect-layer model. The DOM preview formats these descriptors
    // into CSS; the canvas exporter casts them. One expansion, two formatters —
    // do NOT reimplement the falloff maths on either side.
    shadowLayers,
    glowLayers,
    effectLayers,
    layersToCSS,
    // ── THE single source of truth. Both backends must consume computeFrame()
    // and neither may recompute any value it returns.
    computeFrame,
    describeFrame,
    diffFrames,
    // ── DOM backend. The preview's counterpart to CaptionRenderer.drawFrame():
    // it writes the frame's numbers onto the caption DOM as CSS. Do NOT compute
    // any of these values in index.html — add them to computeFrame() instead.
    applyFrameToDOM,
    compareDOMToFrame,
    // ── Data-driven style registry. Declare a style here and BOTH the preview and
    // the exporter pick it up — there is no export-side switch on style id.
    registerStyle,
    getStyleDef,
    listStyles,
    resolveStyleProps,
    RENDER_CHANNELS,
    // ── Export preflight. Run before rendering frames.
    validateProject,
    formatValidation,
    // Exact pixel fingerprint — equal signatures mean equal pixels, so the
    // exporter can reuse an already-encoded frame instead of re-encoding.
    frameSignature,
    version: '1.1.0'
  };
  
  // Populate the style registry NOW, at module load, so listStyles(),
  // validateProject() and any UI that enumerates styles work without first
  // constructing a renderer. (Registration is idempotent.)
  try { new AnimationEngine(); } catch(err) {
    console.error('[CaptionEngine] built-in style registration failed:', err);
  }

  // Attach to global
  global.CaptionEngine = CaptionEngine;
  
  // Also expose individual classes
  global.CaptionStyleSpec = CaptionStyleSpec;
  global.AnimationEngine = AnimationEngine;
  global.TextLayoutEngine = TextLayoutEngine;
  global.VideoMetadata = VideoMetadata;
  global.StyleCollector = StyleCollector;
  global.CaptionRenderer = CaptionRenderer;

  console.log('[CaptionEngine] v1.0.0 loaded ✓');
  
})(typeof window !== 'undefined' ? window : this);
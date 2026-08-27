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
    
    // Get scaled font size for a target canvas
    getScaledFontSize(targetHeight) {
      const scale = targetHeight / this.canvasHeight;
      return Math.max(4, Math.round(this.fontSize * scale));
    }
    
    // Get scaled stroke width for a target canvas
    getScaledStrokeWidth(targetHeight) {
      const scale = targetHeight / this.canvasHeight;
      return this.strokeWidth * scale;
    }
    
    // Get scaled letter spacing
    getScaledLetterSpacing(targetHeight) {
      const scale = targetHeight / this.canvasHeight;
      return this.letterSpacing * scale;
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
  // 2. ANIMATION ENGINE
  // Frame-accurate animation calculations
  // ═══════════════════════════════════════════
  
  class AnimationEngine {
    constructor() {
      this.styles = {
        0: this.styleNone.bind(this),
        1: this.styleBackgroundBar.bind(this),
        2: this.stylePopBounce.bind(this),
        3: this.styleOpacityCascade.bind(this),
        4: this.styleSlideStack.bind(this),
        5: this.styleKaraokeLine.bind(this),
        6: this.styleAppleReveal.bind(this),
        7: this.styleBorderPopUp.bind(this),
        8: this.styleProTypographic.bind(this)
      };
    }
    
    // Calculate animation state for a specific time
    // Returns: { words: [{ opacity, scale, x, y, color, bgColor, highlighted }] }
    calculate(spec, group, currentTime) {
      const styleFunc = this.styles[spec.animationStyle] || this.styles[0];
      return styleFunc(spec, group, currentTime);
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
    measureWord(word, spec, targetHeight, sizeMul) {
      // sizeMul lets one word (e.g. the Opacity Cascade active word) be measured
      // at a larger size so the line reserves the right width for it.
      const fontSize = spec.getScaledFontSize(targetHeight) * (sizeMul || 1);
      // Measure with EXACTLY what we draw with:
      //  • the full family list (was: first family only → different fallback,
      //    so metrics diverged from the drawn glyphs)
      //  • the same letter-spacing (was: omitted → every word measured narrower
      //    than it renders, shifting positions and changing line wrapping)
      this.ctx.font = fontShorthand(spec, fontSize);
      applyLetterSpacing(this.ctx, spec, targetHeight / (spec.canvasHeight || targetHeight));
      return this.ctx.measureText(this.applyCase(word, spec.textTransform)).width;
    }
    
    // Layout entire caption group — returns positions for each word
    layoutGroup(group, spec, targetWidth, targetHeight, sizeMulFn) {
      const fontSize = spec.getScaledFontSize(targetHeight);
      const letterSp = spec.getScaledLetterSpacing(targetHeight);
      const wordGap  = spec.wordSpacing === 0
        ? fontSize * 0.27
        : Math.max(0, (fontSize * 0.27) + (spec.wordSpacing * targetHeight / spec.canvasHeight));
      
      const pos = spec.getPixelPosition(targetWidth, targetHeight);
      const maxLineWidth = (spec.maxWidth / 100) * targetWidth;
      
      const wordData = group.words.map((word, wi) => {
        const mul = sizeMulFn ? (sizeMulFn(wi) || 1) : 1;
        return {
          text: this.applyCase(word, spec.textTransform),
          width: this.measureWord(word, spec, targetHeight, mul),
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
      
      // Shadows
      const shadowsArr = typeof shadows !== 'undefined' && Array.isArray(shadows) ? shadows : [];
      
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
    _rgba(hex, alpha) {
      if(typeof hex !== 'string') return hex;
      let c = hex.replace('#', '');
      if(c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
      const r = parseInt(c.substring(0,2),16) || 0;
      const g = parseInt(c.substring(2,4),16) || 0;
      const b = parseInt(c.substring(4,6),16) || 0;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha == null ? 1 : alpha) + ')';
    }

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

    // Draw one caption group at time t. Caller sets up ctx; does NOT clear.
    renderFrame(ctx, spec, group, t, W, H) {
      if(!group || !group.words || !group.words.length) return;

      const state  = this.anim.calculate(spec, group, t);
      // Layout ALWAYS uses the base font size, so word positions are identical
      // whichever word is active. An enlarged active word is a transform on top of
      // this stable layout — it never re-flows the line.
      const layout = this.layout.layoutGroup(group, spec, W, H);
      const fontPx = layout.fontSize;
      const scale  = H / (spec.canvasHeight || H);
      const containerOpacity = (state.containerOpacity == null ? 1 : state.containerOpacity);
      if(containerOpacity <= 0) return;

      ctx.save();
      ctx.globalAlpha = 1;

      // ── AUTO-FIT: scale the whole caption down (around its center) if its
      // widest line would exceed the max-width box, so long words / huge fonts
      // never overflow the frame. Mirrors the preview's auto-fit. ──
      const availW = W * (Math.min(spec.maxWidth || 85, 100) / 100);
      if(layout.totalWidth > availW && layout.totalWidth > 0) {
        const fit = availW / layout.totalWidth;
        ctx.translate(layout.centerX, layout.centerY);
        ctx.scale(fit, fit);
        ctx.translate(-layout.centerX, -layout.centerY);
      }

      // ── Container background box (spec §caption background) ──
      if(state.containerBg || (spec.bgEnabled && spec.bgOpacity > 0)) {
        const bg = state.containerBg || {
          color: spec.bgColor, opacity: spec.bgOpacity / 100,
          padH: spec.bgPadH, padV: spec.bgPadV, radius: spec.bgRadius
        };
        const padH = (bg.padH || 0) * scale, padV = (bg.padV || 0) * scale;
        const x0 = layout.centerX - layout.totalWidth/2 - padH;
        const y0 = layout.centerY - layout.totalHeight/2 - padV;
        ctx.save();
        ctx.globalAlpha = containerOpacity * (bg.opacity == null ? 1 : bg.opacity);
        ctx.fillStyle = bg.color || '#000';
        this._roundRectPath(ctx, x0, y0, layout.totalWidth + padH*2, layout.totalHeight + padV*2, (bg.radius||0)*scale);
        ctx.fill();
        ctx.restore();
      }

      // ── Per-word draw ──
      const words = state.words || [];
      // Letter-block metrics so highlight bars hug the LETTERS (equal padding above
      // the cap tops and below the baseline) instead of the em box, whose empty
      // descender zone made bars look bottom-heavy on words like "would".
      const lmBase = letterMetrics(spec, fontPx);
      // Paint order: every inactive word first, then the ACTIVE one last so it sits
      // ON TOP. Canvas has no z-index — later draws win — so without this the next
      // word overlapped an enlarged active word. Stable: relative order is kept
      // within each group, so nothing else about the layout changes.
      const drawOrder = layout.words.map((_, i) => i)
        .sort((a, b) => ((words[a] && words[a].highlighted) ? 1 : 0) -
                        ((words[b] && words[b].highlighted) ? 1 : 0));

      drawOrder.forEach((i) => {
        const pw = layout.words[i];
        const ws = words[i] || {};
        if(!pw || ws.visible === false) return;
        const wordOpacity = (ws.opacity == null ? 1 : ws.opacity);
        if(wordOpacity <= 0) return;
        const wScale = (ws.scale == null ? 1 : ws.scale);

        // This word's own draw size + letter metrics (may differ from the line's
        // base size when a style enlarges the active word).
        const wSize = pw.size || fontPx;
        const lm      = (wSize === fontPx) ? lmBase : letterMetrics(spec, wSize);
        const ocY     = lm.centerY;
        const letterH = lm.letterH;

        // BASELINE ALIGNMENT: keep every word sitting on the same baseline, so a
        // bigger active word grows UPWARD instead of shifting the line. The line's
        // baseline is where a base-size word's baseline falls.
        const baselineY = pw.y + lmBase.baseline;
        const originY   = baselineY - lm.baseline;

        ctx.save();
        ctx.globalAlpha = containerOpacity * wordOpacity;
        ctx.translate(pw.x + (ws.x||0)*scale, originY + (ws.y||0)*scale);
        // Anchor extra scale at the BOTTOM (baseline) so it also grows upward
        if(wScale !== 1) {
          if(ws.anchorBottom) {
            ctx.translate(0, lm.baseline);
            ctx.scale(wScale, wScale);
            ctx.translate(0, -lm.baseline);
          } else {
            ctx.scale(wScale, wScale);
          }
        }

        // Border/Pop-up bar behind the word (Style 7 — s7-word-bar). Uses the
        // bar's own padding/radius/color from the animation state.
        if(ws.wordBar) {
          const padH = (ws.wordBar.padH || 0) * scale;
          const padV = (ws.wordBar.padV || 0) * scale;
          const bw = pw.width + padH*2;
          const bh = letterH + padV*2;   // hug the letters, not the em box
          const barScale = (ws.wordBar.scale == null ? 1 : ws.wordBar.scale);
          ctx.save();
          // The bar animates INDEPENDENTLY of the word (matches the DOM, where
          // .s7-word-bar is a child with its own keyframes and centre origin).
          if(barScale !== 1) ctx.scale(barScale, barScale);
          ctx.fillStyle = ws.wordBar.color;
          // Centre on the LETTERS, not the em box (see _opticalCenterY)
          this._roundRectPath(ctx, -bw/2, ocY - bh/2, bw, bh, (ws.wordBar.radius||0)*scale);
          ctx.fill();
          ctx.restore();
        }

        // Highlight pill behind the word (styles 1/2 highlight)
        if(ws.bgColor) {
          const padH = (spec.highlightPadH || 0) * scale;
          const padV = (spec.highlightPadV || 0) * scale;
          const bw = pw.width + padH*2;
          const bh = fontPx + padV*2;    // em-box pill — matches the DOM (background + box-shadow)
          ctx.fillStyle = ws.bgColor;
          this._roundRectPath(ctx, -bw/2, -bh/2, bw, bh, (spec.highlightRadius||0)*scale);
          ctx.fill();
        }

        // Word glyph (into offscreen), then shadows/glow, then crisp composite
        const fillColor = ws.color || spec.color || '#fff';
        const glyph = this._renderWordGlyph(pw.text, spec, fillColor, wSize, scale);
        const gx = -glyph.w/2, gy = -glyph.h/2;

        // Multi-layer drop shadows (spec.shadows: [{dist,angle,size,opacity,color}])
        const shadows = Array.isArray(spec.shadows) ? spec.shadows : [];
        shadows.forEach(sh => {
          if(!sh) return;
          const ang = (sh.angle || 0) * Math.PI / 180;
          const dist = (sh.dist || 0) * scale;
          this._castShadow(ctx, glyph.canvas, gx, gy,
            Math.cos(ang) * dist, Math.sin(ang) * dist,
            (sh.size || 0) * scale, this._rgba(sh.color || '#000', sh.opacity == null ? 1 : sh.opacity));
        });

        // Glow (spec §glow) or per-word glow from the animation state
        const glow = ws.glow || (spec.glowEnabled ? { color: spec.glowColor, size: spec.glowIntensity } : null);
        if(glow && glow.size > 0) {
          this._castShadow(ctx, glyph.canvas, gx, gy, 0, 0, glow.size * scale, glow.color || '#fff');
          this._castShadow(ctx, glyph.canvas, gx, gy, 0, 0, glow.size * scale, glow.color || '#fff'); // 2× for intensity
        }

        // Crisp word on top
        ctx.drawImage(glyph.canvas, gx, gy);
        ctx.restore();
      });

      ctx.restore();
    }

    // Convenience: pick the active group at time t and draw it. Clears the target.
    renderComposite(ctx, spec, groups, t, W, H, clear) {
      if(clear !== false) ctx.clearRect(0, 0, W, H);
      if(!groups || !groups.length) return;
      let active = null;
      for(let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if(t >= g.start && t < g.end) { active = g; break; }
      }
      if(active) this.renderFrame(ctx, spec, active, t, W, H);
    }
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
    version: '1.1.0'
  };
  
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
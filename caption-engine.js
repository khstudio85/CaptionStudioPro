// ═══════════════════════════════════════════════════════════════════
// CAPTION STUDIO PRO — RENDERING ENGINE v1.0
// Single source of truth for all caption rendering
// USED BY: Preview + Export (guarantee identical output)
// ═══════════════════════════════════════════════════════════════════

(function(global) {
  'use strict';
  
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
      
      return {
        words: group.words.map((_, i) => {
          const isActive = i === activeIdx;
          const isSpoken = i < activeIdx;
          return {
            opacity: isActive ? activeOp : (isSpoken ? spokenOp : dimOp),
            scale: isActive ? activeScale : 1,
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
      const bounceScale = (props.bounceScale || 118) / 100;
      const padH = props.padH || 8;
      const padV = props.padV || 5;
      const radius = props.barRadius || 7;
      const bgOp = (props.bgOpacity || 88) / 100;
      
      return {
        words: group.words.map((_, i) => {
          const isActive = i === activeIdx && spec.highlightEnabled;
          let scale = 1;
          let barVisible = false;
          
          if(isActive) {
            const wt = group.wordTimes[i];
            const wordDur = wt.end - wt.start;
            const localTime = currentTime - wt.start;
            const peakTime = wordDur * 0.35;
            
            if(localTime < peakTime) {
              const t = localTime / peakTime;
              scale = 1 + (bounceScale - 1) * this.easeOutBack(t);
            } else {
              const t = (localTime - peakTime) / (wordDur - peakTime);
              scale = bounceScale - (bounceScale - 1) * this.easeInOut(t);
            }
            barVisible = true;
          }
          
          return {
            opacity: 1,
            scale,
            x: 0, y: 0,
            color: isActive ? spec.highlightTextColor : spec.color,
            bgColor: null,
            highlighted: isActive,
            wordBar: barVisible ? {
              color: this.hexAlpha(spec.highlightBgColor, bgOp),
              radius,
              padH,
              padV
            } : null
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
    measureWord(word, spec, targetHeight) {
      const fontSize = spec.getScaledFontSize(targetHeight);
      const fontFamily = spec.fontFamily.replace(/['"]/g, '').split(',')[0].trim();
      const fontWeight = spec.fontWeight;
      const fontStyle = spec.fontStyle;
      
      this.ctx.font = fontStyle + ' ' + fontWeight + ' ' + fontSize + 'px "' + fontFamily + '"';
      return this.ctx.measureText(this.applyCase(word, spec.textTransform)).width;
    }
    
    // Layout entire caption group — returns positions for each word
    layoutGroup(group, spec, targetWidth, targetHeight) {
      const fontSize = spec.getScaledFontSize(targetHeight);
      const letterSp = spec.getScaledLetterSpacing(targetHeight);
      const wordGap  = spec.wordSpacing === 0
        ? fontSize * 0.27
        : Math.max(0, (fontSize * 0.27) + (spec.wordSpacing * targetHeight / spec.canvasHeight));
      
      const pos = spec.getPixelPosition(targetWidth, targetHeight);
      const maxLineWidth = (spec.maxWidth / 100) * targetWidth;
      
      // Measure all words
      const wordData = group.words.map(word => ({
        text: this.applyCase(word, spec.textTransform),
        width: this.measureWord(word, spec, targetHeight)
      }));
      
      // Build lines respecting maxWidth and line breaks
      const lines = [];
      let currentLine = [];
      let currentWidth = 0;
      
      wordData.forEach((word, i) => {
        const wordWidthWithGap = word.width + (currentLine.length > 0 ? wordGap : 0);
        
        // Manual line break
        if(spec.lineBreakEnabled && i === spec.lineBreakAt) {
          if(currentLine.length > 0) lines.push(currentLine);
          currentLine = [word];
          currentWidth = word.width;
          return;
        }
        
        // Auto wrap
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
      const fsMap = {
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
        'extrabold':  { weight: 800, style: 'normal' }
      };
      const fs = fsMap[fontStyleValue] || fsMap.regular;
      
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
        wordSpacing:    gn('wordGap', 0),
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
  // EXPORT PUBLIC API
  // ═══════════════════════════════════════════
  
  const CaptionEngine = {
    CaptionStyleSpec,
    AnimationEngine,
    TextLayoutEngine,
    VideoMetadata,
    StyleCollector,
    version: '1.0.0'
  };
  
  // Attach to global
  global.CaptionEngine = CaptionEngine;
  
  // Also expose individual classes
  global.CaptionStyleSpec = CaptionStyleSpec;
  global.AnimationEngine = AnimationEngine;
  global.TextLayoutEngine = TextLayoutEngine;
  global.VideoMetadata = VideoMetadata;
  global.StyleCollector = StyleCollector;
  
  console.log('[CaptionEngine] v1.0.0 loaded ✓');
  
})(typeof window !== 'undefined' ? window : this);
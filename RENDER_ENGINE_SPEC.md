# Caption Studio Pro — Unified Rendering Engine Specification & Implementation Plan

**Status:** Draft v1 · **Owner:** TBD · **Target app:** Electron + native FFmpeg
(decided) · **Delivery:** Phased, export-first, core-engine-first (decided)

This document is the single reference for upgrading Caption Studio Pro from a
caption editor with screenshot-based export into a CapCut-style **caption-to-video
rendering system** where the editor preview and the exported video are produced by
**one rendering engine**.

Companion docs: [`CLAUDE.md`](CLAUDE.md) (repo guidance), [`FILE_CONTEXT.md`](FILE_CONTEXT.md) (code map).

---

## 1. Goal & guiding principle

After captions are generated and styled, the **exact** captions — fonts, sizes,
colors, positions, animations, effects, timing, styling — visible in the editor must
be rendered directly onto the original video and exported as a high-quality MP4, with
**no visual difference between preview and export**.

> **The one rule:** `Caption Data → ONE rendering specification → Preview + Export`.
> There must never be a state where preview shows one style and export produces another.

**Non-negotiables**
- One renderer feeds both preview and export (no separate simplified export renderer).
- No screenshot/HTML-recording export.
- Frame-accurate, deterministic rendering (same timestamp → same pixels).
- Original resolution / FPS / aspect / audio timing preserved by default.
- Do not break existing caption generation, timeline, or styling UI.

---

## 2. Current state (as-built findings)

| Area | Current implementation | Verdict |
|---|---|---|
| Style spec | `caption-engine.js`: `CaptionStyleSpec`, `AnimationEngine`, `TextLayoutEngine`, `StyleCollector` exist | ✅ Good abstraction — **but not used to render** |
| Live preview | Inline DOM/CSS word-chips + runtime `@keyframes`; `STYLE 0..8` blocks in `index.html` (~10005–10639) | ⚠️ Separate from the engine |
| Export | `renderCaptionFrames()` ([index.html:18343](index.html:18343)) resizes preview DOM to target size, steps frames via `audio.currentTime`, captures each with `htmlToImage.toPng(previewWrap)` | ❌ Screenshot-based (rejected); see below |
| Encode/composite | `main.js` `export-frames-mode` overlays PNG sequence on scaled video via FFmpeg (NVENC/libx264) | ✅ Keep — solid native encoder |
| Quality preservation | Export res/fps come from a `projects` **preset** (default `1920x1080@30`), not the source video | ❌ Silent downscale (violates §9) |
| Memory | All frames held as base64 PNGs in a JS array, sent in one IPC call | ❌ Multi-GB for long/4K clips → crash |
| Metadata | `VideoMetadata.detect()` in engine (client-side, approximate FPS) | ⚠️ No ffprobe ground truth |

**Core defects to fix:** (1) export ≠ real engine (it's a DOM screenshot), (2) no
original-quality preservation, (3) unbounded memory.

**Existing assets to reuse (do not rewrite):** transcription (AssemblyAI / OpenAI
Whisper), Smart Sync grouping, timeline, styling panels, `main.js` FFmpeg overlay
command, the `CaptionStyleSpec` / `AnimationEngine` / `TextLayoutEngine` classes.

---

## 3. Target architecture

```
Video Input
   ↓  probe (ffprobe)
Video Metadata ──────────────┐
   ↓                         │ defaults (res/fps/codec)
Caption Data (masterWords → wordGroups, per-word timing)
   ↓
CaptionStyleSpec  ← StyleCollector.fromUI()   (single source of truth)
   ↓
AnimationEngine  +  TextLayoutEngine
   ↓
┌───────────────── CaptionRenderer.renderFrame(ctx, spec, group, t, W, H) ─────────────────┐
│  ONE canvas draw routine — resolution-independent                                        │
└──────────────┬───────────────────────────────────────────────┬──────────────────────────┘
               │ preview (Phase 2)                               │ export (Phase 1)
        Preview canvas (e.g. 960×540)                    Offscreen canvas @ export W×H
               │                                                 │ transparent PNG per frame (streamed)
        Live editor overlay                              main.js FFmpeg: overlay PNGs on original video
                                                                 ↓
                                                     Encode (NVENC/libx264) + mux original audio → MP4
```

**Key idea:** the same `CaptionRenderer.renderFrame()` is called for preview and
export; only the target canvas size differs. Font size and geometry scale from a
reference composition size via `scaleFactor = targetHeight / spec.canvasHeight`
(§14/§15), so a caption is visually identical at 540p preview and 2160p export.

---

## 4. Data model

### 4.1 CaptionStyleSpec (exists — extend as needed)
Authoritative style object (see `caption-engine.js`). Covers typography, color,
gradient, stroke, multi-shadow array, glow, per-word highlight, caption background,
**normalized** position (`positionX/Y` %, `maxWidth` %), animation + params, line
break, words-per-group, and canvas reference for scaling.

### 4.2 Caption / word timing (align to prompt §3)
```js
{
  id, startTime, endTime,
  text,
  words: [ { text, startTime, endTime, style? } ],  // per-word timing (word-level anim)
  style: CaptionStyleSpec                            // caption-level style (+ optional word overrides)
}
```
Current app uses `wordGroups[]` with `words[]` + `wordTimes[]`. Phase 1 adapts the
renderer to the existing shape; a thin normalizer maps `wordGroups` → the model above
so we don't churn the whole app.

### 4.3 Positioning
Always normalized (0–100%). Never store raw pixels. Ensures identical relative
placement across resolutions (1080p ↔ 4K).

---

## 5. Rendering engine spec (`CaptionRenderer`)

New class in `caption-engine.js`. Pure, deterministic, no DOM screenshotting.

**Signature**
```js
class CaptionRenderer {
  constructor(opts)                         // font-ready checks, caches
  renderFrame(ctx, spec, group, t, W, H)    // draw one caption group at time t
  renderComposite(ctx, spec, groups, t, W, H) // pick active group(s), draw
}
```

**Per-frame algorithm (deterministic — prompt §11)**
1. Determine active caption group(s) at `t`.
2. `AnimationEngine.calculate(spec, group, t)` → per-word `{opacity, scale, x, y, color, bgColor, highlighted, glow, wordBar}`.
3. `TextLayoutEngine.layoutGroup(group, spec, W, H)` → per-word boxes (wrap, line breaks, alignment, letter/line spacing, maxWidth).
4. Draw order per word: caption background box → shadow layers → glow → stroke → fill (solid/gradient) → highlight background + highlighted text.
5. Apply transform (scale/translate/rotation/opacity/blur) from animation state around the correct transform origin.

**Animation parameters supported** (prompt §4): duration, delay, easing, scale,
rotation, opacity, X/Y movement, blur, color change. Backed by the existing
`AnimationEngine` easing helpers.

**Styles:** implement all 9 (0 None, 1 Background Bar, 2 Pop Bounce, 3 Opacity
Cascade, 4 Slide Stack, 5 Karaoke Line, 6 Apple Reveal, 7 Border Pop Up, 8 Pro
Typographic). Styles 4/6/8 are currently "simplified" in the engine and must be
completed to match the inline DOM versions.

**Fonts (prompt §6):** before rendering/export, confirm the selected font is loaded
via `document.fonts.check` / `document.fonts.load`. If it cannot load, **fail with a
visible error** — never silently substitute a fallback.

---

## 6. Quality preservation & export settings

### 6.1 Metadata probe (`main.js` new IPC `probe-video`)
`ffmpeg.ffprobe` → `{ width, height, fps, duration, vCodec, aCodec, bitrate,
pixFmt, sampleAspect/displayAspect, sampleRate, channels }`. Stored on load.

### 6.2 Export dialog defaults (prompt §13)
- **Resolution:** Original (default), 2160p, 1440p, 1080p, 720p.
- **FPS:** Original (default), 24, 25, 30, 50, 60.
- **Format:** MP4 (MOV if supported).
- **Codec:** H.264 (default), H.265/HEVC if supported.
- **Quality:** High / Very High / custom bitrate / CRF.
- **Default = Original res + Original FPS + high-quality encode.** No auto 4K→1080p,
  no auto 60→30, no stretch/distort. Aspect and duration preserved.

### 6.3 Audio (prompt §12)
Preserve original audio timing, duration, channels, sample rate; no drift. Document
behavior when multiple audio streams exist (default: first stream, configurable).

---

## 7. Memory-safe export pipeline (prompt §18/§20)

Replace "array of all base64 PNGs in one IPC" with streaming:
- `export-init` → main creates a temp frame dir, returns handle.
- Renderer loops frames on an **OffscreenCanvas** at export size, calls
  `CaptionRenderer`, encodes one PNG, sends via `export-add-frame` (main writes to
  disk and frees it). Memory bounded to a few frames.
- `export-encode` → reuse the existing FFmpeg PNG-sequence overlay command reading
  from the dir; mux original audio; apply probed defaults + user overrides.
- Progress phases surfaced to UI: Preparing → Loading fonts → Preparing captions →
  Rendering frames → Encoding → Muxing → Finalizing → Complete, with %/ETA/current
  frame and **Cancel** (reuse `cancel-export`).

Future optimization (optional): pipe raw RGBA frames to FFmpeg stdin to skip PNG
encode; consider a WebWorker for frame rendering.

---

## 8. Phased delivery plan

### Phase 1 — Core engine + quality + memory (export-first)
**Outcome:** export runs through the real `CaptionRenderer`, preserves original
res/fps, and no longer blows up memory. Editor untouched.

1. `caption-engine.js`: add `CaptionRenderer`; complete styles 4/6/8; font-ready guard.
2. `main.js`: `probe-video`; streaming `export-init` / `export-add-frame` /
   `export-encode` (dir-based); wire encode defaults to probed metadata.
3. `preload.js`: expose new IPC.
4. `index.html`: rewrite `renderCaptionFrames()` to draw via `CaptionRenderer` on an
   OffscreenCanvas and stream frames; export dialog defaults from probed metadata.
5. Parity harness: render sample timestamps via canvas vs DOM preview; visual diff.

**Exit criteria:** a 1080p and a 4K/60 clip each export at original res/fps with
captions matching the DOM preview at spot-checked timestamps; memory stays bounded.

### Phase 2 — Preview on the same engine (true single source of truth)
**Outcome:** live preview renders through `CaptionRenderer` on a canvas overlay, so
preview == export by construction.

1. Add a preview canvas layer in `previewWrap`; drive it from the render loop
   (`onTimeUpdate`) via `CaptionRenderer` at preview size.
2. Keep the DOM interaction layer (drag-to-position handle, badges) on top of the
   canvas; port per-word drag/hit-testing.
3. Retire the inline `STYLE 0..8` DOM/CSS render paths once parity is confirmed
   (keep behind a flag during transition).
4. Verify all 9 styles + word-level highlight/karaoke match export exactly.

**Exit criteria:** toggling any style/param updates preview and export identically;
the §22 acceptance style renders pixel-consistent in both.

### Phase 3 — Pro polish
1. **Render queue / jobs** (§18): job model, progress phases, ETA, cancel, no UI freeze.
2. **Presets CRUD** (§17): save / apply / duplicate / edit / delete; persist
   (extends existing `_BUILTIN_PRESETS`).
3. **Export dialog** full options (§13) if not finished in Phase 1.
4. **Automated tests** (§25): see below.
5. Performance passes: caching, avoid redundant re-render, font-load once, chunking.

---

## 9. Testing & acceptance

### 9.1 Automated tests (Phase 3, prompt §25)
- **Video matrix:** 720p/1080p/1440p/4K × 24/30/60 fps × 16:9 / 9:16 / 1:1.
- **Caption matrix:** short / long / multi-line / special chars / multiple fonts &
  weights / word highlight / animated.
- **Export assertions:**
  - `input.resolution == output.resolution` (default)
  - `input.fps == output.fps` (default)
  - `input.duration ≈ output.duration`
  - audio synchronized, no drift
  - caption timing, position, font, animation timing correct
- Determinism: same timestamp → identical rendered frame (hash compare).

### 9.2 Primary acceptance test (prompt §22)
Editor set to **Poppins Bold / 72px / white / black stroke / yellow word highlight /
pop animation / center / 0.25s** must appear **exactly** the same in the exported MP4.

### 9.3 Final success criteria (prompt §26)
Upload → generate → edit → font/size/color/stroke/shadow/bg → position → animation →
word highlight → real-time preview → export → high-quality MP4 with captions rendered
exactly as in the editor, original res/fps preserved, audio and all timing accurate.

---

## 10. File-level change map

| File | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| `caption-engine.js` | add `CaptionRenderer`, finish styles 4/6/8, font guard | preview loop helpers | preset model |
| `main.js` | `probe-video`, streaming export IPC, defaults from metadata | — | queue-aware progress, codec options |
| `preload.js` | expose new IPC | — | — |
| `index.html` | rewrite `renderCaptionFrames`, export defaults | preview canvas layer, retire inline STYLE blocks | render queue UI, preset CRUD UI, export dialog |
| (new) `tests/` | — | — | automated test harness |

---

## 11. Risks & mitigations

- **Preview/export divergence during Phase 1** (canvas export vs DOM preview): build
  the renderer to match DOM output; verify with the parity harness; Phase 2 removes
  the divergence permanently.
- **Regressing the working editor in Phase 2** (drag, per-word chips, 9 animations):
  gate the canvas preview behind a flag; port interaction carefully; keep DOM path
  until parity confirmed.
- **Font loading races**: block export until `document.fonts.ready` + explicit
  `load()` of the selected family/weight; hard error on failure.
- **Large/long videos**: streaming frames to disk + bounded memory; chunked
  progress; cancellation.
- **HEVC/MOV support variance**: feature-detect encoder support in `main.js`; expose
  only supported options.

---

## 12. Open decisions (to confirm as we go)
- Default behavior for multi-stream audio (proposed: first stream, configurable).
- Whether to add raw-RGBA-to-stdin piping in Phase 1 or defer to Phase 3 perf pass
  (proposed: defer; PNG-to-disk streaming first for robustness).
- Test runner choice for Phase 3 (headless Electron vs node harness invoking FFmpeg).

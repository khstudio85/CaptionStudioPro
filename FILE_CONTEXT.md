# Caption Studio Pro — File Context Document

A map of the codebase: what each file does, how they connect, and where to find things.
Companion to `CLAUDE.md`. Line numbers are approximate — the code has no build step, so
grep the `═══` banner comments to navigate.

---

## 1. High-level picture

Caption Studio Pro is an **Electron desktop app** for creating stylized, animated video
captions and burning them into an MP4. It is a classic thin-main / fat-renderer Electron
app:

```
┌─────────────────────────────────────────────────────────────────┐
│  RENDERER  (index.html + caption-engine.js)                       │
│  • Full UI (timeline, preview, styling panels)                    │
│  • Transcription (calls AssemblyAI / OpenAI Whisper directly)     │
│  • Word grouping, animation, live preview                         │
│  • Renders each export frame to canvas → transparent PNG          │
└───────────────┬───────────────────────────────────────────────────┘
                │  window.electronAPI  (preload.js bridge)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  MAIN  (main.js)                                                   │
│  • BrowserWindow, CSP, GPU flags                                   │
│  • FFmpeg: composite PNG frames/overlay onto video → MP4          │
│  • Audio extraction, save dialog, show-in-folder                   │
└─────────────────────────────────────────────────────────────────┘
```

There is **no backend, no database, no build tooling, no tests.** Media files stay local.
API keys for transcription are stored in `localStorage` and used from the renderer.

**Tech stack:** Electron ^33, FFmpeg (`fluent-ffmpeg` + `ffmpeg-static`),
`html-to-image` (DOM→PNG capture for export), Google Fonts (loaded via CDN link).

---

## 2. File-by-file

### `package.json` (551 B)
Project manifest. `main` = `main.js`. Scripts: `start` (`electron .`), `dev`
(`electron . --dev`), `postinstall` (rebuild native deps). Deps: `ffmpeg-static`,
`fluent-ffmpeg`, `html-to-image`. Dev dep: `electron ^33`. No test/lint/build scripts.

### `main.js` (~470 lines) — Electron main process
The **only** file that touches FFmpeg and the OS. Structure:

- **Window + flags (1–58):** `createWindow()`. Big-memory V8 flag (8 GB), HEVC decode,
  GPU rasterization. Sets a very permissive CSP via `onHeadersReceived`. `webSecurity:false`,
  `contextIsolation:true`, `nodeIntegration:false`. Loads `index.html`, opens DevTools.
- **IPC handlers (64+):**
  - `get-file-url`, `get-file-info` — path → `file:///` URL, stat.
  - `extract-audio-region` — FFmpeg extracts a mono 16 kHz WAV region (used to send
    audio-only to transcription APIs). Returns a Buffer.
  - `cancel-export` — SIGKILLs the running FFmpeg command (`currentExportCommand`).
  - **`export-with-overlay` (129):** simplest export. Scales video + overlays ONE
    transparent PNG (`overlay=0:0`) for the whole clip. Static captions.
  - **`export-frames-mode` (258):** the real CapCut-style export. Renderer sends an array
    of base64 PNG frames; main writes them to a temp dir as `frame_%06d.png`, then runs a
    single FFmpeg command that scales the source video and overlays the PNG sequence
    (`overlay=0:0:shortest=1`), muxing original audio. Reports progress via
    `export-progress` events. Cleans up temp frames on end/error.
  - `save-file-dialog`, `show-in-folder`.
- **Codec logic:** GPU path = `h264_nvenc` (presets p2/p4/p6, `-cq`), CPU path =
  `libx264` (crf). Chosen by the `useGPU` flag + `quality` (`high`/`medium`/`low`).

### `preload.js` (~36 lines) — context bridge
Exposes `window.electronAPI` with: `isElectron`, `platform`, `getFileURL`,
`getFileInfo`, `getFilePath` (via `webUtils.getPathForFile`), `extractAudioRegion`,
`exportFramesMode`, `exportWithOverlay`, `cancelExport`, `saveFileDialog`,
`showInFolder`, and `onExportProgress(cb)` (subscribes to the `export-progress` channel).
This is the entire renderer↔main API surface.

### `caption-engine.js` (~828 lines) — shared rendering spec (`window.CaptionEngine`)
An IIFE that defines the intended **single source of truth** for caption rendering so
preview and export match. Five classes:

1. **`CaptionStyleSpec` (15):** every render-affecting property — typography, color,
   gradient, stroke, multi-shadow array, glow, per-word highlight, caption background,
   normalized position (`positionX/Y` %, `maxWidth` %), animation style + props, line
   break, words-per-group, canvas reference. Has `clone()`, `toJSON()`, and scaling
   helpers (`getScaledFontSize`, `getPixelPosition`, etc.) that map canvas-space values
   onto a target export resolution.
2. **`AnimationEngine` (137):** maps `animationStyle` 0–8 to functions returning per-word
   render state `{opacity, scale, x, y, color, bgColor, highlighted}` at a given time.
   Styles: 0 None, 1 Background Bar, 2 Pop Bounce, 3 Opacity Cascade, 4 Slide Stack,
   5 Karaoke Line, 6 Apple Reveal, 7 Border Pop Up, 8 Pro Typographic. Includes easing
   helpers and `getActiveWordIndex()`.
3. **`TextLayoutEngine` (467):** offscreen-canvas text measurement, case transforms
   (RTL-aware), line wrapping to `maxWidth`, and per-word positioning — returns laid-out
   word boxes for a target resolution.
4. **`VideoMetadata` (595):** `detect()` — loads a video element to read
   width/height/duration/aspect and estimates FPS via `requestVideoFrameCallback`,
   snapping to common rates (24/25/30/50/60).
5. **`StyleCollector` (677):** `fromUI()` — reads all the DOM inputs + inline globals and
   builds a `CaptionStyleSpec`. The bridge between the UI and the spec.

> ⚠️ **Parity caveat:** despite this engine, much of the live preview/animation is ALSO
> reimplemented inline inside `index.html` (the `STYLE 0..8` blocks). Treat the two as
> partially-overlapping, not fully unified. See §4.

### `index.html` (~25,500 lines) — the entire app
`<head>` loads Google Fonts, then **CSS lines 8–5337**, **HTML body 5338–~7512**, then
**inline JS ~7516–25533** (plus `caption-engine.js` and `html-to-image` loaded at 7513–14).
Detailed map in §3.

### `node_modules/`, `package-lock.json`
Dependencies. `html-to-image` is loaded directly from `node_modules` via a `<script>` tag.

---

## 3. Inside `index.html`

Navigate by grepping the `═══` / `───` banner comments. Major regions:

### CSS (8–5337)
Dark-theme design system. Notable: word-chip animation styles keyed by `data-animstyle`
(115+), runtime-injected `@keyframes` for per-word animation, timeline/clip/playhead
styling, razor & snap tools, selection marquee, caption panel, text/animation tabs,
position pad, waveform, text-presets panel.

### Body / UI markup (~5338–7512)
- **Left panel** (`#leftPanel`, 5430) — project/media import, audio zone.
- **Center** — `#previewArea` / `#previewWrap` (video + live caption overlay), and the
  **timeline** (`#timelineScroll` / `#timelineInner`, 5630) with clips, tracks, playhead.
- **Right panel** (`#rightPanel`, 5886) — the styling workspace, 3 tabs via `ccSwitch()`:
  - **Captions** (`#ccpane-captions`) — search + search/replace, caption list.
  - **Text** (`#ccpane-text`) — presets, font, color/gradient, stroke, shadow, glow,
    highlight, background, position pad.
  - **Animation** (`#ccpane-animation`) — 9 style cards + per-style property controls.
- **Modals** (~7391+) — canvas/format, transcript input (`#transcriptInput`), auto-caption
  (AssemblyAI/OpenAI keys), export UI.

### Inline JS (~7516–25533) — key sections & entry points

| Concern | Where (grep banner / fn) | Notes |
|---|---|---|
| Fullscreen media controls | `Fullscreen Media Control` (7525) | fs play/seek/progress |
| Core playback state | globals @7689 | `audio`, `words`, `wordGroups`, `currentGroup`, `currentAnimStyle`, `wordsPerGroup` |
| File/video load | `handleFile`-style code @7707+ | sets up preview video, waveform |
| Play/pause (single & multi-clip) | `MULTI-CLIP play/pause` (7901), `SINGLE-CLIP` (7986) | |
| Playhead sync | `_forcePlayheadUpdate` (8034) | |
| Timeline geometry | `getTLTotalW` (8534), headroom (8558) | Premiere-style width/zoom |
| Marquee selection | `MARQUEE SELECTION` (9080) | `selectedLayerIds` Set |
| Smart sync / grouping | `SMART SYNC ENGINE` (9608) | `masterWords`→`wordGroups`, breath-pause aware (`BREATH_PAUSE`) |
| **Live animation render** | `STYLE 0..8` blocks (10005–10639) | inline reimpl of animations for preview |
| Snap engine | `STEP 2: SNAP ENGINE` (11382) | |
| Properties/layer sync | `STEP 3` (11641) | |
| Waveform storage | `_fileWaveforms` (11814) | per-clip Float32Array |
| Smooth font update | `SMOOTH FONT UPDATE ENGINE` (12142) | avoids innerHTML rebuild jitter |
| Animation style props | `ANIMATION STYLE PROPERTIES` (12473) | `animStyleProps` config object |
| Bezier editor (style 7) | `BEZIER EDITOR` (12795) | |
| Panel/tab switching | `switchPanel` (13096), `ccSwitch` (13723) | |
| Export menu | `EXPORT SYSTEM` (13203) | `toggleExportMenu` |
| Caption translation | `CAPTION TRANSLATION` (13237) | `TRANSLATE_LANGS` |
| After Effects / MOGRT export | jsx @13681, `exportMOGRT` (18515) | script/template exports |
| CapCut panel | `CAPCUT PANEL` (13716) | `selectedCapIdx`, text case/bold/align globals |
| **Multi-shadow system** | `MULTI-SHADOW SYSTEM` (13838), `buildShadowCSS` (13918) | 6-layer cinematic drop shadow; `shadows[]` |
| Search & replace | `srCurrentIdx` (13835), `doReplace` | in Captions tab |
| Preview caption drag | `PREVIEW SCREEN CAPTION DRAG` (14332) | drag to reposition captions |
| Font style apply | `applyFontStyle` (14536) | |
| Caption panel scroll | `SMOOTH SCROLL ENGINE` (14937) | custom scroll, proximity highlight |
| **Auto caption** | `AUTO CAPTION` (15278) | tabs: AssemblyAI (15564) & OpenAI Whisper (15321) |
| Audio extraction | `AUDIO EXTRACTION ENGINE` (15685) | uses `electronAPI.extractAudioRegion` |
| SRT/TXT import | `SRT / TXT IMPORT` (16078) | `currentSyncMode`, `parsedSRTData` |
| Layer operations | `STEP 1: LAYER OPERATIONS` (16125) | |
| Right-click context menu | `CONTEXT MENU SYSTEM` (16297) | |
| Undo/redo | `undoStack`/`redoStack` (16692), handler @23665 | Ctrl+Z/Y, capture-phase |
| Video export (MediaRecorder) | `VIDEO EXPORT` (17292) | `vidRes`, in-browser fallback path |
| Image export | `CAPTION IMAGES EXPORT` (17528) | export caption PNGs |
| **Direct video export (FFmpeg)** | `exportVideoViaServer` (17677) | despite the name, calls Electron IPC |
| **Styled video export** | `EXPORT STYLED VIDEO` / `exportStyledVideo` (18241) | orchestrates the real export |
| **Frame rendering for export** | `renderCaptionFrames` (18343) | draws each frame → base64 PNG; `100% PREVIEW MATCH` capture of the DOM |
| Multi-clip preview | `MULTI-CLIP VIDEO PREVIEW` (21267) | `_activePreviewClipId` |
| Track visibility | `TRACK VISIBILITY TOGGLES` (21354) | |
| Clip drawing | `DRAW CLIP FUNCTION` (21934) | |
| Layer selection tool | `LAYER SELECTION TOOL` (23078) | select/hand/razor tools |
| Ripple delete | `rippleDeleteEnabled` (23709) | |
| VET bar engine | `VET BAR — JS ENGINE` (24137) | |
| Selection-tool cursor anim | `ANI CURSOR` (24929) | |
| Built-in text presets | `_BUILTIN_PRESETS` (24984) | 4 quick Text-panel styles |
| Universal slider keyboard | `UNIVERSAL SLIDER KEYBOARD` (25392) | type-to-set slider values |

There are **~480 top-level functions** in this file.

---

## 4. Key data model (renderer globals)

State lives in module-level globals in `index.html` (no store/framework):

- **`masterWords[]`** (9565) — `{text, start, end}`, single source of truth from transcription.
- **`wordGroups[]`** — grouped words with `words[]` and `wordTimes[]` (per-word start/end);
  what actually renders as a caption. Produced by the Smart Sync Engine from `masterWords`.
- **`words[]`, `currentGroup`, `wordsPerGroup`** — legacy/working copies + grouping size.
- **`currentAnimStyle`** (0–8), **`animStyleProps`** — active animation + its tunables.
- **`shadows[]`** — multi-layer drop-shadow definitions (`{dist,angle,size,opacity,color}`).
- **Caption text globals** — `captionTextCase`, `captionBold`, `captionItalic`,
  `captionAlign`, line-break flags.
- **Timeline / clips** — `audioClips`, `projectFiles`, `clipCaptionGroups`,
  `selectedClipIds`, `selectedLayerIds` (Set), `primarySelectedId`, `tlZoom`,
  `activeProjectId`, `currentPreset` (ratio/res/fps), `outPoint`.
- **Editing/selection** — `selectedGi`/`selectedWi`, `editingGroup`/`editingWord`,
  `undoStack`/`redoStack`, `copiedGroup`/`copiedLayers`.

`StyleCollector.fromUI()` (in `caption-engine.js`) reads these + DOM inputs into a
`CaptionStyleSpec`.

---

## 5. Two important flows

### Transcription → captions
1. User loads audio/video and enters a transcription API key (AssemblyAI or OpenAI
   Whisper) — stored in `localStorage`.
2. Optionally `extractAudioRegion` (via IPC → FFmpeg) produces a mono 16 kHz WAV to upload.
3. Renderer POSTs directly to `api.assemblyai.com` / `api.openai.com` and polls for
   results.
4. Words → `masterWords[]` → **Smart Sync Engine** groups them (breath-pause aware,
   `wordsPerGroup`) → `wordGroups[]` → rendered in preview.
   (SRT/TXT import is an alternative entry that skips the API.)

### Styled export (the core feature)
1. `exportStyledVideo()` (18241) orchestrates.
2. `renderCaptionFrames()` (18343) walks the timeline frame by frame, renders each
   caption frame to a canvas / captures the actual preview DOM (`html-to-image`) as a
   **transparent PNG**, base64-encoded — this is the "100% preview match" strategy.
3. Frames + video path + trim/quality/GPU flags → `electronAPI.exportFramesMode()`.
4. `main.js` writes PNGs to temp, runs one FFmpeg command overlaying the PNG sequence on
   the scaled video (muxing original audio), streams `export-progress` back, and returns
   the output path + size + timing.
5. Simpler alternative: `export-with-overlay` for a single static caption image.

---

## 6. Practical notes for editing

- **Navigation:** grep the `═══`/`───` banners; use the table in §3.
- **Animations:** to add/change one, touch BOTH `caption-engine.js`
  (`AnimationEngine.styles`) AND the inline `STYLE N` preview block, then verify it
  appears identically in an exported MP4 (preview and export don't fully share code).
- **Export/FFmpeg:** all in `main.js` IPC handlers; the renderer only prepares frames.
- **No tests / no build:** verify by running `npm start` and exercising the real UI.
- **Don't tighten the loose security config** (`webSecurity:false`, permissive CSP)
  without asking — it exists so the app can load local video/file URLs.
- **Language:** comments and UI strings mix English and Hinglish; that's intentional.

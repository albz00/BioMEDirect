# Firebase Cloud Functions - Auto srcArray Generator

This function automatically generates `srcArray` timing data when videos are uploaded to Firebase Storage.

## How It Works

1. When a video is uploaded to `videos/{lessonId}.mp4` in Firebase Storage
2. The function triggers automatically
3. It downloads the video temporarily
4. Uses FFmpeg to detect scene changes
5. Converts scene changes into `srcArray` format
6. Saves the `srcArray` to Firestore at `lessons/{lessonId}`
7. Cleans up the temporary file

## Setup

Dependencies are already installed. To deploy:

```bash
firebase deploy --only functions
```

## Configuration

- **Scene Detection Threshold**: Adjust `sceneThreshold` in `detectScenes()` function (default: 0.3)
  - Lower values = more sensitive (more scene changes detected)
  - Higher values = less sensitive (fewer scene changes)

## Testing

After deployment, upload a video to Firebase Storage at:
- Path: `videos/{lessonId}.mp4`
- Example: `videos/cytoskeleton_introduction_t.mp4`

The function will automatically process it and create the `srcArray` in Firestore.

## Notes

- The function only processes `.mp4` files in the `videos/` folder
- Scene detection uses FFmpeg's scene filter
- Generated `srcArray` includes an "Opening" segment and segments for each detected scene change

## Color Marker Model (current pipeline)

The live timeline pipeline (`runDeterministicYellowPipeline`) does NOT use generic scene
detection. It scans decoded frames for full-frame color cards and builds a marker model:

- **Yellow** (`detectYellowEventsDense`): primary freeze frame. Playback pauses on the scene until
  the user clicks. Not a menu link. Drives the chapter `srcArray` today.
- **Green** (`detectGreenEventsDense`): dual-purpose freeze frame. Behaves like a yellow stop AND is
  intended to be the anchor a menu link points to (the start of a lesson link).
- **Red** (`detectRedEventsDense`): loop marker. When playback reaches a red card, the runtime
  (`masterUIcontrol.js`) returns to the previous freeze marker's content and replays until the user
  clicks to break the loop. The detector mirrors the green detector; persisted as
  `redStopMarkers` / `redScreenRanges` / `redDetection` on `lessons/{lessonId}`.

All three cards are short (~1s) and are leap-frogged so the viewer never sees them.

### Exact card colors (calibration target)

The per-pixel classifiers are centered on the exact creator card colors (sampled from the provided
swatches), via `CARD_YELLOW_HUE` / `CARD_GREEN_HUE` / `CARD_RED_HUE` and `CARD_HUE_TOLERANCE` in
`index.js`:

- Yellow `#FFF000` -> HSV(56.5, 100%, 100%)
- Green `#00D800` -> HSV(120, 100%, 85%)
- Red `#FF1800` -> HSV(5.6, 100%, 100%)

Each hue window is `CARD_*_HUE +/- CARD_HUE_TOLERANCE` (default 11deg). The three hues are well
separated, so a true full-frame card scores ~100% coverage while off-hue anatomy/skin scores ~0.

### Red threshold calibration

Red is harder than green/yellow because red hue wraps around 0/360 and anatomy content (tissue,
blood) is also red. The detector uses strict coverage/saturation/flatness gates to reject non-card
red. If a specific video mis-detects red, tune these constants in `index.js` and regenerate:

- `CARD_RED_HUE` / `CARD_HUE_TOLERANCE` (hue window center/width)
- `RED_ENTER_THRESHOLD` (default 0.72) / `RED_EXIT_THRESHOLD` (default 0.62)
- `RED_EVENT_MIN_AVG_RATIO` (0.68) / `RED_EVENT_MIN_PEAK_RATIO` (0.78)
- `pixelStrictLoopRed()` saturation/value floors

Inspect `[red-dense]` / `[red-pipeline]` console logs and the admin Red Loop Markers panel
(`redDetection`) to see detected events, candidate spans, and `zeroReason`.

## Phase 2 (planned, NOT yet implemented)

Per the creator spec, the long-term model links menu items to **green** markers rather than to
yellow chapter order. This is intentionally deferred because it inverts the current menu logic.

1. **Re-point menu links from yellow chapters to green markers.** Today `mapYellowEventsToChapters`
   maps detected *yellow* events to chapter titles to build `srcArray`. The target model is:
   - Yellow = plain freeze stops (no menu linkage).
   - Green = the menu-linked freeze points (start of each lesson link).
   This requires rebuilding chapter/`srcArray` generation around green events and updating the
   per-lesson menu wiring (`*T.js` `currentSlide` indices + `chapterSegmentMap`), so the existing
   yellow-based menu linkage must be carefully broken and replaced.
2. **AI/OCR green-to-menu matching.** Once green markers anchor the menu, use the existing AI title
   mapping hooks (`mapYellowEventsToChaptersWithAI`, `openaiTitleMappingService.js`) and/or OCR to
   match the frame where each green card starts to the correct existing menu-link name. The
   `greenDetection.futureHooks` flags (`menuFreezeLinksReady`, `aiTitleMappingReady`) mark where this
   plugs in.


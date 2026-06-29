var currentSlide = 0; // == freezeFrame - 1
var clickedLink = false; // added to allow for display difference when link is clicked
var lastSlide; // Will be set after srcArray is loaded
var firstSlide = 0;

/**
 * Player timeline loaded from Firestore (see initializePlayer). Must be a real var so
 * nextSlide/update/safeSrcSegmentAt resolve; window.srcArray alone does not create this binding.
 */
var srcArray = [];

/** One-time warnings per slide index for invalid timeline rows (legacy data). */
var warnedInvalidSlide = {};

/** Nudge past color-card/content boundary so the first decoded frame is content, not a card tail. */
var CONTENT_SEEK_LEAD_IN_SEC = 0.1;
/** When skipping color-card intervals, land clearly after the detected end (seconds). */
var COLOR_CARD_RANGE_SKIP_EPS_SEC = 0.1;
/** @deprecated alias — use COLOR_CARD_RANGE_SKIP_EPS_SEC */
var YELLOW_RANGE_SKIP_EPS_SEC = COLOR_CARD_RANGE_SKIP_EPS_SEC;
/** Keep video continuous; timeline rows are chapter/navigation anchors. */
var CONTINUOUS_VIDEO_PLAYBACK = true;
/** Pause at freeze markers (yellow + green) during continuous playback. */
var PAUSE_AT_FREEZE_MARKERS = true;
/** @deprecated alias — use PAUSE_AT_FREEZE_MARKERS */
var PAUSE_AT_YELLOW_MARKERS = PAUSE_AT_FREEZE_MARKERS;

/**
 * TEMPORARY TESTING MODE — remove once green->menu mapping (Phase 2) lands.
 * When on, every menu link plays from the very start of the video (t=0) instead of
 * previewing a chapter's end frame. Toggle with the flag below or the `?menuFromZero=1`
 * query param. Default OFF so production behavior is unchanged.
 */
var TEMP_MENU_LINKS_PLAY_FROM_ZERO = true;

function menuLinksPlayFromZeroEnabled() {
    if (TEMP_MENU_LINKS_PLAY_FROM_ZERO === true) return true;
    try {
        if (typeof location !== "undefined" && location.search) {
            return /[?&]menuFromZero=1\b/.test(location.search);
        }
    } catch (e) { /* ignore */ }
    return false;
}

/* ==========================================================================
 * MARKER DEBUG OVERLAY (notifier + timeline strip) — DEBUG TOOLING ONLY.
 * Toggle with ?debugMarkers=1 in the URL or window.DEBUG_MARKERS = true.
 * Default OFF so production playback is unaffected. All DOM is built lazily
 * and self-styled (injected <style>), so no per-lesson HTML/CSS edits are
 * needed and the overlay works platform-wide via this shared file.
 * ========================================================================== */
var markerDebugOverlayBuilt = false;
var markerDebugEls = null;
var markerDebugFlashTimer = null;

/**
 * TEMP testing default: show the overlay WITHOUT needing the URL param.
 * Set to false to return to opt-in behavior (requires ?debugMarkers=1 / window.DEBUG_MARKERS).
 * Override at runtime with ?debugMarkers=0 or window.DEBUG_MARKERS = false.
 */
var TEMP_MARKER_DEBUG_OVERLAY_DEFAULT_ON = true;

function markerDebugOverlayEnabled() {
    if (typeof window !== "undefined" && window.DEBUG_MARKERS === true) return true;
    if (typeof window !== "undefined" && window.DEBUG_MARKERS === false) return false;
    try {
        if (typeof location !== "undefined" && location.search) {
            if (/[?&]debugMarkers=0\b/.test(location.search)) return false;
            if (/[?&]debugMarkers=1\b/.test(location.search)) return true;
        }
    } catch (e) { /* ignore */ }
    return TEMP_MARKER_DEBUG_OVERLAY_DEFAULT_ON === true;
}

function injectMarkerDebugStyles() {
    if (typeof document === "undefined" || document.getElementById("markerDebugStyles")) return;
    var css = "" +
        "#markerDebugPanel{position:fixed;right:8px;top:8px;z-index:99999;width:360px;max-width:46vw;" +
        "font:12px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#e8e8e8;" +
        "background:rgba(18,18,22,.92);border:1px solid #444;border-radius:8px;padding:8px 10px;" +
        "box-shadow:0 4px 18px rgba(0,0,0,.5);}" +
        "#markerDebugPanel .mdHeader{display:flex;justify-content:space-between;align-items:center;" +
        "font-weight:600;margin-bottom:4px;}" +
        "#markerDebugPanel .mdCounts{font-size:11px;color:#bdbdbd;}" +
        "#markerDebugPanel .mdState{font-size:11px;margin:2px 0;color:#cfe8ff;word-break:break-word;}" +
        "#markerDebugPanel .mdLast{font-size:11px;margin:2px 0;color:#ffe3a3;min-height:15px;word-break:break-word;}" +
        "#markerDebugStrip{position:relative;height:26px;margin:6px 0 2px;background:#26262c;" +
        "border-radius:4px;overflow:hidden;}" +
        "#markerDebugStrip .mdSpan{position:absolute;top:0;bottom:0;opacity:.85;}" +
        "#markerDebugStrip .mdSpan.yellow{background:#ffd400;}" +
        "#markerDebugStrip .mdSpan.green{background:#00d800;}" +
        "#markerDebugStrip .mdSpan.red{background:#ff1800;}" +
        "#markerDebugStrip .mdSpan.active{outline:2px solid #fff;outline-offset:-2px;opacity:1;}" +
        "#markerDebugStrip .mdTick{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.6);}" +
        "#markerDebugStrip .mdPlayhead{position:absolute;top:-2px;bottom:-2px;width:2px;background:#fff;" +
        "box-shadow:0 0 4px #fff;}" +
        "#markerDebugLegend{font-size:10px;color:#9a9a9a;margin-top:2px;}" +
        "#markerDebugFlash{position:fixed;top:14px;left:38%;transform:translateX(-50%);z-index:100000;" +
        "padding:10px 18px;border-radius:8px;font:700 16px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;" +
        "color:#111;opacity:0;pointer-events:none;transition:opacity .12s ease;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.5);}" +
        "#markerDebugFlash.show{opacity:1;}" +
        "#markerDebugFlash.yellow{background:#ffd400;}" +
        "#markerDebugFlash.green{background:#00d800;}" +
        "#markerDebugFlash.red{background:#ff1800;color:#fff;}" +
        "#markerDebugFlash.info{background:#cfe8ff;}";
    var style = document.createElement("style");
    style.id = "markerDebugStyles";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
}

function ensureMarkerDebugOverlay() {
    if (!markerDebugOverlayEnabled()) return null;
    if (typeof document === "undefined" || !document.body) return null;
    if (markerDebugOverlayBuilt && markerDebugEls) return markerDebugEls;
    injectMarkerDebugStyles();

    var panel = document.createElement("div");
    panel.id = "markerDebugPanel";
    panel.innerHTML =
        '<div class="mdHeader"><span>Marker Debug</span><span class="mdCounts" id="markerDebugCounts"></span></div>' +
        '<div class="mdState" id="markerDebugState">state: idle</div>' +
        '<div class="mdLast" id="markerDebugLast">last: \u2014</div>' +
        '<div id="markerDebugStrip"><div class="mdPlayhead" id="markerDebugPlayhead" style="left:0;"></div></div>' +
        '<div id="markerDebugLegend">yellow/green = freeze \u00b7 red = loop \u00b7 tick = crossAt \u00b7 bar = playhead \u00b7 Shift+D toggles</div>';
    document.body.appendChild(panel);

    var flash = document.createElement("div");
    flash.id = "markerDebugFlash";
    document.body.appendChild(flash);

    markerDebugEls = {
        panel: panel,
        counts: panel.querySelector("#markerDebugCounts"),
        state: panel.querySelector("#markerDebugState"),
        last: panel.querySelector("#markerDebugLast"),
        strip: panel.querySelector("#markerDebugStrip"),
        playhead: panel.querySelector("#markerDebugPlayhead"),
        flash: flash,
    };
    markerDebugOverlayBuilt = true;

    if (typeof window !== "undefined" && !window.__markerDebugHotkeyBound) {
        document.addEventListener("keydown", function (e) {
            if (e && e.shiftKey && (e.key === "D" || e.key === "d")) {
                if (markerDebugEls && markerDebugEls.panel) {
                    var hidden = markerDebugEls.panel.style.display === "none";
                    markerDebugEls.panel.style.display = hidden ? "block" : "none";
                }
            }
        });
        window.__markerDebugHotkeyBound = true;
    }
    return markerDebugEls;
}

function markerDebugVideoDuration() {
    try {
        if (typeof videoId !== "undefined" && videoId &&
            isFinite(Number(videoId.duration)) && Number(videoId.duration) > 0) {
            return Number(videoId.duration);
        }
    } catch (e) { /* ignore */ }
    var maxEnd = 0;
    for (var i = 0; i < freezeMarkers.length; i++) {
        if (isFinite(Number(freezeMarkers[i].end))) maxEnd = Math.max(maxEnd, Number(freezeMarkers[i].end));
    }
    for (var j = 0; j < loopMarkers.length; j++) {
        if (isFinite(Number(loopMarkers[j].end))) maxEnd = Math.max(maxEnd, Number(loopMarkers[j].end));
    }
    return maxEnd > 0 ? maxEnd : 0;
}

function renderMarkerDebugStrip() {
    var els = ensureMarkerDebugOverlay();
    if (!els || !els.strip) return;
    var duration = markerDebugVideoDuration();

    var yellow = 0, green = 0;
    for (var c = 0; c < freezeMarkers.length; c++) {
        if (freezeMarkers[c].markerType === "green") green++;
        else yellow++;
    }
    if (els.counts) {
        els.counts.textContent = "Y:" + yellow + " G:" + green + " R:" + loopMarkers.length +
            (duration > 0 ? " \u00b7 " + duration.toFixed(1) + "s" : "");
    }

    var stale = els.strip.querySelectorAll(".mdSpan, .mdTick");
    for (var s = 0; s < stale.length; s++) stale[s].parentNode.removeChild(stale[s]);

    if (duration <= 0) return;

    function place(marker, klass) {
        var start = Number(marker.start);
        var end = Number(marker.end);
        if (!isFinite(start) || !isFinite(end) || end < start) return;
        var leftPct = Math.max(0, Math.min(100, (start / duration) * 100));
        var widthPct = Math.max(0.6, Math.min(100 - leftPct, ((end - start) / duration) * 100));
        var span = document.createElement("div");
        span.className = "mdSpan " + klass;
        span.style.left = leftPct + "%";
        span.style.width = widthPct + "%";
        span.title = klass + " " + start.toFixed(2) + "-" + end.toFixed(2) +
            " (crossAt " + (isFinite(Number(marker.crossAt)) ? Number(marker.crossAt).toFixed(2) : "?") + ")";
        els.strip.appendChild(span);
        if (isFinite(Number(marker.crossAt))) {
            var tick = document.createElement("div");
            tick.className = "mdTick";
            tick.style.left = Math.max(0, Math.min(100, (Number(marker.crossAt) / duration) * 100)) + "%";
            els.strip.appendChild(tick);
        }
    }
    for (var f = 0; f < freezeMarkers.length; f++) {
        place(freezeMarkers[f], freezeMarkers[f].markerType === "green" ? "green" : "yellow");
    }
    for (var r = 0; r < loopMarkers.length; r++) {
        place(loopMarkers[r], "red");
    }
}

function updateMarkerDebugPlayhead() {
    if (!markerDebugOverlayEnabled()) return;
    var els = markerDebugEls;
    if (!els || !els.strip || !els.playhead) return;
    var duration = markerDebugVideoDuration();
    var t = 0;
    try {
        if (typeof videoId !== "undefined" && videoId && isFinite(Number(videoId.currentTime))) {
            t = Number(videoId.currentTime);
        }
    } catch (e) { /* ignore */ }
    if (duration > 0) {
        els.playhead.style.left = Math.max(0, Math.min(100, (t / duration) * 100)) + "%";
    }
    var cur = duration > 0 ? (t / duration) * 100 : -1;
    var spans = els.strip.querySelectorAll(".mdSpan");
    for (var i = 0; i < spans.length; i++) {
        var sp = spans[i];
        var lp = parseFloat(sp.style.left) || 0;
        var wp = parseFloat(sp.style.width) || 0;
        if (cur >= lp - 0.01 && cur <= lp + wp + 0.01) sp.classList.add("active");
        else sp.classList.remove("active");
    }
    if (els.state) {
        els.state.textContent = "state: " + guidedPlaybackState +
            " \u00b7 t=" + t.toFixed(2) +
            " \u00b7 curFreeze=" + currentFreezeFrameIdx +
            " \u00b7 seg=" + segmentTargetFreezeIdx;
    }
}

var MARKER_DEBUG_FLASH_EVENTS = {
    freeze_span_stop: "freeze stop",
    marker_pause_fired: "freeze stop",
    red_loop_entered: "loop",
    red_loop_repeat: "loop repeat",
    invisible_leapfrog_during_play: "leapfrog",
    green_passthrough_leapfrog: "leapfrog (keep playing)",
    color_card_safety_freeze_backstop: "freeze backstop",
    guided_event_trigger: "reached",
    click_step_to_red_loop: "click -> loop",
    click_step_to_yellow_stop: "click -> stop",
};

function markerDebugFlash(klass, text) {
    var els = markerDebugEls;
    if (!els || !els.flash) return;
    els.flash.className = klass || "info";
    els.flash.textContent = text || "";
    void els.flash.offsetWidth; // force reflow so the transition replays
    els.flash.classList.add("show");
    if (markerDebugFlashTimer) clearTimeout(markerDebugFlashTimer);
    markerDebugFlashTimer = setTimeout(function () {
        if (markerDebugEls && markerDebugEls.flash) markerDebugEls.flash.classList.remove("show");
    }, 900);
}

function pushMarkerDebugEvent(out) {
    if (!markerDebugOverlayEnabled()) return;
    var els = ensureMarkerDebugOverlay();
    if (!els || !out || typeof out !== "object") return;
    var ev = out.event || "";
    var type = out.markerType || null;
    var colorClass = type === "green" ? "green"
        : (type === "red" ? "red" : (type === "yellow" ? "yellow" : "info"));

    if (els.state) {
        els.state.textContent = "state: " + (out.mode || guidedPlaybackState) +
            (out.currentTime != null ? " \u00b7 t=" + out.currentTime : "") +
            " \u00b7 seg=" + (out.segmentTargetFreezeIndex != null ? out.segmentTargetFreezeIndex : segmentTargetFreezeIdx);
    }
    if (els.last) {
        var lt = out.currentTime != null ? out.currentTime
            : (out.chosenStopPoint != null ? out.chosenStopPoint : "");
        els.last.textContent = "last: " + (ev || "?") + (type ? " [" + type + "]" : "") +
            (lt !== "" ? " @" + lt + "s" : "");
    }
    if (Object.prototype.hasOwnProperty.call(MARKER_DEBUG_FLASH_EVENTS, ev)) {
        var label = (type ? type.toUpperCase() + " " : "") + MARKER_DEBUG_FLASH_EVENTS[ev];
        var at = out.currentTime != null ? out.currentTime
            : (out.chosenStopPoint != null ? out.chosenStopPoint
                : (out.chosenResumePoint != null ? out.chosenResumePoint : null));
        if (at != null) label += " @" + at + "s";
        markerDebugFlash(colorClass, label);
    }
}

/* ==========================================================================
 * COLOR-CARD MASK (rolling freeze-frame cover) — hides the brief color-card
 * flash during marker-driven seeks. A single requestAnimationFrame monitor shows
 * the last clean frame over the video whenever the playhead is inside a card
 * span, then hides it once the marker logic has seeked past the card. Self-styled
 * and lazily built (no per-lesson HTML/CSS edits). Disable at runtime with
 * window.DISABLE_CARD_MASK = true.
 * ========================================================================== */
var cardMask = { canvas: null, ctx: null, visible: false, lastDrawMs: 0, started: false };
var CARD_MASK_LEAD_SEC = 0.06;          // show cover slightly before a card would paint
var CARD_MASK_DRAW_INTERVAL_MS = 80;    // throttle clean-frame snapshots (~12fps)

function cardMaskEnabled() {
    if (typeof window !== "undefined" && window.DISABLE_CARD_MASK === true) return false;
    return CONTINUOUS_VIDEO_PLAYBACK === true;
}

function injectCardMaskStyles() {
    if (typeof document === "undefined" || document.getElementById("cardMaskStyles")) return;
    var css = "#cardMaskCover{position:fixed;left:0;top:0;width:0;height:0;z-index:6;" +
        "pointer-events:none;opacity:0;background:#000;transition:opacity .04s linear;}" +
        "#cardMaskCover.show{opacity:1;}";
    var style = document.createElement("style");
    style.id = "cardMaskStyles";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
}

function ensureCardMaskOverlay() {
    if (typeof document === "undefined") return null;
    if (cardMask.canvas) return cardMask;
    injectCardMaskStyles();
    var host = document.getElementById("animation") || document.body;
    if (!host) return null;
    var canvas = document.createElement("canvas");
    canvas.id = "cardMaskCover";
    host.appendChild(canvas);
    cardMask.canvas = canvas;
    cardMask.ctx = canvas.getContext("2d");
    return cardMask;
}

/** Align the cover exactly over the video element (viewport coords -> position:fixed). */
function positionCardMaskOverVideo() {
    if (!cardMask.canvas || typeof videoId === "undefined" || !videoId) return;
    try {
        var r = videoId.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
            cardMask.canvas.style.left = r.left + "px";
            cardMask.canvas.style.top = r.top + "px";
            cardMask.canvas.style.width = r.width + "px";
            cardMask.canvas.style.height = r.height + "px";
        }
    } catch (e) { /* ignore */ }
}

/** True if the playhead is inside (or just about to enter) any color-card span. */
function videoTimeInsideCardSpan(t) {
    var n = Number(t);
    if (!isFinite(n)) return false;
    var ranges = getColorCardRangesFromWindow();
    for (var i = 0; i < ranges.length; i++) {
        var s = Number(ranges[i].start);
        var e = Number(ranges[i].end);
        if (!isFinite(s) || !isFinite(e)) continue;
        if (n >= s - CARD_MASK_LEAD_SEC && n < e + COLOR_CARD_RANGE_SKIP_EPS_SEC) return true;
    }
    return false;
}

/** Roll the "last clean frame" snapshot while playing and clear of any card. */
function refreshCardMaskCleanFrame(nowMs) {
    if (!cardMask.canvas || !cardMask.ctx) return;
    if (typeof videoId === "undefined" || !videoId) return;
    if (videoId.paused) return;
    if (Number(videoId.readyState) < 2) return;
    var vw = Number(videoId.videoWidth);
    var vh = Number(videoId.videoHeight);
    if (!(vw > 0) || !(vh > 0)) return;
    if (nowMs - cardMask.lastDrawMs < CARD_MASK_DRAW_INTERVAL_MS) return;
    if (cardMask.canvas.width !== vw || cardMask.canvas.height !== vh) {
        cardMask.canvas.width = vw;
        cardMask.canvas.height = vh;
    }
    try {
        // Cross-origin video taints the canvas, but we only DISPLAY it (no pixel readback), so OK.
        cardMask.ctx.drawImage(videoId, 0, 0, vw, vh);
        cardMask.lastDrawMs = nowMs;
    } catch (e) { /* ignore transient draw errors */ }
}

function showCardMask() {
    if (!cardMask.canvas || cardMask.visible) return;
    positionCardMaskOverVideo();
    cardMask.canvas.classList.add("show");
    cardMask.visible = true;
}

function hideCardMask() {
    if (!cardMask.canvas || !cardMask.visible) return;
    cardMask.canvas.classList.remove("show");
    cardMask.visible = false;
}

function cardMaskTick() {
    try {
        if (cardMaskEnabled() && cardMask.canvas && typeof videoId !== "undefined" && videoId) {
            if (videoTimeInsideCardSpan(Number(videoId.currentTime))) {
                showCardMask(); // hold the last clean frame (do NOT draw the card frame)
            } else {
                hideCardMask();
                refreshCardMaskCleanFrame(Date.now());
            }
        } else {
            hideCardMask();
        }
    } catch (e) { /* the mask must never break playback */ }
    if (typeof window !== "undefined" && window.requestAnimationFrame) {
        window.requestAnimationFrame(cardMaskTick);
    }
}

function startCardMask() {
    if (cardMask.started) return;
    if (!ensureCardMaskOverlay()) return;
    cardMask.started = true;
    if (typeof window !== "undefined" && window.requestAnimationFrame) {
        window.requestAnimationFrame(cardMaskTick);
    }
}

/** Unified freeze markers (yellow + green), sorted by crossAt. */
var freezeMarkers = [];
/** Loop markers (red), sorted by crossAt. */
var loopMarkers = [];
/** Chronological playback guide: freeze stops and red loop triggers. */
var playbackEvents = [];
/** Confirmed green->menu mapping: { menuId: seekTimeSeconds }. Built from window.greenMenuMapping. */
var menuGreenSeekByMenuId = {};
/** The menu button id (e.g. "menu2") of the most recent menu-link click, for green seek routing. */
var lastClickedMenuId = null;
var nextFreezeMarkerIdx = 0;
var nextPlaybackEventIdx = 0;
var pausedAtFreezeMarkerIdx = -1;
var lastPlaybackTimeForMarkerCheck = null;
var guidedPlaybackState = "idle"; // idle | playing_to_next_freeze | paused_at_freeze | looping_at_red | completed
var guidedTargetEventIdx = -1;
/** Freeze frame we are stopped on (segment start). */
var currentFreezeFrameIdx = -1;
/** Freeze frame we are playing toward (segment end stop). */
var nextFreezeFrameIdx = -1;
/** Alias for nextFreezeFrameIdx while a segment is active (survives red loop). */
var segmentTargetFreezeIdx = -1;
var activeRedLoopEventIdx = -1;
var activeRedLoopReturnTime = null;
var activeRedLoopPreviousFreezeIdx = -1;
/** Set when first-chapter entry must re-assert 0.00 on the next play() (guards against overrides). */
var pendingForcedLessonStartAtZero = false;
/** Emergency per-lesson override: use legacy chapter stepping player runtime. */
var legacyChapterPlayerOverride = false;

/** Tensegrity-only: diagnostics for short yellow flashes vs coarse timeupdate (temporary). */
var tensegrityDebugLastTimeupdateMs = 0;
var tensegrityDebugLastRoutineWallMs = 0;
var tensegrityDebugShortestMarkerSec = null;

// Need to add 1 to lastSlide to account for extra click to return to menu at end

/** @deprecated aliases — kept for tensegrity-only diagnostics */
var yellowMarkers = [];
var nextYellowMarkerIdx = 0;
var pausedAtYellowMarkerIdx = -1;
var guidedTargetMarkerIdx = -1;

function syncLegacyYellowMarkerAliases() {
    yellowMarkers = freezeMarkers;
    nextYellowMarkerIdx = nextFreezeMarkerIdx;
    pausedAtYellowMarkerIdx = pausedAtFreezeMarkerIdx;
    guidedTargetMarkerIdx = guidedTargetEventIdx;
}

/**
 * Copy Firestore lesson marker fields onto window.* for the player.
 * Call from each lesson loadSrcArray after reading lessonDoc.data().
 */
function applyLessonMarkerGlobalsFromFirestoreData(data) {
    if (!data || typeof data !== "object") return;
    if (typeof window === "undefined") return;
    if (Array.isArray(data.yellowScreenRanges)) window.yellowScreenRanges = data.yellowScreenRanges;
    if (Array.isArray(data.yellowStopMarkers)) window.yellowStopMarkers = data.yellowStopMarkers;
    if (data.greenDetection) window.greenDetection = data.greenDetection;
    if (Array.isArray(data.greenScreenRanges)) window.greenScreenRanges = data.greenScreenRanges;
    if (Array.isArray(data.greenStopMarkers)) window.greenStopMarkers = data.greenStopMarkers;
    if (data.redDetection) window.redDetection = data.redDetection;
    if (Array.isArray(data.redScreenRanges)) window.redScreenRanges = data.redScreenRanges;
    if (Array.isArray(data.redStopMarkers)) window.redStopMarkers = data.redStopMarkers;
    if (data.greenMenuMapping && typeof data.greenMenuMapping === "object") window.greenMenuMapping = data.greenMenuMapping;
    var hasYellow = (Array.isArray(window.yellowStopMarkers) && window.yellowStopMarkers.length > 0) ||
        (Array.isArray(window.yellowScreenRanges) && window.yellowScreenRanges.length > 0);
    var hasGreen = (Array.isArray(window.greenStopMarkers) && window.greenStopMarkers.length > 0) ||
        (Array.isArray(window.greenScreenRanges) && window.greenScreenRanges.length > 0) ||
        (window.greenDetection && Array.isArray(window.greenDetection.events) && window.greenDetection.events.length > 0);
    var hasRed = (Array.isArray(window.redStopMarkers) && window.redStopMarkers.length > 0) ||
        (Array.isArray(window.redScreenRanges) && window.redScreenRanges.length > 0) ||
        (window.redDetection && Array.isArray(window.redDetection.events) && window.redDetection.events.length > 0);
    if (hasYellow || hasGreen || hasRed) {
        window.shouldSkipColorCards = true;
        window.shouldSkipYellow = true;
    }
    window.forceFirstChapterStartAtZero = data.forceFirstChapterStartAtZero === true;
}

function shouldForceFirstChapterStartAtZero() {
    return typeof window !== "undefined" && window.forceFirstChapterStartAtZero === true;
}

function shouldUseLegacyChapterPlayerOverride() {
    // Legacy chapter-stepping player is only used when a page explicitly opts in.
    // (Previously the cleavage lesson was hardcoded here, which disabled the marker-driven
    // natural playback + freeze stops for that lesson.)
    return typeof window !== "undefined" && window.useLegacyChapterPlayerOverride === true;
}

/** First playable chapter row index in srcArray (after opening). */
function getFirstPlayableChapterSlideIndex() {
    if (!Array.isArray(srcArray)) return -1;
    for (var i = 1; i < srcArray.length; i++) {
        if (isPlayableContentSegment(srcArray[i])) return i;
    }
    return -1;
}

function isFirstPlayableChapterSlide(slideIdx) {
    return slideIdx === getFirstPlayableChapterSlideIndex();
}

function isFirstChapterSegment(seg) {
    if (!seg) return false;
    var ci = seg.chapterIndex;
    return ci === 1 || ci === "1";
}

function shouldApplyForceZeroForSlide(seg, slideIdx) {
    // Temporary testing aid: force every slide to start at t=0.
    if (menuLinksPlayFromZeroEnabled()) return true;
    if (!shouldForceFirstChapterStartAtZero()) return false;
    if (isFirstPlayableChapterSlide(slideIdx)) return true;
    if (isFirstChapterSegment(seg)) return true;
    return false;
}

/**
 * Chapter rows are navigation anchors only. When forceFirstChapterStartAtZero is set,
 * chapter 1 play/seek uses 0.00 — not the first mapped yellow contentStart.
 */
function resolveChapterPlaybackSeekTime(seg, slideIdx) {
    if (shouldApplyForceZeroForSlide(seg, slideIdx)) return 0;
    return segmentContentSeekTime(seg);
}

/**
 * Recompute all forward marker cursors from actual currentTime (never only advance forward).
 */
function recomputeMarkerRuntimeFromTime(t, reason) {
    var time = Number(t);
    if (!isFinite(time)) time = 0;

    nextFreezeMarkerIdx = 0;
    for (var fi = 0; fi < freezeMarkers.length; fi++) {
        if (time > freezeMarkers[fi].end + COLOR_CARD_RANGE_SKIP_EPS_SEC) {
            nextFreezeMarkerIdx = fi + 1;
        }
    }

    nextPlaybackEventIdx = 0;
    for (var pi = 0; pi < playbackEvents.length; pi++) {
        if (time > playbackEvents[pi].crossAt + 1e-4) {
            nextPlaybackEventIdx = pi + 1;
        }
    }

    if (guidedPlaybackState !== "paused_at_freeze" && guidedPlaybackState !== "playing_to_next_freeze") {
        currentFreezeFrameIdx = findPreviousFreezeMarkerIndexBeforeTime(time + 0.001);
    }

    syncLegacyYellowMarkerAliases();
    if (reason) {
        var nextEv = nextPlaybackEventIdx < playbackEvents.length ? playbackEvents[nextPlaybackEventIdx] : null;
        logPlayerMarkerDebug({
            event: "marker_cursors_recomputed",
            reason: reason,
            currentTime: Math.round(time * 1000) / 1000,
            nextFreezeMarkerIndex: nextFreezeMarkerIdx,
            nextPlaybackEventIndex: nextPlaybackEventIdx,
            currentFreezeFrameIndex: currentFreezeFrameIdx,
            nextTargetCrossAt: nextEv && isFinite(Number(nextEv.crossAt))
                ? Math.round(Number(nextEv.crossAt) * 1000) / 1000 : null,
            nextTargetKind: nextEv ? nextEv.kind : null,
        });
    }
}

/** Seek video and realign marker runtime to that time. */
function syncVideoSeekWithMarkerState(videoEl, t, reason) {
    if (!videoEl || !isFinite(Number(t))) return;
    videoEl.currentTime = Number(t);
    lastPlaybackTimeForMarkerCheck = Number(t);
    recomputeMarkerRuntimeFromTime(Number(t), reason);
}

/**
 * Hard anchor for lesson entry: true video start at 0.00 (not mapped src_start).
 * @param {object} [options] preserveActiveSegment: keep segmentTarget/guided targets (play() guard)
 */
function enforceLessonStartAtZero(videoEl, slideIdx, reason, options) {
    var seg = safeSrcSegmentAt(slideIdx);
    if (!videoEl || !shouldApplyForceZeroForSlide(seg, slideIdx)) return false;
    options = options || {};
    var preserveSegment = options.preserveActiveSegment === true;
    if (!preserveSegment) {
        pausedAtFreezeMarkerIdx = -1;
        currentFreezeFrameIdx = -1;
        segmentTargetFreezeIdx = -1;
        nextFreezeFrameIdx = -1;
        guidedTargetEventIdx = -1;
        activeRedLoopEventIdx = -1;
        activeRedLoopReturnTime = null;
        activeRedLoopPreviousFreezeIdx = -1;
    }
    syncVideoSeekWithMarkerState(videoEl, 0, reason || "forced_lesson_start_at_zero");
    logPlayerMarkerDebug({
        event: "forced_lesson_start_at_zero",
        reason: reason || null,
        currentSlide: slideIdx,
        chosenResumePoint: 0,
        forceFirstChapterStartAtZero: true,
    });
    return true;
}

function isInLessonVideoClickContext() {
    return !states.menu && currentSlide > 0 && CONTINUOUS_VIDEO_PLAYBACK && freezeMarkers.length > 0;
}

function isPlayingSegmentForward() {
    return guidedPlaybackState === "playing_to_next_freeze" || guidedPlaybackState === "looping_at_red";
}

function isInVideoSurfaceClick(clickEvent) {
    var target = clickEvent && clickEvent.target ? clickEvent.target : null;
    if (!target) return false;
    var id = target.id ? String(target.id) : "";
    if (id === "videoId" || id === "animation") return true;
    if (target.closest) {
        return !!target.closest("#videoId, #animation");
    }
    return false;
}

function isActionableInVideoClick(clickEvent) {
    if (!CONTINUOUS_VIDEO_PLAYBACK) return true;
    if (!isInVideoSurfaceClick(clickEvent)) return true;
    if (!videoId) return false;
    // Click always has power: resume from a freeze, break a red loop, or (while playing a
    // segment) skip forward to the next freeze stop. No state should swallow the click.
    return true;
}

/**
 * Keep interactive runtime state coherent with currentTime as single source of truth.
 */
function syncInteractiveRuntimeToCurrentTime(reason) {
    if (!CONTINUOUS_VIDEO_PLAYBACK || typeof videoId === "undefined" || !videoId) {
        return { recovered: false, action: "no_video" };
    }
    var t = Number(videoId.currentTime);
    if (!isFinite(t)) t = 0;
    var paused = !!videoId.paused;
    var prevMode = guidedPlaybackState;
    var prevCurrentFreeze = currentFreezeFrameIdx;
    var prevNextFreeze = nextFreezeFrameIdx;
    var prevSegmentTarget = segmentTargetFreezeIdx;
    var prevGuidedTarget = guidedTargetEventIdx;
    var action = "no_change";
    var recovered = false;

    recomputeMarkerRuntimeFromTime(t, null);
    if (freezeMarkers.length === 0) {
        if (guidedPlaybackState !== "completed") {
            setGuidedPlaybackState("completed", reason || "runtime_sync_no_freezes");
            recovered = true;
            action = "set_completed_no_freezes";
        }
        return { recovered: recovered, action: action };
    }

    var freezeAtTime = findFreezeFrameIndexAtTime(t);
    var prevFreeze = findPreviousFreezeMarkerIndexBeforeTime(t + 0.001);
    // Segment target is the next genuine STOP (yellow); greens are pass-throughs, never targets.
    var nextTarget = findFirstStopMarkerIndexAfterTime(t);

    if (paused) {
        // Attribute the paused state to the nearest YELLOW stop (greens never pause), so a manual
        // or edge pause near a green doesn't mislabel runtime state.
        var pauseIdx = (freezeAtTime >= 0 && isStopFreezeMarker(freezeMarkers[freezeAtTime]))
            ? freezeAtTime
            : findPreviousStopMarkerIndexBeforeTime(t + 0.001);
        if (pauseIdx >= 0) {
            pausedAtFreezeMarkerIdx = pauseIdx;
            currentFreezeFrameIdx = pauseIdx;
            nextFreezeFrameIdx = -1;
            segmentTargetFreezeIdx = -1;
            guidedTargetEventIdx = -1;
            if (guidedPlaybackState !== "paused_at_freeze") {
                setGuidedPlaybackState("paused_at_freeze", reason || "runtime_sync_paused_freeze");
                recovered = true;
                action = "recover_paused_at_freeze";
            }
        } else if (guidedPlaybackState === "playing_to_next_freeze") {
            setGuidedPlaybackState("idle", reason || "runtime_sync_paused_idle");
            recovered = true;
            action = "recover_idle_from_paused";
        }
    } else if (guidedPlaybackState === "looping_at_red") {
        // Red loop owns currentTime (it seeks back to the previous freeze each pass).
        // Never retarget or change state here or we clobber the loop mid-flight.
        action = "preserve_red_loop";
    } else if (guidedPlaybackState === "playing_to_next_freeze" &&
        segmentTargetFreezeIdx >= 0 && segmentTargetFreezeIdx < freezeMarkers.length) {
        // CRITICAL: do NOT recompute the target every tick while actively playing a segment.
        // Reassigning segmentTargetFreezeIdx = prevFreeze+1 the instant the playhead crosses a
        // freeze's crossAt reclassifies that freeze as "already behind us" before
        // tryCommitSegmentTargetFreezeStop / the red-loop trigger can commit the stop — which
        // made every yellow/green/red play through. Keep the active target stable; only refresh
        // the "current" pointer for coherent reporting.
        if (prevFreeze >= 0 && prevFreeze < segmentTargetFreezeIdx) {
            currentFreezeFrameIdx = prevFreeze;
        }
        action = "preserve_active_segment_target";
    } else {
        if (nextTarget >= 0 && nextTarget < freezeMarkers.length) {
            currentFreezeFrameIdx = prevFreeze;
            nextFreezeFrameIdx = nextTarget;
            segmentTargetFreezeIdx = nextTarget;
            guidedTargetEventIdx = findNextSegmentPlaybackEventIdx(t, nextTarget);
            if (guidedPlaybackState !== "playing_to_next_freeze") {
                setGuidedPlaybackState("playing_to_next_freeze", reason || "runtime_sync_playing_segment");
                recovered = true;
                action = "recover_playing_to_next_freeze";
            } else if (prevSegmentTarget !== segmentTargetFreezeIdx || prevGuidedTarget !== guidedTargetEventIdx) {
                recovered = true;
                action = "sync_playing_segment_target";
            }
        } else {
            nextFreezeFrameIdx = -1;
            segmentTargetFreezeIdx = -1;
            guidedTargetEventIdx = -1;
            if (guidedPlaybackState !== "completed") {
                setGuidedPlaybackState("completed", reason || "runtime_sync_no_next_freeze");
                recovered = true;
                action = "recover_completed_no_next_target";
            }
        }
    }

    syncLegacyYellowMarkerAliases();
    if (recovered || reason) {
        logPlayerMarkerDebug({
            event: "runtime_sync",
            reason: reason || null,
            recoveryActionTaken: action,
            videoPaused: paused,
            currentTime: Math.round(t * 1000) / 1000,
            prevMode: prevMode,
            mode: guidedPlaybackState,
            prevCurrentFreezeFrameIndex: prevCurrentFreeze,
            prevNextFreezeFrameIndex: prevNextFreeze,
            prevSegmentTargetFreezeIndex: prevSegmentTarget,
            prevGuidedTargetEventIndex: prevGuidedTarget,
            currentFreezeFrameIndex: currentFreezeFrameIdx,
            nextFreezeFrameIndex: nextFreezeFrameIdx,
            segmentTargetFreezeIndex: segmentTargetFreezeIdx,
            nextFreezeMarkerIndex: nextFreezeMarkerIdx,
            nextPlaybackEventIndex: nextPlaybackEventIdx,
            guidedTargetEventIndex: guidedTargetEventIdx,
            recovered: recovered,
        });
    }
    return { recovered: recovered, action: action };
}

function getInteractiveControlSnapshot() {
    var inLesson = isInLessonVideoClickContext();
    var videoPaused = (typeof videoId !== "undefined" && videoId) ? !!videoId.paused : true;
    var hasActiveSegmentTarget = segmentTargetFreezeIdx >= 0 && segmentTargetFreezeIdx < freezeMarkers.length;
    var inVideoClickAllowed = false;
    var clickIgnoreReason = null;
    if (inLesson) {
        if (guidedPlaybackState === "paused_at_freeze" || guidedPlaybackState === "looping_at_red") {
            inVideoClickAllowed = true;
        } else if (videoPaused) {
            inVideoClickAllowed = true;
        } else if (isPlayingSegmentForward() && hasActiveSegmentTarget) {
            inVideoClickAllowed = false;
            clickIgnoreReason = "segment_already_playing";
        } else {
            inVideoClickAllowed = true;
        }
    }
    return {
        inVideoClickAllowed: inVideoClickAllowed,
        menuNavigationAllowed: true,
        controlsEnabled: { inVideoClick: inVideoClickAllowed, menuNavigation: true },
        controlsDisabled: (!inVideoClickAllowed && inLesson && isPlayingSegmentForward() && hasActiveSegmentTarget)
            ? ["in_video_click_while_playing"] : [],
        clickIgnoreReason: clickIgnoreReason,
    };
}

/** When paused on a freeze post-frame but state was lost, restore paused_at_freeze. */
function syncPausedFreezeStateFromVideoTime(reason) {
    if (typeof videoId === "undefined" || !videoId || !videoId.paused) return false;
    if (guidedPlaybackState === "paused_at_freeze" && pausedAtFreezeMarkerIdx >= 0) return true;
    var idx = findFreezeFrameIndexAtTime(Number(videoId.currentTime));
    if (idx < 0) {
        idx = findPreviousFreezeMarkerIndexBeforeTime(Number(videoId.currentTime) + 0.001);
    }
    if (idx < 0) return false;
    pausedAtFreezeMarkerIdx = idx;
    currentFreezeFrameIdx = idx;
    segmentTargetFreezeIdx = -1;
    nextFreezeFrameIdx = -1;
    setGuidedPlaybackState("paused_at_freeze", reason || "infer_paused_at_freeze");
    return true;
}

function logPlayerMarkerDebug(payload) {
    var ctrl = getInteractiveControlSnapshot();
    var base = {
        mode: guidedPlaybackState,
        videoPaused: (typeof videoId !== "undefined" && videoId) ? !!videoId.paused : true,
        currentTime: (typeof videoId !== "undefined" && videoId && isFinite(Number(videoId.currentTime)))
            ? Math.round(Number(videoId.currentTime) * 1000) / 1000 : null,
        currentFreezeFrameIndex: currentFreezeFrameIdx,
        nextFreezeFrameIndex: nextFreezeFrameIdx,
        segmentTargetFreezeIndex: segmentTargetFreezeIdx,
        nextFreezeMarkerIndex: nextFreezeMarkerIdx,
        nextPlaybackEventIndex: nextPlaybackEventIdx,
        guidedTargetEventIndex: guidedTargetEventIdx,
        freezeMarkerCount: freezeMarkers.length,
        loopMarkerCount: loopMarkers.length,
        playbackEventCount: playbackEvents.length,
        activeRedLoopEventIndex: activeRedLoopEventIdx,
        activeRedLoopPreviousFreezeIndex: activeRedLoopPreviousFreezeIdx,
        activeRedLoopReturnTime: activeRedLoopReturnTime != null && isFinite(Number(activeRedLoopReturnTime))
            ? Math.round(Number(activeRedLoopReturnTime) * 1000) / 1000 : null,
        inVideoClickAllowed: ctrl.inVideoClickAllowed,
        controlsEnabled: ctrl.controlsEnabled,
        controlsDisabled: ctrl.controlsDisabled,
    };
    var out = {};
    for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k]; }
    if (payload && typeof payload === "object") {
        for (var p in payload) { if (Object.prototype.hasOwnProperty.call(payload, p)) out[p] = payload[p]; }
    }
    console.log("[player-debug]", JSON.stringify(out));
    try { pushMarkerDebugEvent(out); } catch (debugErr) { /* overlay must never break playback */ }
}

function isTensegrityLessonPlayerDebug() {
    try {
        var p = (typeof location !== "undefined" && location.pathname) ? String(location.pathname).toLowerCase() : "";
        if (p.indexOf("tensegrity") >= 0) return true;
        var vu = (typeof window !== "undefined" && typeof window.videoUrl === "string") ? window.videoUrl.toLowerCase() : "";
        if (vu.indexOf("tensegrity") >= 0) return true;
    } catch (e) { /* ignore */ }
    return false;
}

function tensegrityPlayerDebugLog(obj) {
    if (!isTensegrityLessonPlayerDebug()) return;
    try {
        console.log("[tensegrity-player-debug]", JSON.stringify(obj));
    } catch (e) {
        console.log("[tensegrity-player-debug]", obj);
    }
}

/**
 * Classify whether a stop/seek time is still "on yellow" vs clearly past the window (for logging).
 */
function tensegrityClassifyStopTarget(stopTarget, mk) {
    var st = Number(stopTarget);
    var ys = mk && Number(mk.start);
    var ye = mk && Number(mk.end);
    var cs = mk && mk.contentStart != null ? Number(mk.contentStart) : null;
    var eps = 0.012;
    if (!isFinite(st) || !mk || !isFinite(ys) || !isFinite(ye)) return "invalid";
    if (st + eps < ys) return "before_yellow_start";
    if (st <= ye + eps) return "inside_yellow_span_or_edge";
    if (cs != null && isFinite(cs) && st < cs - eps) return "after_yellow_before_reported_content_start";
    return "post_yellow_resolved";
}

function tensegrityApproxFrame30(timeSec) {
    if (!isFinite(Number(timeSec))) return null;
    return Math.round(Number(timeSec) * 30);
}

function tensegrityDumpMarkersContext(reason) {
    if (!isTensegrityLessonPlayerDebug()) return;
    var rows = [];
    var minDur = null;
    for (var i = 0; i < freezeMarkers.length; i++) {
        var m = freezeMarkers[i];
        var dur = m.end - m.start;
        if (minDur === null || dur < minDur) minDur = dur;
        rows.push({
            index: i,
            markerType: m.markerType,
            spanStart: Math.round(m.start * 1000) / 1000,
            spanEnd: Math.round(m.end * 1000) / 1000,
            crossAt: Math.round(m.crossAt * 1000) / 1000,
            durationSec: Math.round(dur * 10000) / 10000,
            contentStart: m.contentStart != null && isFinite(Number(m.contentStart)) ? Math.round(Number(m.contentStart) * 1000) / 1000 : null,
            approxFrame30AtStart: tensegrityApproxFrame30(m.start),
            approxFrame30AtEnd: tensegrityApproxFrame30(m.end),
        });
    }
    tensegrityDebugShortestMarkerSec = minDur;
    var rawLen = (typeof window !== "undefined" && Array.isArray(window.yellowScreenRanges)) ? window.yellowScreenRanges.length : 0;
    var stopLen = (typeof window !== "undefined" && Array.isArray(window.yellowStopMarkers)) ? window.yellowStopMarkers.length : 0;
    var greenLen = (typeof window !== "undefined" && window.greenDetection && Array.isArray(window.greenDetection.events))
        ? window.greenDetection.events.length : 0;
    tensegrityPlayerDebugLog({
        event: "markers_context",
        reason: reason || null,
        freezeMarkerCount: freezeMarkers.length,
        loopMarkerCount: loopMarkers.length,
        playbackEventCount: playbackEvents.length,
        rawYellowScreenRangesCount: rawLen,
        yellowStopMarkersCount: stopLen,
        greenDetectionEventCount: greenLen,
        shortestMarkerDurationSec: minDur != null ? Math.round(minDur * 10000) / 10000 : null,
        markers: rows,
        note: "Freeze markers (yellow+green) pause at crossAt; leapfrog seeks past card via resolvePostFreezeStopTime.",
    });
    syncLegacyYellowMarkerAliases();
}

/**
 * Tensegrity-only: correlate timeupdate jumps with guided marker targets + detect likely skips.
 */
function runTensegrityTimeupdateDiagnostics(videoEl, prev, curr, mk, crossedStart, pauseFired) {
    if (!isTensegrityLessonPlayerDebug()) return;
    var t = Number(curr);
    var p = Number(prev);
    var wallNow = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    var wallMsSincePrev = tensegrityDebugLastTimeupdateMs ? (wallNow - tensegrityDebugLastTimeupdateMs) : null;
    tensegrityDebugLastTimeupdateMs = wallNow;
    var dt = (isFinite(p) && isFinite(t)) ? Math.round((t - p) * 1000) / 1000 : null;
    var playingGuide = isPlayingSegmentForward();
    var idx = guidedTargetEventIdx;
    var paused = videoEl ? !!videoEl.paused : true;
    var anomalies = [];
    var eps = YELLOW_RANGE_SKIP_EPS_SEC;
    var mkDur = (mk && isFinite(mk.start) && isFinite(mk.end)) ? (mk.end - mk.start) : null;

    if (playingGuide && mk && isFinite(p) && isFinite(t) && !paused) {
        if (p >= mk.start && t > mk.end + eps) {
            anomalies.push("playing_past_resolved_marker_end_without_pause");
        }
        if (!crossedStart && t >= mk.start && t <= mk.end + eps && p >= mk.start) {
            anomalies.push("samples_start_inside_yellow_no_prior_before_start_sample");
        }
        if (crossedStart && !pauseFired) {
            anomalies.push("crossing_condition_true_but_pause_not_fired");
        }
    }
    if (playingGuide && mk && dt != null && mkDur != null && mkDur > 0 && dt > mkDur * 1.5) {
        anomalies.push("timeupdate_delta_exceeds_target_marker_duration");
    }
    if (playingGuide && mk && dt != null && tensegrityDebugShortestMarkerSec != null &&
        tensegrityDebugShortestMarkerSec > 0 && dt > tensegrityDebugShortestMarkerSec * 2) {
        anomalies.push("timeupdate_delta_much_larger_than_shortest_marker");
    }

    var shouldLog = anomalies.length > 0;
    if (!shouldLog && playingGuide) {
        if (wallNow - tensegrityDebugLastRoutineWallMs > 400) {
            shouldLog = true;
            tensegrityDebugLastRoutineWallMs = wallNow;
        }
    }
    if (!shouldLog) return;

    var payload = {
        event: anomalies.length > 0 ? "marker_runtime_anomaly" : "guided_timeupdate_tick",
        mode: guidedPlaybackState,
        videoPaused: paused,
        guidedTargetEventIdx: idx,
        nextFreezeMarkerCursor: nextFreezeMarkerIdx,
        pausedAtFreezeMarkerIdx: pausedAtFreezeMarkerIdx,
        previousTime: isFinite(p) ? Math.round(p * 1000) / 1000 : null,
        currentTime: isFinite(t) ? Math.round(t * 1000) / 1000 : null,
        playbackJumpSec: dt,
        wallMsSincePrevTimeupdate: wallMsSincePrev != null ? Math.round(wallMsSincePrev) : null,
        crossedStartCondition: !!(mk && isFinite(p) && isFinite(t) && p < mk.crossAt && t >= mk.crossAt),
        pauseFiredThisStep: !!pauseFired,
        anomalies: anomalies.length > 0 ? anomalies : undefined,
        runtimePrecisionNote: "If anomalies include timeupdate_delta_much_larger_than_shortest_marker, HTML5 timeupdate may skip sub-frame yellow without firing crossing from prev<start.",
    };
    if (mk && idx >= 0) {
        payload.marker = {
            index: idx,
            markerType: mk.markerType,
            spanStart: Math.round(mk.start * 1000) / 1000,
            spanEnd: Math.round(mk.end * 1000) / 1000,
            crossAt: Math.round(mk.crossAt * 1000) / 1000,
            contentStart: mk.contentStart != null && isFinite(Number(mk.contentStart)) ? Math.round(Number(mk.contentStart) * 1000) / 1000 : null,
            durationSec: mkDur != null ? Math.round(mkDur * 10000) / 10000 : null,
            approxFrame30AtStart: tensegrityApproxFrame30(mk.start),
            playerUsesTimeBasedCrossing: true,
        };
    }
    tensegrityPlayerDebugLog(payload);
}

function isOpeningUIRow(seg) {
    if (!seg) return false;
    if (seg.menuLink === "Opening") return true;
    if (seg.role === "opening") return true;
    return seg.freezeFrame === null && seg.src_start == null && seg.src_end == null;
}

function isPlayableContentSegment(seg) {
    if (!seg) return false;
    var a = Number(seg.src_start);
    var b = Number(seg.src_end);
    return isFinite(a) && isFinite(b) && b > a;
}

function safeSrcSegmentAt(idx) {
    if (!Array.isArray(srcArray) || idx < 0 || idx >= srcArray.length) return null;
    return srcArray[idx];
}

function normalizeColorCardRangeRow(r, markerType) {
    if (!r) return null;
    var start = r.start != null ? Number(r.start)
        : (r.yellowStart != null ? Number(r.yellowStart)
            : (r.greenStart != null ? Number(r.greenStart)
                : (r.redStart != null ? Number(r.redStart) : (r.startTime != null ? Number(r.startTime) : NaN))));
    var end = r.end != null ? Number(r.end)
        : (r.yellowEnd != null ? Number(r.yellowEnd)
            : (r.greenEnd != null ? Number(r.greenEnd)
                : (r.redEnd != null ? Number(r.redEnd) : (r.endTime != null ? Number(r.endTime) : NaN))));
    if (!isFinite(start) || !isFinite(end) || end <= start) return null;
    var cs = r.contentStart != null && r.contentStart !== "" ? Number(r.contentStart) : null;
    var freezeTime = r.freezeTime != null ? Number(r.freezeTime) : start;
    var resumeTime = r.resumeTime != null ? Number(r.resumeTime) : end;
    return {
        markerType: markerType || r.markerType || "unknown",
        start: start,
        end: end,
        contentStart: isFinite(cs) ? cs : null,
        freezeTime: isFinite(freezeTime) ? freezeTime : start,
        resumeTime: isFinite(resumeTime) ? resumeTime : end,
    };
}

function getColorCardRangesFromWindow() {
    var out = [];
    var w = typeof window !== "undefined" ? window : null;
    if (!w) return out;
    function pushRows(rows, type) {
        if (!Array.isArray(rows)) return;
        for (var i = 0; i < rows.length; i++) {
            var n = normalizeColorCardRangeRow(rows[i], type);
            if (n) out.push(n);
        }
    }
    pushRows(w.yellowScreenRanges, "yellow");
    pushRows(w.yellowStopMarkers, "yellow");
    pushRows(w.greenScreenRanges, "green");
    pushRows(w.greenStopMarkers, "green");
    if (w.greenDetection && Array.isArray(w.greenDetection.events)) {
        pushRows(w.greenDetection.events, "green");
    }
    pushRows(w.redScreenRanges, "red");
    pushRows(w.redStopMarkers, "red");
    if (w.redDetection && Array.isArray(w.redDetection.events)) {
        pushRows(w.redDetection.events, "red");
    }
    out.sort(function(a, b) { return a.start - b.start; });
    var deduped = [];
    for (var j = 0; j < out.length; j++) {
        var row = out[j];
        var dup = false;
        for (var k = 0; k < deduped.length; k++) {
            if (Math.abs(deduped[k].start - row.start) < 1e-4 && Math.abs(deduped[k].end - row.end) < 1e-4 &&
                deduped[k].markerType === row.markerType) {
                dup = true;
                break;
            }
        }
        if (!dup) deduped.push(row);
    }
    return deduped;
}

/**
 * Playback should never sit inside a persisted color-card interval. After computing a seek time,
 * advance to just past any overlapping yellow/green (and red) card spans (leapfrog safety net).
 */
function isTimeInsideFreezeMarkerCardSpan(t) {
    if (!isFinite(Number(t))) return false;
    for (var i = 0; i < freezeMarkers.length; i++) {
        var m = freezeMarkers[i];
        if (Number(t) >= m.start - 1e-4 && Number(t) < m.end + COLOR_CARD_RANGE_SKIP_EPS_SEC) {
            return true;
        }
    }
    return false;
}

/**
 * Leapfrog NON-STOP control cards (red loops + green pass-throughs). Yellow cards are genuine
 * stops and are handled via freeze-crossing + resolvePostFreezeStopTime (pause), so they are
 * intentionally NOT skipped here.
 */
function ensureSeekPastRedCardRangesOnly(t) {
    var eps = COLOR_CARD_RANGE_SKIP_EPS_SEC;
    var cur = Number(t);
    if (!isFinite(cur)) return t;
    var ranges = getColorCardRangesFromWindow();
    var guard = 0;
    while (guard < 48) {
        guard++;
        var moved = false;
        for (var i = 0; i < ranges.length; i++) {
            var r = ranges[i];
            if (r.markerType === "yellow") continue; // yellow = stop, never leapfrogged
            if (cur >= r.start - 1e-4 && cur < r.end + eps) {
                cur = r.end + eps;
                moved = true;
                break;
            }
        }
        if (!moved) break;
    }
    return cur;
}

/**
 * During guided play, NON-STOP control cards (red loops + green pass-throughs) are skipped
 * invisibly so playback keeps rolling. Yellow freeze spans are genuine stops and are handled by
 * tryCommitSegmentTargetFreezeStop / the guided-event trigger (post-marker resolve + pause).
 * NOTE: red ALSO triggers a loop via the guided-event path; this only handles the card skip when
 * the playhead lands inside a non-stop card between event ticks.
 */
function applyRedCardLeapfrogDuringGuidedPlay(videoEl, t) {
    if (!videoEl || !isFinite(Number(t))) return t;
    if (!isPlayingSegmentForward()) return t;
    var cur = Number(t);
    // Identify the non-stop card the playhead is sitting in (for accurate logging/overlay flash).
    var ranges = getColorCardRangesFromWindow();
    var hitType = null;
    for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        if (r.markerType === "yellow") continue;
        if (cur >= r.start - 1e-4 && cur < r.end + COLOR_CARD_RANGE_SKIP_EPS_SEC) {
            hitType = r.markerType;
            break;
        }
    }
    var past = ensureSeekPastRedCardRangesOnly(cur);
    if (Math.abs(past - cur) > 1e-5) {
        videoEl.currentTime = past;
        advanceMarkerCursorToTime(past);
        logPlayerMarkerDebug({
            event: hitType === "green" ? "green_passthrough_leapfrog" : "invisible_leapfrog_during_play",
            leapfrogApplied: true,
            leapfrogHelperUsed: true,
            chosenResumeTarget: Math.round(past * 1000) / 1000,
            previousTime: Math.round(cur * 1000) / 1000,
            markerType: hitType || "red",
        });
        return past;
    }
    return t;
}

/**
 * Per-tick color-card safety net during guided play (backstop for coarse timeupdate jumps):
 *  - red + green control cards: skip past invisibly (delegates to applyRedCardLeapfrogDuringGuidedPlay).
 *  - If the playhead landed INSIDE a freeze span (not caught by the crossing path):
 *      - genuine STOP (yellow outside a red loop): commit the freeze stop now so the card never
 *        renders. Pause + seek past via applyFreezeMarkerStopAtCrossing.
 *      - pass-through (green OR yellow inside a red loop): leapfrog past the span and keep playing.
 * Returns the (possibly leapfrogged) time; when a freeze stop fires or a pass-through leapfrogs,
 * currentTime is moved, so the caller's currentTime-change guard short-circuits the tick.
 */
function applyColorCardSafetyDuringGuidedPlay(videoEl, t) {
    if (!videoEl || !isFinite(Number(t))) return t;
    if (!isPlayingSegmentForward()) return t;

    var afterLeapfrog = applyRedCardLeapfrogDuringGuidedPlay(videoEl, t);
    if (Math.abs(Number(afterLeapfrog) - Number(t)) > 1e-5) {
        return afterLeapfrog;
    }

    if (guidedPlaybackState !== "playing_to_next_freeze") return t;
    var c = Number(t);
    for (var i = 0; i < freezeMarkers.length; i++) {
        var mk = freezeMarkers[i];
        if (!mk) continue;
        var s = Number(mk.start);
        var e = Number(mk.end);
        if (!isFinite(s) || !isFinite(e)) continue;
        if (c >= s - 1e-4 && c <= e + COLOR_CARD_RANGE_SKIP_EPS_SEC) {
            if (isStopFreezeMarker(mk)) {
                logPlayerMarkerDebug({
                    event: "color_card_safety_freeze_backstop",
                    freezeStopFired: true,
                    leapfrogApplied: true,
                    markerType: mk.markerType,
                    markerIndex: i,
                    insideSpanStop: true,
                    previousTime: Math.round(c * 1000) / 1000,
                });
                applyFreezeMarkerStopAtCrossing(videoEl, mk, i, t, t, "color_card_safety_inside_freeze_span");
                return t;
            }
            // pass-through (green or yellow-in-red): leapfrog and keep playing.
            handleGreenPassthroughEvent(videoEl, { marker: mk, freezeMarkerIndex: i }, c, c);
            return Number(videoEl.currentTime);
        }
    }
    return t;
}

function ensureSeekPastColorCardRanges(t) {
    var eps = COLOR_CARD_RANGE_SKIP_EPS_SEC;
    var cur = Number(t);
    if (!isFinite(cur)) return t;
    var ranges = getColorCardRangesFromWindow();
    if (!ranges.length) return cur;
    var guard = 0;
    while (guard < 48) {
        guard++;
        var moved = false;
        for (var i = 0; i < ranges.length; i++) {
            var r = ranges[i];
            if (cur >= r.start - 1e-4 && cur < r.end + eps) {
                cur = r.end + eps;
                moved = true;
                break;
            }
        }
        if (!moved) break;
    }
    return cur;
}

/** @deprecated — use ensureSeekPastColorCardRanges */
function ensureSeekPastYellowRanges(t) {
    return ensureSeekPastColorCardRanges(t);
}

function segmentContentSeekTime(seg) {
    if (!seg) return null;
    var c = seg.contentStart;
    if (c != null && c !== "" && Number.isFinite(Number(c))) return Number(c);
    return seg.src_start != null ? Number(seg.src_start) : null;
}

function segmentContentEndTime(seg) {
    if (!seg) return null;
    var c = seg.contentEnd;
    if (c != null && c !== "" && Number.isFinite(Number(c))) return Number(c);
    return seg.src_end != null ? Number(seg.src_end) : null;
}

function buildFreezeMarkerFromRange(row, markerIndex) {
    var crossAt = isFinite(row.freezeTime) ? row.freezeTime : row.start;
    return {
        markerType: row.markerType,
        semantics: "freeze",
        markerIndex: markerIndex,
        start: row.start,
        end: row.end,
        crossAt: crossAt,
        contentStart: row.contentStart,
        freezeTime: row.freezeTime,
        resumeTime: row.resumeTime,
        isFreeze: true,
        isLoop: false,
    };
}

function buildLoopMarkerFromRange(row, markerIndex, previousFreezeIdx) {
    var crossAt = row.start;
    return {
        markerType: "red",
        semantics: "loop",
        markerIndex: markerIndex,
        start: row.start,
        end: row.end,
        crossAt: crossAt,
        contentStart: row.contentStart,
        previousFreezeMarkerIndex: previousFreezeIdx,
        isFreeze: false,
        isLoop: true,
    };
}

function findPreviousFreezeMarkerIndexBeforeTime(t) {
    var best = -1;
    for (var i = 0; i < freezeMarkers.length; i++) {
        if (freezeMarkers[i].crossAt < t - 1e-4) best = i;
        else break;
    }
    return best;
}

/** Next freeze boundary strictly after playhead time (forward-only segment target). */
function findFirstFreezeMarkerIndexAfterTime(t) {
    if (!isFinite(Number(t))) return -1;
    for (var i = 0; i < freezeMarkers.length; i++) {
        if (Number(freezeMarkers[i].crossAt) > Number(t) + 1e-4) return i;
    }
    return -1;
}

/**
 * The time span a red marker loops over: from its loop-return anchor (previous freeze) to the red.
 * Yellows sitting inside this span are pass-throughs so the loop replays smoothly.
 */
function getRedLoopSpanForMarker(loopMk) {
    if (!loopMk) return null;
    var endTime = Number(loopMk.crossAt);
    var prevIdx = loopMk.previousFreezeMarkerIndex;
    var startTime = (prevIdx >= 0 && prevIdx < freezeMarkers.length)
        ? Number(freezeMarkers[prevIdx].crossAt)
        : 0;
    if (!isFinite(endTime)) return null;
    if (!isFinite(startTime)) startTime = 0;
    return { startTime: startTime, endTime: endTime };
}

/** A yellow whose crossAt falls within any red's loop span [anchor, red) -> pass-through. */
function isYellowInsideAnyRedLoop(mk) {
    if (!mk || mk.markerType !== "yellow") return false;
    var y = Number(mk.crossAt);
    if (!isFinite(y)) return false;
    for (var i = 0; i < loopMarkers.length; i++) {
        var span = getRedLoopSpanForMarker(loopMarkers[i]);
        if (!span) continue;
        if (y >= span.startTime - 1e-4 && y < span.endTime - 1e-4) return true;
    }
    return false;
}

/**
 * Only YELLOW markers OUTSIDE any red loop are genuine stops. GREEN markers, and yellows that fall
 * inside a red loop span, are pass-throughs: leapfrog the card and keep playing (greens/anchored
 * yellows remain in freezeMarkers as red loop anchors and future menu anchors).
 */
function isStopFreezeMarker(mk) {
    return !!(mk && mk.markerType === "yellow" && !mk.insideRedLoop);
}

/** Next genuine STOP (yellow) boundary strictly after playhead time — the real segment target. */
function findFirstStopMarkerIndexAfterTime(t) {
    if (!isFinite(Number(t))) return -1;
    for (var i = 0; i < freezeMarkers.length; i++) {
        if (Number(freezeMarkers[i].crossAt) > Number(t) + 1e-4 && isStopFreezeMarker(freezeMarkers[i])) {
            return i;
        }
    }
    return -1;
}

/** Nearest STOP (yellow) marker index at or before t — used to attribute paused state. */
function findPreviousStopMarkerIndexBeforeTime(t) {
    var best = -1;
    for (var i = 0; i < freezeMarkers.length; i++) {
        if (freezeMarkers[i].crossAt < Number(t) - 1e-4) {
            if (isStopFreezeMarker(freezeMarkers[i])) best = i;
        } else {
            break;
        }
    }
    return best;
}

/**
 * GREEN pass-through: leapfrog the green card and KEEP PLAYING (no pause, no state change).
 * Advances the guided cursor toward the active yellow stop target so the next event is picked up.
 */
function handleGreenPassthroughEvent(videoEl, ev, prev, t) {
    var mk = ev && ev.marker ? ev.marker : null;
    if (!mk) return;
    var past = ensureSeekPastColorCardRanges(Number(mk.end) + COLOR_CARD_RANGE_SKIP_EPS_SEC);
    logPlayerMarkerDebug({
        event: "green_passthrough_leapfrog",
        leapfrogApplied: true,
        leapfrogHelperUsed: true,
        markerType: mk.markerType || "green",
        markerSemantics: "freeze",
        markerIndex: ev.freezeMarkerIndex,
        previousTime: isFinite(Number(prev)) ? Math.round(Number(prev) * 1000) / 1000 : null,
        chosenStopPoint: isFinite(Number(mk.crossAt)) ? Math.round(Number(mk.crossAt) * 1000) / 1000 : null,
        chosenResumeTarget: isFinite(Number(past)) ? Math.round(Number(past) * 1000) / 1000 : null,
        clickAction: "green_keep_playing",
    });
    if (isFinite(Number(past)) && Number(past) > Number(videoEl.currentTime)) {
        videoEl.currentTime = Number(past);
    }
    advanceMarkerCursorToTime(Number(videoEl.currentTime));
    if (segmentTargetFreezeIdx >= 0 && segmentTargetFreezeIdx < freezeMarkers.length) {
        guidedTargetEventIdx = findNextSegmentPlaybackEventIdx(Number(videoEl.currentTime), segmentTargetFreezeIdx);
    }
    lastPlaybackTimeForMarkerCheck = Number(videoEl.currentTime);
    syncLegacyYellowMarkerAliases();
}

function buildUnifiedPlaybackEvents() {
    var events = [];
    for (var fi = 0; fi < freezeMarkers.length; fi++) {
        events.push({
            kind: "freeze",
            eventIndex: events.length,
            crossAt: freezeMarkers[fi].crossAt,
            freezeMarkerIndex: fi,
            marker: freezeMarkers[fi],
        });
    }
    for (var li = 0; li < loopMarkers.length; li++) {
        events.push({
            kind: "loop",
            eventIndex: events.length,
            crossAt: loopMarkers[li].crossAt,
            loopMarkerIndex: li,
            marker: loopMarkers[li],
        });
    }
    events.sort(function(a, b) { return a.crossAt - b.crossAt; });
    for (var ei = 0; ei < events.length; ei++) events[ei].eventIndex = ei;
    return events;
}

function loadPlaybackMarkersFromWindow() {
    freezeMarkers = [];
    loopMarkers = [];
    playbackEvents = [];
    var w = typeof window !== "undefined" ? window : null;
    if (!w) return;

    var yellowRows = [];
    if (Array.isArray(w.yellowStopMarkers) && w.yellowStopMarkers.length > 0) {
        yellowRows = w.yellowStopMarkers;
    } else if (Array.isArray(w.yellowScreenRanges)) {
        yellowRows = w.yellowScreenRanges;
    }
    for (var yi = 0; yi < yellowRows.length; yi++) {
        var yr = normalizeColorCardRangeRow(yellowRows[yi], "yellow");
        if (yr) freezeMarkers.push(buildFreezeMarkerFromRange(yr, freezeMarkers.length));
    }

    var greenRows = [];
    if (Array.isArray(w.greenStopMarkers) && w.greenStopMarkers.length > 0) {
        greenRows = w.greenStopMarkers;
    } else if (Array.isArray(w.greenScreenRanges)) {
        greenRows = w.greenScreenRanges;
    } else if (w.greenDetection && Array.isArray(w.greenDetection.events)) {
        greenRows = w.greenDetection.events;
    }
    for (var gi = 0; gi < greenRows.length; gi++) {
        var gr = normalizeColorCardRangeRow(greenRows[gi], "green");
        if (gr) freezeMarkers.push(buildFreezeMarkerFromRange(gr, freezeMarkers.length));
    }
    freezeMarkers.sort(function(a, b) { return a.crossAt - b.crossAt; });
    for (var fr = 0; fr < freezeMarkers.length; fr++) freezeMarkers[fr].markerIndex = fr;

    var redRows = [];
    if (Array.isArray(w.redStopMarkers) && w.redStopMarkers.length > 0) {
        redRows = w.redStopMarkers;
    } else if (Array.isArray(w.redScreenRanges)) {
        redRows = w.redScreenRanges;
    } else if (w.redDetection && Array.isArray(w.redDetection.events)) {
        redRows = w.redDetection.events;
    }
    for (var ri = 0; ri < redRows.length; ri++) {
        var rr = normalizeColorCardRangeRow(redRows[ri], "red");
        if (!rr) continue;
        var prevFreeze = findPreviousFreezeMarkerIndexBeforeTime(rr.start);
        loopMarkers.push(buildLoopMarkerFromRange(rr, loopMarkers.length, prevFreeze));
    }
    loopMarkers.sort(function(a, b) { return a.crossAt - b.crossAt; });
    for (var lr = 0; lr < loopMarkers.length; lr++) loopMarkers[lr].markerIndex = lr;

    // A yellow inside a red's loop span is a pass-through (acts like green), not a genuine stop.
    for (var pf = 0; pf < freezeMarkers.length; pf++) {
        freezeMarkers[pf].insideRedLoop = isYellowInsideAnyRedLoop(freezeMarkers[pf]);
    }

    // Build the green->menu seek lookup. A saved chapter selection IS the link: any entry with a
    // finite seekTime routes its menu click. byMenuId only holds rows where a chapter was selected,
    // so unmapped/"none" links fall through to the existing t=0 behavior. (confirmed/needsManualReview
    // remain optional review metadata and do not gate playback.)
    menuGreenSeekByMenuId = {};
    var gmm = w.greenMenuMapping && w.greenMenuMapping.byMenuId ? w.greenMenuMapping.byMenuId : null;
    if (gmm && typeof gmm === "object") {
        for (var mk in gmm) {
            if (!Object.prototype.hasOwnProperty.call(gmm, mk)) continue;
            var entry = gmm[mk];
            if (!entry) continue;
            var seekT = Number(entry.seekTime);
            if (isFinite(seekT)) menuGreenSeekByMenuId[mk] = seekT;
        }
    }

    playbackEvents = buildUnifiedPlaybackEvents();
    nextFreezeMarkerIdx = 0;
    nextPlaybackEventIdx = 0;
    pausedAtFreezeMarkerIdx = -1;
    currentFreezeFrameIdx = -1;
    nextFreezeFrameIdx = -1;
    segmentTargetFreezeIdx = -1;
    guidedTargetEventIdx = -1;
    activeRedLoopEventIdx = -1;
    activeRedLoopReturnTime = null;
    activeRedLoopPreviousFreezeIdx = -1;
    syncLegacyYellowMarkerAliases();
    logMarkerRuntimeInventory("load_playback_markers");
}

function logMarkerRuntimeInventory(reason) {
    var w = typeof window !== "undefined" ? window : null;
    var yellowSource = "none";
    var greenSource = "none";
    var redSource = "none";
    var yellowRaw = 0;
    var greenRaw = 0;
    var redRaw = 0;
    if (w) {
        if (Array.isArray(w.yellowStopMarkers) && w.yellowStopMarkers.length > 0) {
            yellowSource = "yellowStopMarkers";
            yellowRaw = w.yellowStopMarkers.length;
        } else if (Array.isArray(w.yellowScreenRanges) && w.yellowScreenRanges.length > 0) {
            yellowSource = "yellowScreenRanges";
            yellowRaw = w.yellowScreenRanges.length;
        }
        if (Array.isArray(w.greenStopMarkers) && w.greenStopMarkers.length > 0) {
            greenSource = "greenStopMarkers";
            greenRaw = w.greenStopMarkers.length;
        } else if (Array.isArray(w.greenScreenRanges) && w.greenScreenRanges.length > 0) {
            greenSource = "greenScreenRanges";
            greenRaw = w.greenScreenRanges.length;
        } else if (w.greenDetection && Array.isArray(w.greenDetection.events)) {
            greenSource = "greenDetection.events";
            greenRaw = w.greenDetection.events.length;
        }
        if (Array.isArray(w.redStopMarkers) && w.redStopMarkers.length > 0) {
            redSource = "redStopMarkers";
            redRaw = w.redStopMarkers.length;
        } else if (w.redDetection && Array.isArray(w.redDetection.events) && w.redDetection.events.length > 0) {
            redSource = "redDetection.events";
            redRaw = w.redDetection.events.length;
        }
    }
    var yellowFreeze = 0;
    var greenFreeze = 0;
    for (var fi = 0; fi < freezeMarkers.length; fi++) {
        if (freezeMarkers[fi].markerType === "yellow") yellowFreeze++;
        if (freezeMarkers[fi].markerType === "green") greenFreeze++;
    }
    var nextEv = guidedTargetEventIdx >= 0 && guidedTargetEventIdx < playbackEvents.length
        ? playbackEvents[guidedTargetEventIdx] : (nextPlaybackEventIdx >= 0 && nextPlaybackEventIdx < playbackEvents.length
            ? playbackEvents[nextPlaybackEventIdx] : null);
    var snapshot = {
        reason: reason || null,
        chapterRowCount: Array.isArray(srcArray) ? srcArray.length : 0,
        windowYellowSource: yellowSource,
        windowYellowRawCount: yellowRaw,
        windowGreenSource: greenSource,
        windowGreenRawCount: greenRaw,
        windowRedSource: redSource,
        windowRedRawCount: redRaw,
        runtimeFreezeMarkerCount: freezeMarkers.length,
        runtimeYellowFreezeCount: yellowFreeze,
        runtimeGreenFreezeCount: greenFreeze,
        runtimeLoopMarkerCount: loopMarkers.length,
        runtimePlaybackEventCount: playbackEvents.length,
        nextTargetEventIndex: guidedTargetEventIdx >= 0 ? guidedTargetEventIdx : nextPlaybackEventIdx,
        nextTargetKind: nextEv ? nextEv.kind : null,
        nextTargetMarkerType: nextEv && nextEv.marker ? nextEv.marker.markerType : null,
        nextTargetCrossAt: nextEv && isFinite(Number(nextEv.crossAt))
            ? Math.round(Number(nextEv.crossAt) * 1000) / 1000 : null,
        currentFreezeFrameIndex: currentFreezeFrameIdx,
        nextFreezeFrameIndex: nextFreezeFrameIdx,
        segmentTargetFreezeIndex: segmentTargetFreezeIdx,
        guidedPlaybackState: guidedPlaybackState,
    };
    if (typeof window !== "undefined") window.__playerMarkerRuntimeSnapshot = snapshot;
    logPlayerMarkerDebug({ event: "marker_runtime_inventory", inventory: snapshot });
}

/** @deprecated — use loadPlaybackMarkersFromWindow */
function loadYellowMarkersFromWindow() {
    loadPlaybackMarkersFromWindow();
}

function advanceMarkerCursorToTime(t) {
    recomputeMarkerRuntimeFromTime(t, null);
}

function setGuidedPlaybackState(nextState, reason) {
    guidedPlaybackState = nextState;
    var ctrl = getInteractiveControlSnapshot();
    logPlayerMarkerDebug({
        event: "state",
        reason: reason || null,
        currentFreezeFrameIndex: currentFreezeFrameIdx,
        nextFreezeFrameIndex: nextFreezeFrameIdx,
        segmentTargetFreezeIndex: segmentTargetFreezeIdx,
        controlsEnabled: ctrl.controlsEnabled,
        controlsDisabled: ctrl.controlsDisabled,
        inVideoClickAllowed: ctrl.inVideoClickAllowed,
    });
}

/**
 * Which freeze boundary the playhead is on (post-freeze content), not a chapter row.
 */
function findFreezeFrameIndexAtTime(t) {
    if (!isFinite(Number(t)) || freezeMarkers.length === 0) return -1;
    var best = -1;
    var bestPost = -Infinity;
    for (var i = 0; i < freezeMarkers.length; i++) {
        var post = resolvePostFreezeStopTime(freezeMarkers[i], i, "locate_freeze_at_time");
        if (!isFinite(Number(post))) continue;
        if (Number(post) <= Number(t) + 0.25 && Number(post) >= bestPost) {
            bestPost = Number(post);
            best = i;
        }
    }
    return best;
}

function findNextSegmentPlaybackEventIdx(t, targetFreezeIdx) {
    if (targetFreezeIdx < 0 || targetFreezeIdx >= freezeMarkers.length) return -1;
    var targetCross = Number(freezeMarkers[targetFreezeIdx].crossAt);
    if (!isFinite(targetCross)) return -1;
    for (var i = nextPlaybackEventIdx; i < playbackEvents.length; i++) {
        var ev = playbackEvents[i];
        var cross = Number(ev.crossAt);
        if (!isFinite(cross) || cross < Number(t) - 1e-4) continue;
        if (cross > targetCross + 1e-4) break;
        if (ev.kind === "loop") return i;
        if (ev.kind === "freeze") return i;
    }
    return -1;
}

/** Advance only past freeze boundaries strictly before the active segment (never skip target freeze). */
function advancePastSkippedFreezeEventsInSegment(t) {
    if (segmentTargetFreezeIdx < 0) return;
    while (guidedTargetEventIdx >= 0 && guidedTargetEventIdx < playbackEvents.length) {
        var ev = playbackEvents[guidedTargetEventIdx];
        if (ev.kind === "freeze" && ev.freezeMarkerIndex < currentFreezeFrameIdx) {
            if (Number(t) >= Number(ev.crossAt) - 1e-4) {
                guidedTargetEventIdx++;
                nextPlaybackEventIdx = guidedTargetEventIdx;
                continue;
            }
        }
        break;
    }
    syncLegacyYellowMarkerAliases();
}

/** Resolve segment target freeze when play() guard cleared segmentTargetFreezeIdx. */
function resolveActiveSegmentTargetFreezeIdx(prev, t) {
    if (segmentTargetFreezeIdx >= 0 && segmentTargetFreezeIdx < freezeMarkers.length) {
        return segmentTargetFreezeIdx;
    }
    if (guidedPlaybackState !== "playing_to_next_freeze") return -1;
    var fromTime = isFinite(Number(prev)) ? Number(prev) : (isFinite(Number(t)) ? Number(t) : 0);
    // Target the next genuine STOP (yellow); greens are pass-throughs and never segment targets.
    var idx = findFirstStopMarkerIndexAfterTime(fromTime);
    if (idx < 0 && nextFreezeMarkerIdx >= 0 && nextFreezeMarkerIdx < freezeMarkers.length &&
        isStopFreezeMarker(freezeMarkers[nextFreezeMarkerIdx])) {
        idx = nextFreezeMarkerIdx;
    }
    return idx;
}

/**
 * Segment runtime: reaching the target freeze control span (yellow or green) ends the segment
 * immediately — resolve post-marker instructional frame and pause (leapfrog, not play-through).
 */
function tryCommitSegmentTargetFreezeStop(videoEl, prev, t) {
    if (guidedPlaybackState !== "playing_to_next_freeze") return false;
    if (!videoEl || !isFinite(Number(prev)) || !isFinite(Number(t))) return false;
    var idx = resolveActiveSegmentTargetFreezeIdx(prev, t);
    if (idx < 0 || idx >= freezeMarkers.length) return false;
    if (segmentTargetFreezeIdx < 0) {
        segmentTargetFreezeIdx = idx;
        nextFreezeFrameIdx = idx;
        guidedTargetEventIdx = findNextSegmentPlaybackEventIdx(Number(prev), idx);
        syncLegacyYellowMarkerAliases();
        logPlayerMarkerDebug({
            event: "segment_target_recovered",
            segmentTargetFreezeIndex: idx,
            guidedTargetEventIndex: guidedTargetEventIdx,
            reason: "missing_segment_target_during_play",
        });
    }
    var mk = freezeMarkers[idx];
    if (!mk) return false;
    // Defensive: only YELLOW is a genuine stop. If the target somehow resolved to a green
    // pass-through, re-target the next yellow and let the leapfrog paths skip the green.
    if (!isStopFreezeMarker(mk)) {
        var ny = findFirstStopMarkerIndexAfterTime(Number(t));
        segmentTargetFreezeIdx = ny;
        nextFreezeFrameIdx = ny;
        if (ny >= 0) guidedTargetEventIdx = findNextSegmentPlaybackEventIdx(Number(t), ny);
        return false;
    }
    var p = Number(prev);
    var c = Number(t);
    var spanStart = Number(mk.start);
    var spanEnd = Number(mk.end);
    var crossAt = Number(mk.crossAt);
    if (!isFinite(spanStart) || !isFinite(spanEnd)) return false;

    var enteredControlSpan = p < spanStart - 1e-4 && c >= spanStart - 1e-4;
    var insideControlSpan = c >= spanStart - 1e-4 && c <= spanEnd + COLOR_CARD_RANGE_SKIP_EPS_SEC;
    var crossedFreezeTrigger = isFinite(crossAt) && p < crossAt - 1e-4 && c >= crossAt - 1e-4;
    var coarseJumpIntoSpan = p < spanStart - 1e-4 && insideControlSpan;
    if (!enteredControlSpan && !insideControlSpan && !crossedFreezeTrigger && !coarseJumpIntoSpan) {
        return false;
    }

    var resolvedStop = resolvePostFreezeStopTime(mk, idx, "segment_target_freeze_span");
    logPlayerMarkerDebug({
        event: "freeze_span_stop",
        freezeStopFired: true,
        leapfrogApplied: true,
        markerType: mk.markerType,
        markerIndex: idx,
        segmentTargetFreezeIndex: idx,
        chosenStopPoint: isFinite(crossAt) ? Math.round(crossAt * 1000) / 1000 : null,
        chosenResumeTarget: isFinite(Number(resolvedStop))
            ? Math.round(Number(resolvedStop) * 1000) / 1000 : null,
        previousTime: Math.round(p * 1000) / 1000,
        currentTime: Math.round(c * 1000) / 1000,
    });
    applyFreezeMarkerStopAtCrossing(videoEl, mk, idx, prev, t, "segment_target_freeze_span");
    return true;
}

/**
 * CLICK semantics: play from current freeze-frame boundary to the next freeze-frame boundary.
 * Red markers in between trigger loop-back; they are not segment endpoints.
 */
function beginPlayToNextFreezeFrame(reason) {
    if (!CONTINUOUS_VIDEO_PLAYBACK) return;
    if (freezeMarkers.length === 0) {
        setGuidedPlaybackState("completed", reason || "no_freeze_markers");
        if (typeof videoId !== "undefined" && videoId) {
            try { videoId.pause(); } catch (noMkErr) { console.log(noMkErr); }
        }
        return;
    }
    var t = Number(videoId.currentTime);
    if (!isFinite(t)) t = 0;
    recomputeMarkerRuntimeFromTime(t, reason || "begin_play_segment");
    var fromIdx = pausedAtFreezeMarkerIdx >= 0 ? pausedAtFreezeMarkerIdx : -1;
    if (fromIdx < 0) {
        fromIdx = findPreviousFreezeMarkerIndexBeforeTime(t + 0.001);
    }
    // Segment target is the next genuine STOP (yellow). Greens between here and there are
    // pass-throughs that leapfrog and keep playing; reds between trigger loops.
    var nextIdx = findFirstStopMarkerIndexAfterTime(t);
    currentFreezeFrameIdx = fromIdx;
    pausedAtFreezeMarkerIdx = -1;
    syncLegacyYellowMarkerAliases();

    if (nextIdx < 0 || nextIdx >= freezeMarkers.length) {
        segmentTargetFreezeIdx = -1;
        nextFreezeFrameIdx = -1;
        guidedTargetEventIdx = -1;
        activeRedLoopEventIdx = -1;
        activeRedLoopReturnTime = null;
        activeRedLoopPreviousFreezeIdx = -1;
        setGuidedPlaybackState("completed", reason || "play_past_last_freeze");
        logPlayerMarkerDebug({
            event: "play_segment_no_next_freeze",
            reason: reason || null,
            currentFreezeFrameIndex: currentFreezeFrameIdx,
        });
        if (typeof videoId !== "undefined" && videoId) {
            try { videoId.pause(); } catch (pastLastErr) { console.log(pastLastErr); }
        }
        return;
    }

    segmentTargetFreezeIdx = nextIdx;
    nextFreezeFrameIdx = nextIdx;
    activeRedLoopEventIdx = -1;
    activeRedLoopReturnTime = null;
    activeRedLoopPreviousFreezeIdx = -1;
    guidedTargetEventIdx = findNextSegmentPlaybackEventIdx(t, nextIdx);
    setGuidedPlaybackState("playing_to_next_freeze", reason || "play_to_next_freeze");
    var targetMk = freezeMarkers[nextIdx];
    logPlayerMarkerDebug({
        event: "play_segment_start",
        reason: reason || null,
        currentFreezeFrameIndex: currentFreezeFrameIdx,
        nextFreezeFrameIndex: nextFreezeFrameIdx,
        segmentTargetFreezeIndex: segmentTargetFreezeIdx,
        markerType: targetMk ? targetMk.markerType : null,
        markerSemantics: "freeze",
        chosenStopPoint: targetMk ? Math.round(Number(targetMk.crossAt) * 1000) / 1000 : null,
        guidedTargetEventIndex: guidedTargetEventIdx,
        clickAction: "play_current_freeze_to_next_freeze",
    });
    syncLegacyYellowMarkerAliases();
}

/**
 * BACK button: teleport to the previous yellow/green freeze anchor and resume the existing play
 * logic (greens / yellow-in-red pass through, a red ahead loops, stops at the next genuine yellow).
 * No forced pause. Repeated presses step backward one anchor at a time; before the first anchor it
 * restarts the lesson at 0.
 */
function goBackToPreviousFreezeAndPlay(reason) {
    if (!CONTINUOUS_VIDEO_PLAYBACK || typeof videoId === "undefined" || !videoId) {
        backSlide();
        return;
    }
    if (freezeMarkers.length === 0) {
        backSlide();
        return;
    }
    var t = Number(videoId.currentTime);
    if (!isFinite(t)) t = 0;
    // Anchor we are currently on (segment start / paused freeze / loop anchor).
    var anchor = pausedAtFreezeMarkerIdx >= 0
        ? pausedAtFreezeMarkerIdx
        : (currentFreezeFrameIdx >= 0 ? currentFreezeFrameIdx : findPreviousFreezeMarkerIndexBeforeTime(t + 0.05));
    var backIdx = anchor - 1; // the previous yellow/green frame

    // Clear any active loop / pause so the teleport starts clean.
    activeRedLoopEventIdx = -1;
    activeRedLoopReturnTime = null;
    activeRedLoopPreviousFreezeIdx = -1;
    pausedAtFreezeMarkerIdx = -1;

    if (backIdx < 0) {
        currentFreezeFrameIdx = -1;
        syncVideoSeekWithMarkerState(videoId, 0, reason || "back_to_start");
        beginPlayToNextFreezeFrame(reason || "back_to_start");
        logPlayerMarkerDebug({
            event: "back_to_prev_freeze",
            clickBranchTaken: "back_to_lesson_start",
            chosenResumePoint: 0,
            clickAction: "back_teleport_and_play",
        });
        try { videoId.play(); } catch (e) { console.log(e); }
        return;
    }

    var mk = freezeMarkers[backIdx];
    var resume = resolvePostFreezeStopTime(mk, backIdx, reason || "back_to_prev_freeze");
    currentFreezeFrameIdx = backIdx;
    if (isFinite(Number(resume))) {
        syncVideoSeekWithMarkerState(videoId, Number(resume), reason || "back_to_prev_freeze");
    }
    beginPlayToNextFreezeFrame(reason || "back_to_prev_freeze");
    logPlayerMarkerDebug({
        event: "back_to_prev_freeze",
        clickBranchTaken: "back_to_previous_anchor",
        markerType: mk ? mk.markerType : null,
        markerSemantics: "freeze",
        markerIndex: backIdx,
        chosenResumePoint: isFinite(Number(resume)) ? Math.round(Number(resume) * 1000) / 1000 : null,
        clickAction: "back_teleport_and_play",
    });
    try { videoId.play(); } catch (e2) { console.log(e2); }
}

function beginPlayToNextEvent(reason) {
    beginPlayToNextFreezeFrame(reason);
}

/** @deprecated — use beginPlayToNextEvent */
function beginPlayToNextMarker(reason) {
    beginPlayToNextEvent(reason);
}

function nearestPlaybackEventInfoAtTime(t) {
    if (!Array.isArray(playbackEvents) || playbackEvents.length === 0 || !isFinite(Number(t))) return null;
    var bestIdx = -1;
    var bestDist = Infinity;
    for (var i = 0; i < playbackEvents.length; i++) {
        var ev = playbackEvents[i];
        var d = Math.abs(Number(ev.crossAt) - Number(t));
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }
    if (bestIdx < 0) return null;
    var best = playbackEvents[bestIdx];
    return {
        eventIndex: best.eventIndex,
        semantics: best.kind,
        markerType: best.marker && best.marker.markerType ? best.marker.markerType : null,
        markerIndex: best.kind === "freeze" ? best.freezeMarkerIndex : (best.kind === "loop" ? best.loopMarkerIndex : null),
        crossAt: isFinite(Number(best.crossAt)) ? Math.round(Number(best.crossAt) * 1000) / 1000 : null,
        deltaSec: isFinite(Number(bestDist)) ? Math.round(Number(bestDist) * 1000) / 1000 : null,
    };
}

function resolvePostFreezeStopTime(marker, markerIndex, logReason) {
    if (!marker) return null;
    var base = Number(marker.end) + COLOR_CARD_RANGE_SKIP_EPS_SEC;
    if (marker.markerType === "green") {
        if (marker.resumeTime != null && isFinite(Number(marker.resumeTime)) &&
            Number(marker.resumeTime) >= marker.end) {
            base = Number(marker.resumeTime) + COLOR_CARD_RANGE_SKIP_EPS_SEC;
        }
        if (marker.contentStart != null && isFinite(Number(marker.contentStart)) &&
            Number(marker.contentStart) > base) {
            base = Number(marker.contentStart);
        }
    } else if (marker.contentStart != null && isFinite(Number(marker.contentStart)) &&
        Number(marker.contentStart) > marker.end) {
        base = Number(marker.contentStart);
    }
    var resolved = ensureSeekPastColorCardRanges(base);
    if (marker.markerType === "green" && isFinite(Number(marker.start)) && isFinite(Number(marker.end))) {
        var pastGreenSpan = Number(marker.end) + COLOR_CARD_RANGE_SKIP_EPS_SEC;
        if (resolved < pastGreenSpan) resolved = pastGreenSpan;
        resolved = ensureSeekPastColorCardRanges(resolved);
    }
    var leapfrogAdjusted = Math.abs(resolved - base) > 1e-6;
    // "locate_freeze_at_time" is a pure read-only locator that runs for EVERY freeze marker on
    // EVERY timeupdate (27+ calls/tick) — skip its log so real fire events stay readable.
    if (logReason !== "locate_freeze_at_time") {
        logPlayerMarkerDebug({
            event: "resolved_post_freeze_target",
            reason: logReason || null,
            markerType: marker.markerType,
            markerSemantics: marker.semantics,
            markerIndex: markerIndex,
            isFreeze: true,
            isLoop: false,
            chosenStopPoint: Math.round(Number(marker.crossAt) * 1000) / 1000,
            chosenResumePoint: Math.round(Number(resolved) * 1000) / 1000,
            resolvedPostMarkerContentPoint: Math.round(Number(resolved) * 1000) / 1000,
            leapfrogHelperUsed: leapfrogAdjusted,
            clickAction: guidedPlaybackState === "paused_at_freeze" ? "resume_past_freeze_card" : "n/a",
        });
    }
    tensegrityPlayerDebugLog({
        event: "resolve_post_freeze",
        reason: logReason || null,
        markerIndex: markerIndex,
        markerType: marker.markerType,
        spanStart: Math.round(Number(marker.start) * 1000) / 1000,
        spanEnd: Math.round(Number(marker.end) * 1000) / 1000,
        contentStart: marker.contentStart != null && isFinite(Number(marker.contentStart))
            ? Math.round(Number(marker.contentStart) * 1000) / 1000 : null,
        chosenSeekAfterEndPlusEps: Math.round(base * 1000) / 1000,
        resolvedPostMarkerTarget: Math.round(Number(resolved) * 1000) / 1000,
        resolvedKind: tensegrityClassifyStopTarget(resolved, marker),
        leapfrogAdjusted: leapfrogAdjusted,
    });
    return resolved;
}

/** @deprecated — use resolvePostFreezeStopTime */
function resolvePostYellowStopTime(marker, markerIndex, logReason) {
    return resolvePostFreezeStopTime(marker, markerIndex, logReason);
}

function getLoopReturnTimeForRedMarker(loopMarker) {
    if (!loopMarker) return null;
    var prevIdx = loopMarker.previousFreezeMarkerIndex;
    if (prevIdx < 0 || prevIdx >= freezeMarkers.length) {
        var resolvedFallback = ensureSeekPastColorCardRanges(loopMarker.start);
        logPlayerMarkerDebug({
            event: "loop_return_no_previous_freeze",
            markerType: "red",
            markerSemantics: "loop",
            markerIndex: loopMarker.markerIndex,
            previousFreezeMarkerIndex: prevIdx,
            chosenResumePoint: Math.round(Number(resolvedFallback) * 1000) / 1000,
            clickAction: "break_loop_on_click",
        });
        return resolvedFallback;
    }
    return resolvePostFreezeStopTime(freezeMarkers[prevIdx], prevIdx, "red_loop_return");
}

/**
 * Single freeze stop path for autoplay and click/resume (resolve post-marker, seek, pause).
 */
function applyFreezeMarkerStopAtCrossing(videoEl, mk, freezeIdx, prev, t, reason) {
    var resolvedStop = resolvePostFreezeStopTime(mk, freezeIdx, reason || "marker_crossing_pause");
    var stopTarget = isFinite(Number(resolvedStop)) ? Number(resolvedStop) : (mk.end + COLOR_CARD_RANGE_SKIP_EPS_SEC);
    videoEl.currentTime = stopTarget;
    try {
        videoEl.pause();
    } catch (pauseErr) { console.log(pauseErr); }
    var pauseConfirmed = videoEl.paused === true;
    pausedAtFreezeMarkerIdx = freezeIdx;
    currentFreezeFrameIdx = freezeIdx;
    nextFreezeFrameIdx = -1;
    segmentTargetFreezeIdx = -1;
    guidedTargetEventIdx = -1;
    setGuidedPlaybackState("paused_at_freeze", "freeze_marker_reached");
    logPlayerMarkerDebug({
        event: "marker_pause_fired",
        reason: reason || null,
        markerType: mk.markerType,
        markerSemantics: "freeze",
        markerIndex: freezeIdx,
        isFreeze: true,
        isLoop: false,
        freezeStopFired: true,
        leapfrogApplied: true,
        chosenStopPoint: Math.round(Number(mk.crossAt) * 1000) / 1000,
        chosenResumeTarget: Math.round(Number(stopTarget) * 1000) / 1000,
        chosenResumePoint: Math.round(Number(stopTarget) * 1000) / 1000,
        resolvedPostMarkerContentPoint: Math.round(Number(stopTarget) * 1000) / 1000,
        leapfrogHelperUsed: true,
        pauseExecuted: pauseConfirmed,
        clickAction: "resume_past_freeze_card",
        previousFreezeMarkerIndex: null,
    });
    tensegrityPlayerDebugLog({
        event: "marker_pause_detail",
        mode: guidedPlaybackState,
        markerIndex: pausedAtFreezeMarkerIdx,
        markerType: mk.markerType,
        spanStart: Math.round(Number(mk.start) * 1000) / 1000,
        spanEnd: Math.round(Number(mk.end) * 1000) / 1000,
        contentStart: mk.contentStart != null && isFinite(Number(mk.contentStart))
            ? Math.round(Number(mk.contentStart) * 1000) / 1000 : null,
        previousTime: Math.round(prev * 1000) / 1000,
        currentTimeBeforePause: Math.round(Number(t) * 1000) / 1000,
        crossedStartCondition: true,
        pauseFired: true,
        actualStopTarget: Math.round(Number(stopTarget) * 1000) / 1000,
        stopTargetKind: tensegrityClassifyStopTarget(stopTarget, mk),
    });
    runTensegrityTimeupdateDiagnostics(videoEl, prev, t, mk, true, true);
    lastPlaybackTimeForMarkerCheck = Number(stopTarget);
    recomputeMarkerRuntimeFromTime(Number(stopTarget), "freeze_stop_committed");
    syncLegacyYellowMarkerAliases();
}

function handleFreezeMarkerCrossing(videoEl, mk, freezeIdx, prev, t) {
    applyFreezeMarkerStopAtCrossing(videoEl, mk, freezeIdx, prev, t, "marker_crossing_pause");
}

function handleRedLoopMarkerCrossing(videoEl, loopMk, loopIdx, prev, t) {
    var returnTime = getLoopReturnTimeForRedMarker(loopMk);
    if (!isFinite(Number(returnTime))) return;
    var pastRed = ensureSeekPastColorCardRanges(loopMk.end + COLOR_CARD_RANGE_SKIP_EPS_SEC);
    activeRedLoopEventIdx = loopIdx;
    activeRedLoopReturnTime = Number(returnTime);
    activeRedLoopPreviousFreezeIdx = loopMk.previousFreezeMarkerIndex;
    videoEl.currentTime = Number(returnTime);
    setGuidedPlaybackState("looping_at_red", "red_loop_entered");
    logPlayerMarkerDebug({
        event: "red_loop_entered",
        markerType: "red",
        markerSemantics: "loop",
        markerIndex: loopIdx,
        isFreeze: false,
        isLoop: true,
        chosenStopPoint: Math.round(Number(loopMk.crossAt) * 1000) / 1000,
        chosenResumePoint: Math.round(Number(returnTime) * 1000) / 1000,
        resolvedPostMarkerContentPoint: Math.round(Number(pastRed) * 1000) / 1000,
        leapfrogHelperUsed: true,
        previousFreezeMarkerIndex: loopMk.previousFreezeMarkerIndex,
        clickAction: "break_loop_and_resume_past_red",
    });
    guidedTargetEventIdx = (guidedTargetEventIdx >= 0) ? guidedTargetEventIdx + 1 : nextPlaybackEventIdx;
    nextPlaybackEventIdx = guidedTargetEventIdx;
    lastPlaybackTimeForMarkerCheck = Number(returnTime);
    syncLegacyYellowMarkerAliases();
}

function classifyGuidedEventTrigger(ev, prev, t) {
    if (!ev || !isFinite(Number(t))) return { shouldFire: false, reason: "invalid_event_or_time" };
    var crossAt = Number(ev.crossAt);
    if (!isFinite(crossAt)) return { shouldFire: false, reason: "invalid_cross_at" };
    if (Number(t) < crossAt) return { shouldFire: false, reason: "before_cross_at" };

    var eps = COLOR_CARD_RANGE_SKIP_EPS_SEC;
    var mk = ev.marker || null;
    var mkEnd = mk && isFinite(Number(mk.end)) ? Number(mk.end) : crossAt;
    var prevNum = Number(prev);
    var hasPrev = isFinite(prevNum);
    var crossedByPrev = hasPrev && prevNum < crossAt && Number(t) >= crossAt;
    if (crossedByPrev) return { shouldFire: true, reason: "crossed_by_prev_sample" };

    // If no prior sample or coarse sampling landed us on/near marker zone, still fire.
    if (!hasPrev) return { shouldFire: true, reason: "no_prev_sample_at_or_past_cross_at" };
    if (prevNum <= mkEnd + eps && Number(t) >= crossAt) {
        return { shouldFire: true, reason: "reached_marker_without_clean_prev_cross_sample" };
    }

    // Target is stale (we are already clearly past this marker from prior ticks).
    return { shouldFire: false, reason: "stale_target_already_past_marker" };
}

function breakRedLoopAndResumePastRed(reason) {
    if (activeRedLoopEventIdx < 0 || activeRedLoopEventIdx >= loopMarkers.length) {
        try { videoId.play(); } catch (e) { console.log(e); }
        return;
    }
    var loopMk = loopMarkers[activeRedLoopEventIdx];
    var resumeTarget = ensureSeekPastColorCardRanges(loopMk.end + COLOR_CARD_RANGE_SKIP_EPS_SEC);
    var savedSegmentTarget = segmentTargetFreezeIdx;
    activeRedLoopEventIdx = -1;
    activeRedLoopReturnTime = null;
    activeRedLoopPreviousFreezeIdx = -1;
    syncVideoSeekWithMarkerState(videoId, Number(resumeTarget), reason || "break_red_loop");
    if (savedSegmentTarget >= 0 && savedSegmentTarget < freezeMarkers.length) {
        segmentTargetFreezeIdx = savedSegmentTarget;
        nextFreezeFrameIdx = savedSegmentTarget;
        guidedTargetEventIdx = findNextSegmentPlaybackEventIdx(Number(resumeTarget), savedSegmentTarget);
        setGuidedPlaybackState("playing_to_next_freeze", reason || "break_red_loop");
    } else {
        beginPlayToNextFreezeFrame(reason || "break_red_loop");
    }
    logPlayerMarkerDebug({
        event: "red_loop_broken",
        markerType: "red",
        markerSemantics: "loop",
        chosenResumePoint: Math.round(Number(resumeTarget) * 1000) / 1000,
        resolvedPostMarkerContentPoint: Math.round(Number(resumeTarget) * 1000) / 1000,
        leapfrogHelperUsed: true,
        clickAction: "resume_after_loop_break",
    });
    try { videoId.play(); } catch (e2) { console.log(e2); }
}

// Initialize function - called after timeline array is loaded from Firestore
function initializePlayer(videoUrl, timelineArray) {
    srcArray = Array.isArray(timelineArray) ? timelineArray : [];
    window.srcArray = srcArray;
    window.videoUrl = videoUrl;  // make video globally accessible
    warnedInvalidSlide = {};

    // Set the video source
    document.getElementById("videoId").src = videoUrl;
    
    lastSlide = srcArray.length; // see note below
    // Pause all videos upon loading
    videoId.pause();
    loadPlaybackMarkersFromWindow();
    legacyChapterPlayerOverride = shouldUseLegacyChapterPlayerOverride();
    if (legacyChapterPlayerOverride) {
        CONTINUOUS_VIDEO_PLAYBACK = false;
        PAUSE_AT_FREEZE_MARKERS = false;
        PAUSE_AT_YELLOW_MARKERS = false;
        logPlayerMarkerDebug({
            event: "legacy_chapter_player_override_enabled",
            reason: "lesson_specific_override",
            lessonPath: (typeof location !== "undefined" && location.pathname) ? location.pathname : null,
        });
    }
    tensegrityDebugLastTimeupdateMs = 0;
    tensegrityDebugLastRoutineWallMs = 0;
    tensegrityDumpMarkersContext("initialize_player");
    lastPlaybackTimeForMarkerCheck = null;
    if (typeof window !== "undefined" && typeof window.pauseAtFreezeMarkersEnabled === "boolean") {
        PAUSE_AT_FREEZE_MARKERS = window.pauseAtFreezeMarkersEnabled;
    } else if (typeof window !== "undefined" && typeof window.pauseAtYellowMarkersEnabled === "boolean") {
        PAUSE_AT_FREEZE_MARKERS = window.pauseAtYellowMarkersEnabled;
    } else {
        PAUSE_AT_FREEZE_MARKERS = true;
    }
    // Interactive marker runtime always requires freeze stops when marker data is present.
    if (CONTINUOUS_VIDEO_PLAYBACK && playbackEvents.length > 0 && !PAUSE_AT_FREEZE_MARKERS) {
        PAUSE_AT_FREEZE_MARKERS = true;
        logPlayerMarkerDebug({
            event: "freeze_pause_forced_on",
            reason: "interactive_marker_runtime",
        });
    }
    PAUSE_AT_YELLOW_MARKERS = PAUSE_AT_FREEZE_MARKERS;
    logPlayerMarkerDebug({
        event: "markers_loaded",
        reason: "initialize_player",
        freezeMarkerCount: freezeMarkers.length,
        loopMarkerCount: loopMarkers.length,
        playbackEventCount: playbackEvents.length,
        forceFirstChapterStartAtZero: shouldForceFirstChapterStartAtZero(),
    });

    // Startup diagnostic: confirm which playback path is active and whether the lesson
    // actually delivered markers to the player (helps verify wiped/regenerated lesson data).
    try {
        var wDiag = typeof window !== "undefined" ? window : {};
        var winCount = function (arr) { return Array.isArray(arr) ? arr.length : 0; };
        var yellowFreezeCount = 0;
        var greenFreezeCount = 0;
        for (var di = 0; di < freezeMarkers.length; di++) {
            if (freezeMarkers[di].markerType === "yellow") yellowFreezeCount++;
            else if (freezeMarkers[di].markerType === "green") greenFreezeCount++;
        }
        console.info("[player] playback mode:", {
            legacyOverride: legacyChapterPlayerOverride === true,
            CONTINUOUS_VIDEO_PLAYBACK: CONTINUOUS_VIDEO_PLAYBACK === true,
            PAUSE_AT_FREEZE_MARKERS: PAUSE_AT_FREEZE_MARKERS === true,
            freezeMarkerCount: freezeMarkers.length,
            yellowFreezeCount: yellowFreezeCount,
            greenFreezeCount: greenFreezeCount,
            loopMarkerCount: loopMarkers.length,
            playbackEventCount: playbackEvents.length,
            windowYellowStopMarkers: winCount(wDiag.yellowStopMarkers),
            windowGreenStopMarkers: winCount(wDiag.greenStopMarkers),
            windowRedStopMarkers: winCount(wDiag.redStopMarkers),
            srcArrayRows: Array.isArray(srcArray) ? srcArray.length : 0,
        });
    } catch (diagErr) { /* diagnostics must never break init */ }

    // Marker debug overlay (notifier + timeline strip), only when ?debugMarkers=1 / window.DEBUG_MARKERS.
    if (markerDebugOverlayEnabled()) {
        try {
            ensureMarkerDebugOverlay();
            renderMarkerDebugStrip();
            if (typeof videoId !== "undefined" && videoId && !videoId.__markerDebugMetaBound) {
                videoId.addEventListener("loadedmetadata", function () {
                    try { renderMarkerDebugStrip(); } catch (e) { /* ignore */ }
                });
                videoId.__markerDebugMetaBound = true;
            }
        } catch (overlayErr) { /* overlay must never break init */ }
    }

    // Color-card mask: hide the brief color-card flash during marker-driven seeks.
    if (cardMaskEnabled()) {
        try { startCardMask(); } catch (maskErr) { /* mask must never break init */ }
    }

    setGuidedPlaybackState("idle", "initialize");

    // Runtime-owned click wiring so in-video clicks always reach nextSlide()
    // even when a lesson template's inline onclick path is missing/broken.
    if (!videoId.__interactiveClickBound) {
        videoId.addEventListener("click", function(evt) {
            if (evt && typeof evt.stopPropagation === "function") evt.stopPropagation();
            if (!isActionableInVideoClick(evt)) return;
            nextSlide(evt);
        });
        videoId.__interactiveClickBound = true;
    }
    var animContainer = document.getElementById("animation");
    if (animContainer && !animContainer.__interactiveClickBound) {
        animContainer.addEventListener("click", function(evt) {
            if (!isActionableInVideoClick(evt)) return;
            nextSlide(evt);
        });
        animContainer.__interactiveClickBound = true;
    }
    // Marker-aware Back button: teleport to the previous yellow/green anchor and resume play logic.
    if (CONTINUOUS_VIDEO_PLAYBACK) {
        var backBtn = document.getElementById("btnBack");
        if (backBtn && !backBtn.__interactiveBackBound) {
            backBtn.addEventListener("click", function (evt) {
                if (evt && typeof evt.stopPropagation === "function") evt.stopPropagation();
                goBackToPreviousFreezeAndPlay("back_button_click");
            });
            backBtn.__interactiveBackBound = true;
        }
        // Record which menu button was clicked (capture phase, before per-lesson handlers set
        // currentSlide) so updateVideoId can route a confirmed green->menu link to its timestamp.
        var menuPage = document.getElementById("lessonMenuPage");
        if (menuPage && !menuPage.__menuMapBound) {
            menuPage.addEventListener("click", function (evt) {
                var btn = evt && evt.target && evt.target.closest ? evt.target.closest("button[id^='menu']") : null;
                lastClickedMenuId = btn && btn.id ? btn.id : null;
            }, true);
            menuPage.__menuMapBound = true;
        }
    }

    videoId.addEventListener("play", function() {
        if (!CONTINUOUS_VIDEO_PLAYBACK) return;
        if (pendingForcedLessonStartAtZero) {
            pendingForcedLessonStartAtZero = false;
            enforceLessonStartAtZero(this, currentSlide, "play_listener_force_zero_guard", {
                preserveActiveSegment: true,
            });
            if (segmentTargetFreezeIdx < 0) {
                beginPlayToNextFreezeFrame("play_listener_force_zero_guard");
            }
        }
        if (pausedAtFreezeMarkerIdx >= 0 && pausedAtFreezeMarkerIdx < freezeMarkers.length) {
            var resumedMarkerIdx = pausedAtFreezeMarkerIdx;
            var mk = freezeMarkers[resumedMarkerIdx];
            var resumeTarget = resolvePostFreezeStopTime(mk, resumedMarkerIdx, "resume_after_freeze");
            pausedAtFreezeMarkerIdx = -1;
            currentFreezeFrameIdx = resumedMarkerIdx;
            if (isFinite(Number(resumeTarget))) {
                syncVideoSeekWithMarkerState(this, Number(resumeTarget), "resume_after_freeze");
            }
            beginPlayToNextFreezeFrame("resume_after_freeze");
            logPlayerMarkerDebug({
                event: "resume_fired",
                reason: "resume_after_freeze",
                markerType: mk.markerType,
                markerSemantics: "freeze",
                markerIndex: resumedMarkerIdx,
                chosenResumePoint: Math.round(Number(this.currentTime) * 1000) / 1000,
                clickAction: "play_current_freeze_to_next_freeze",
            });
            return;
        }
        if (!isPlayingSegmentForward()) {
            beginPlayToNextFreezeFrame("play_event");
        }
        lastPlaybackTimeForMarkerCheck = Number(this.currentTime);
    });

    videoId.addEventListener("ended", function() {
        if (!CONTINUOUS_VIDEO_PLAYBACK) return;
        guidedTargetEventIdx = -1;
        syncLegacyYellowMarkerAliases();
        setGuidedPlaybackState("completed", "video_ended");
    });
    
    // Listener to pause video when reach specified time and implements looping // FindMe4
    videoId.addEventListener("timeupdate", function(){
        var t = this.currentTime;

        if (markerDebugOverlayEnabled()) {
            try { updateMarkerDebugPlayhead(); } catch (phErr) { /* overlay must never break playback */ }
        }

        if (CONTINUOUS_VIDEO_PLAYBACK) {
            syncInteractiveRuntimeToCurrentTime(null);
            if (guidedPlaybackState === "playing_to_next_freeze" &&
                (segmentTargetFreezeIdx < 0 || segmentTargetFreezeIdx >= freezeMarkers.length) &&
                freezeMarkers.length > 0) {
                beginPlayToNextFreezeFrame("missing_segment_target_rearm");
            }
            if (PAUSE_AT_FREEZE_MARKERS && playbackEvents.length > 0) {
                var prev = Number(lastPlaybackTimeForMarkerCheck);
                if (!isFinite(prev)) prev = Number(t);
                advanceMarkerCursorToTime(t);
                var mkGuide = null;
                var crossedStart = false;
                var pauseFired = false;

                if (guidedPlaybackState === "playing_to_next_freeze") {
                    if (tryCommitSegmentTargetFreezeStop(this, prev, t)) {
                        return;
                    }
                }

                t = applyColorCardSafetyDuringGuidedPlay(this, t);
                if (Math.abs(Number(this.currentTime) - Number(t)) > 1e-5) {
                    lastPlaybackTimeForMarkerCheck = Number(this.currentTime);
                    return;
                }

                if (guidedPlaybackState === "looping_at_red" && activeRedLoopEventIdx >= 0 &&
                    activeRedLoopReturnTime != null && isFinite(Number(activeRedLoopReturnTime))) {
                    var loopMkActive = loopMarkers[activeRedLoopEventIdx];
                    // Jump back at the red's START (consistent with handleRedLoopMarkerCrossing on
                    // entry) so the red card is never played; the mask cover hides the single-frame jump.
                    var redLoopBoundary = loopMkActive ? Number(loopMkActive.crossAt) : NaN;
                    if (loopMkActive && isFinite(redLoopBoundary) && prev < redLoopBoundary && t >= redLoopBoundary) {
                        this.currentTime = Number(activeRedLoopReturnTime);
                        lastPlaybackTimeForMarkerCheck = Number(activeRedLoopReturnTime);
                        logPlayerMarkerDebug({
                            event: "red_loop_repeat",
                            markerType: "red",
                            markerSemantics: "loop",
                            markerIndex: activeRedLoopEventIdx,
                            previousFreezeMarkerIndex: activeRedLoopPreviousFreezeIdx,
                            chosenResumePoint: Math.round(Number(activeRedLoopReturnTime) * 1000) / 1000,
                            clickAction: "break_loop_on_click",
                        });
                        return;
                    }
                }

                if (guidedPlaybackState === "playing_to_next_freeze") {
                    if (segmentTargetFreezeIdx < 0) {
                        var recoveredIdx = resolveActiveSegmentTargetFreezeIdx(prev, t);
                        if (recoveredIdx >= 0) {
                            segmentTargetFreezeIdx = recoveredIdx;
                            nextFreezeFrameIdx = recoveredIdx;
                            guidedTargetEventIdx = findNextSegmentPlaybackEventIdx(t, recoveredIdx);
                            syncLegacyYellowMarkerAliases();
                        }
                    }
                    advancePastSkippedFreezeEventsInSegment(t);
                }

                if (guidedPlaybackState === "playing_to_next_freeze" &&
                    guidedTargetEventIdx >= 0 &&
                    guidedTargetEventIdx < playbackEvents.length) {
                    var ev = playbackEvents[guidedTargetEventIdx];
                    mkGuide = ev.marker;
                    var trigger = classifyGuidedEventTrigger(ev, prev, t);
                    crossedStart = trigger.shouldFire;
                    if (trigger.shouldFire) {
                        logPlayerMarkerDebug({
                            event: "guided_event_trigger",
                            markerType: ev.marker && ev.marker.markerType ? ev.marker.markerType : null,
                            markerSemantics: ev.kind,
                            markerIndex: ev.kind === "freeze" ? ev.freezeMarkerIndex
                                : (ev.kind === "loop" ? ev.loopMarkerIndex : null),
                            triggerReason: trigger.reason,
                            previousTime: isFinite(prev) ? Math.round(prev * 1000) / 1000 : null,
                            currentTime: isFinite(Number(t)) ? Math.round(Number(t) * 1000) / 1000 : null,
                            chosenStopPoint: isFinite(Number(ev.crossAt)) ? Math.round(Number(ev.crossAt) * 1000) / 1000 : null,
                            segmentTargetFreezeIndex: segmentTargetFreezeIdx,
                        });
                        if (ev.kind === "freeze") {
                            if (isStopFreezeMarker(ev.marker)) {
                                pauseFired = true;
                                applyFreezeMarkerStopAtCrossing(this, ev.marker, ev.freezeMarkerIndex, prev, t, "autoplay_freeze_crossing");
                                return;
                            }
                            // green = pass-through: leapfrog the card and keep playing.
                            handleGreenPassthroughEvent(this, ev, prev, t);
                            return;
                        }
                        if (ev.kind === "loop") {
                            handleRedLoopMarkerCrossing(this, ev.marker, ev.loopMarkerIndex, prev, t);
                            return;
                        }
                    } else if (trigger.reason === "stale_target_already_past_marker") {
                        logPlayerMarkerDebug({
                            event: "guided_event_stale_target_recover",
                            markerType: ev.marker && ev.marker.markerType ? ev.marker.markerType : null,
                            markerSemantics: ev.kind,
                            markerIndex: ev.kind === "freeze" ? ev.freezeMarkerIndex
                                : (ev.kind === "loop" ? ev.loopMarkerIndex : null),
                            triggerReason: trigger.reason,
                            previousTime: isFinite(prev) ? Math.round(prev * 1000) / 1000 : null,
                            currentTime: isFinite(Number(t)) ? Math.round(Number(t) * 1000) / 1000 : null,
                            segmentTargetFreezeIndex: segmentTargetFreezeIdx,
                        });
                        if (ev.kind === "freeze") {
                            if (isStopFreezeMarker(ev.marker)) {
                                pauseFired = true;
                                applyFreezeMarkerStopAtCrossing(this, ev.marker, ev.freezeMarkerIndex, prev, t, "autoplay_freeze_stale_recover");
                                return;
                            }
                            // green = pass-through: leapfrog the card and keep playing.
                            handleGreenPassthroughEvent(this, ev, prev, t);
                            return;
                        }
                        if (ev.kind === "loop") {
                            handleRedLoopMarkerCrossing(this, ev.marker, ev.loopMarkerIndex, prev, t);
                            return;
                        }
                        advancePastSkippedFreezeEventsInSegment(t);
                    }
                }
                runTensegrityTimeupdateDiagnostics(this, prev, t, mkGuide, crossedStart, pauseFired);
            }
            lastPlaybackTimeForMarkerCheck = Number(t);
            return;
        }

        // Legacy slice mode: skip color-card intervals when configured.
        if ((typeof window.shouldSkipColorCards !== "undefined" && window.shouldSkipColorCards) ||
            (typeof window.shouldSkipYellow !== "undefined" && window.shouldSkipYellow)) {
            var skipRanges = getColorCardRangesFromWindow();
            var epsSkip = COLOR_CARD_RANGE_SKIP_EPS_SEC;
            for (var si = 0; si < skipRanges.length; si++) {
                var sr = skipRanges[si];
                if (t >= sr.start && t < sr.end) {
                    this.currentTime = sr.end + epsSkip;
                    return;
                }
            }
        }

        var cur = safeSrcSegmentAt(currentSlide);
        if (!cur) return;
        if (isOpeningUIRow(cur)) return;
        var endMark = Number(cur.src_end);
        if (!isFinite(endMark)) return;
        if (this.currentTime >= endMark) {
            // if next slide is a loop, then autoplay next slide
            var nextSeg = safeSrcSegmentAt(currentSlide + 1);
            if (currentSlide + 1 < lastSlide && nextSeg && nextSeg.loop) {
                currentSlide++;
                updateVideoId(true);
            }
            // if current slide is a loop, then loop
            else if (cur.loop) {
                updateVideoId(true);
            }
            else {
                this.pause();
            }
        }
        lastPlaybackTimeForMarkerCheck = Number(t);
    });
}

// Variable for controling menu. menuFrame is what animation will be shown when the menu appears. Can be set to anything supported by video tag
// var menu=document.getElementById("lessonMenuPage");

//Setup the page (this is already done in CSS so this is redundant, but doesn't hurt to be extra sure)
window.onload = function() {
	$('#lessonMenuPage').css('display', 'block');
	$('#lesson').css('display', 'none');
    $('.side').css('display', 'none');
};

//States
var states={
	menu: true,
	lastSlide: false
};

function executeClick(btnURL){
    event.stopPropagation();
    self.location.href=btnURL;
    }
function executeClickNewWindow(btnURL){
    event.stopPropagation();
    window.open(btnURL);
    }

//Avoid picking slides that don't exist
function checkSlideNum(){
	if(currentSlide < firstSlide){
        currentSlide = firstSlide;
    }
    else if (currentSlide == lastSlide) {
		states.lastSlide = true;
	}
	else if (currentSlide != lastSlide) {
		states.lastSlide = false;
	}
}

/* Updates video. Default: play = true
 * When called with play=true or without arguments, it will play the next scene
 * When called with play=false, it will go to the stop point(last frame) of the scene
 *                              i.e. the last frame (src_end) of currentSlide
*/
function updateVideoId(play=true){ // FindMe3
    var seg = safeSrcSegmentAt(currentSlide);
    if (!seg) return;

	if (play) {
        if (currentSlide === 0 || isOpeningUIRow(seg)) {
            return;
        }
        if (!isPlayableContentSegment(seg)) {
            if (!warnedInvalidSlide[currentSlide]) {
                console.warn("Timeline: slide " + currentSlide + " has no valid playback timing; skipping seek (regenerate timeline or fix chapter mapping).");
                warnedInvalidSlide[currentSlide] = true;
            }
            return;
        }
        // Confirmed green->menu mapping: jump this menu link to its matched green anchor and resume
        // the normal marker logic. Takes priority over the temporary force-to-zero fallback. Links
        // without a confirmed mapping fall through to the existing behavior (t=0) unchanged.
        if (CONTINUOUS_VIDEO_PLAYBACK && lastClickedMenuId &&
            Object.prototype.hasOwnProperty.call(menuGreenSeekByMenuId, lastClickedMenuId)) {
            var greenSeek = Number(menuGreenSeekByMenuId[lastClickedMenuId]);
            if (isFinite(greenSeek)) {
                var routedMenuId = lastClickedMenuId;
                lastClickedMenuId = null; // consume so unrelated entries don't reuse it
                syncVideoSeekWithMarkerState(videoId, greenSeek, "menu_green_jump");
                beginPlayToNextFreezeFrame("menu_green_jump");
                logPlayerMarkerDebug({
                    event: "menu_green_jump",
                    reason: "confirmed_green_menu_mapping",
                    menuId: routedMenuId,
                    chosenResumePoint: Math.round(greenSeek * 1000) / 1000,
                    clickAction: "menu_link_to_green_anchor",
                });
                try { videoId.play(); } catch (eGreen) { console.log(eGreen); }
                return;
            }
        }
        var forcedZeroStart = shouldApplyForceZeroForSlide(seg, currentSlide);
        if (forcedZeroStart) {
            pendingForcedLessonStartAtZero = true;
            enforceLessonStartAtZero(videoId, currentSlide, "lesson_entry_force_zero");
            if (CONTINUOUS_VIDEO_PLAYBACK) {
                beginPlayToNextFreezeFrame("lesson_entry_force_zero");
                logPlayerMarkerDebug({
                    event: "lesson_entry_seek",
                    reason: "lesson_entry_force_zero",
                    forcedFirstChapterAtZero: true,
                    chosenResumePoint: 0,
                    clickAction: "menu_or_chapter_entry_at_video_start",
                });
                try { videoId.play(); } catch (errZero) { console.log(errZero); }
            }
            return;
        }
        var startTime = resolveChapterPlaybackSeekTime(seg, currentSlide);
        if (startTime == null || !isFinite(startTime)) startTime = Number(seg.src_start);
            if ((typeof window.shouldSkipColorCards !== "undefined" && window.shouldSkipColorCards) ||
                (typeof window.shouldSkipYellow !== "undefined" && window.shouldSkipYellow)) {
                var navRanges = getColorCardRangesFromWindow();
                var epsNav = COLOR_CARD_RANGE_SKIP_EPS_SEC;
                for (var ni = 0; ni < navRanges.length; ni++) {
                    var nr = navRanges[ni];
                    if (startTime >= nr.start && startTime < nr.end) {
                        startTime = nr.end + epsNav;
                    }
                }
            }
            startTime = ensureSeekPastColorCardRanges(startTime);
            startTime += CONTENT_SEEK_LEAD_IN_SEC;
            var segEnd = Number(seg.src_end);
            if (isFinite(segEnd) && startTime > segEnd - 0.02) {
                startTime = segEnd - 0.035;
            }
            syncVideoSeekWithMarkerState(videoId, startTime, "chapter_jump_play");
            if (CONTINUOUS_VIDEO_PLAYBACK) {
                beginPlayToNextFreezeFrame("chapter_jump_play");
                logPlayerMarkerDebug({
                    event: "chapter_seek_target",
                    reason: "chapter_jump_play",
                    forcedFirstChapterAtZero: false,
                    chosenResumePoint: Math.round(Number(videoId.currentTime) * 1000) / 1000,
                    leapfrogHelperUsed: true,
                });
                try { videoId.play(); } catch (err) { console.log(err); }
            }
	}
	else {
		//Go to end of last clip
        var endTime = segmentContentEndTime(seg);
        if (endTime == null || !isFinite(endTime)) endTime = Number(seg.src_end);
		if (isFinite(endTime)) {
            if ((typeof window.shouldSkipColorCards !== "undefined" && window.shouldSkipColorCards) ||
                (typeof window.shouldSkipYellow !== "undefined" && window.shouldSkipYellow)) {
                var endRanges = getColorCardRangesFromWindow();
                var eps2 = 0.05;
                for (var ej = 0; ej < endRanges.length; ej++) {
                    var er = endRanges[ej];
                    if (endTime > er.start && endTime <= er.end + eps2) {
                        endTime = er.end + eps2;
                    }
                }
            }
            syncVideoSeekWithMarkerState(videoId, endTime, "chapter_anchor_preview");
            segmentTargetFreezeIdx = -1;
            nextFreezeFrameIdx = -1;
            guidedTargetEventIdx = -1;
            if (CONTINUOUS_VIDEO_PLAYBACK) {
                try { videoId.pause(); } catch (err2) { console.log(err2); }
                setGuidedPlaybackState("idle", "chapter_anchor_preview");
            }
		}
		else if (!isOpeningUIRow(seg) && !warnedInvalidSlide[currentSlide]) {
            console.warn("Timeline: slide " + currentSlide + " has no valid src_end for pause frame.");
            warnedInvalidSlide[currentSlide] = true;
        }
	}
}

/* Updates page in relation to menu. */
function update(playVid){ // FindMe2
	checkSlideNum();

    if (!Array.isArray(srcArray) || srcArray.length === 0) return;

	// Hide the menu unless on the first animation
	if(states.menu == true){
		$('#lesson').css('display', 'none');
		$('#lessonMenuPage').css('display', 'block');
		states.menu = false;
	}
    
    // Transition to menu if advancing from last slide
    if (states.lastSlide == true) {
        $('#lesson').css('display', 'none');
        $('#lessonMenuPage').fadeIn(); // display: block
        playVid = false;
        states.menu = true;
        currentSlide = 0;
    }

	// Show or hide mid-lesson side button
    var curSeg = safeSrcSegmentAt(currentSlide);
	if (!curSeg || !curSeg.side) {
		$('.btnSide').css('display', 'none');
	}
	else {
        $('.btnSide').css('display', 'none'); // reset
		$(curSeg.side).css('display', 'inline-block');
    }

	// If starting mid lesson: hide menu, display lesson
	if($('#lessonMenuPage').attr('display') != 'none' && currentSlide != firstSlide){
		$('#lessonMenuPage').css('display', 'none');
		$('#lesson').css('display', 'block');
	}

	// currentSlide UI index; keep quiet to avoid debug spam.
    
    if (currentSlide > 0 && currentSlide < srcArray.length) {
    	if (playVid) {
            var seg = safeSrcSegmentAt(currentSlide);
            var forceZeroInteractiveEntry = shouldApplyForceZeroForSlide(seg, currentSlide);
            if (clickedLink && !forceZeroInteractiveEntry) {
                logPlayerMarkerDebug({
                    event: "menu_lesson_entry",
                    entryPath: "chapter_anchor_preview",
                    currentSlide: currentSlide,
                    clickAction: "menu_chapter_preview_end_frame",
                });
                updateVideoId(false);
                clickedLink = false;
            } else {
                if (clickedLink) {
                    logPlayerMarkerDebug({
                        event: "menu_lesson_entry",
                        entryPath: "interactive_force_zero_start",
                        currentSlide: currentSlide,
                        forceFirstChapterStartAtZero: true,
                        clickAction: "skip_chapter_preview_use_video_start",
                    });
                    clickedLink = false;
                }
                updateVideoId(true);
            }
        }
        else {
            updateVideoId(false);
        }  
    }
}

/**
 * CLICK while a segment is playing: step to the very NEXT marker event in time and act on it:
 *  - next event is a red -> drop into that red's loop (jump back to its anchor and loop).
 *  - next event is a genuine yellow stop -> pause there.
 *  - pass-through freezes (green / yellow-inside-a-red-loop) are skipped while scanning.
 * This keeps clicks incremental (one thing at a time) instead of blowing past reds to the far
 * segment-target yellow.
 */
function advanceToNextMarkerEventOnClick(reason, clickedElement) {
    var nowT = (typeof videoId !== "undefined" && videoId && isFinite(Number(videoId.currentTime)))
        ? Number(videoId.currentTime) : 0;
    var chosen = -1;
    for (var i = 0; i < playbackEvents.length; i++) {
        var ev = playbackEvents[i];
        if (!ev || !isFinite(Number(ev.crossAt))) continue;
        if (Number(ev.crossAt) <= nowT + 1e-4) continue;
        if (ev.kind === "loop") { chosen = i; break; }
        if (ev.kind === "freeze" && isStopFreezeMarker(ev.marker)) { chosen = i; break; }
        // pass-through freeze (green / yellow-in-red): skip, keep scanning forward.
    }
    if (chosen < 0) {
        logPlayerMarkerDebug({
            event: "click_step_to_next_event",
            clickBranchTaken: "no_actionable_event_ahead_play_through",
            clickedElement: clickedElement || null,
            clickAction: "step_forward_no_remaining_event",
        });
        try { videoId.play(); } catch (e) { console.log(e); }
        return true;
    }
    var chosenEv = playbackEvents[chosen];
    if (chosenEv.kind === "loop") {
        var redMk = chosenEv.marker;
        guidedTargetEventIdx = chosenEv.eventIndex;
        logPlayerMarkerDebug({
            event: "click_step_to_red_loop",
            clickBranchTaken: "step_to_next_red_loop",
            clickedElement: clickedElement || null,
            markerType: "red",
            markerSemantics: "loop",
            markerIndex: chosenEv.loopMarkerIndex,
            chosenStopPoint: isFinite(Number(redMk.crossAt)) ? Math.round(Number(redMk.crossAt) * 1000) / 1000 : null,
            clickAction: "step_forward_into_red_loop",
        });
        handleRedLoopMarkerCrossing(videoId, redMk, chosenEv.loopMarkerIndex, nowT, nowT);
        try { videoId.play(); } catch (e2) { console.log(e2); }
        return true;
    }
    var yMk = chosenEv.marker;
    logPlayerMarkerDebug({
        event: "click_step_to_yellow_stop",
        clickBranchTaken: "step_to_next_yellow_stop",
        clickedElement: clickedElement || null,
        markerType: yMk.markerType,
        markerSemantics: "freeze",
        markerIndex: chosenEv.freezeMarkerIndex,
        segmentTargetFreezeIndex: chosenEv.freezeMarkerIndex,
        chosenStopPoint: isFinite(Number(yMk.crossAt)) ? Math.round(Number(yMk.crossAt) * 1000) / 1000 : null,
        clickAction: "step_forward_to_next_yellow_stop",
    });
    applyFreezeMarkerStopAtCrossing(videoId, yMk, chosenEv.freezeMarkerIndex, nowT, nowT, reason || "click_step_to_next_event");
    return true;
}

/**
 * CLICK while a segment is playing: jump straight to the next freeze stop (yellow/green),
 * leapfrogging any cards (and any red in between) and pausing on the post-card content.
 * This gives clicks "power over all" — they are never swallowed mid-segment.
 */
function skipToNextFreezeStopOnClick(reason, clickedElement) {
    var nowT = (typeof videoId !== "undefined" && videoId && isFinite(Number(videoId.currentTime)))
        ? Number(videoId.currentTime) : 0;
    var idx = (segmentTargetFreezeIdx >= 0 && segmentTargetFreezeIdx < freezeMarkers.length)
        ? segmentTargetFreezeIdx
        : findFirstStopMarkerIndexAfterTime(nowT);
    if (idx < 0 || idx >= freezeMarkers.length) {
        // No yellow stop ahead — let it keep playing to the end.
        logPlayerMarkerDebug({
            event: "click_skip_to_next_stop",
            clickBranchTaken: "no_freeze_ahead_play_through",
            clickedElement: clickedElement || null,
            clickAction: "skip_forward_no_remaining_freeze",
        });
        return false;
    }
    var mk = freezeMarkers[idx];
    logPlayerMarkerDebug({
        event: "click_skip_to_next_stop",
        clickBranchTaken: "skip_to_next_freeze_stop",
        clickedElement: clickedElement || null,
        markerType: mk.markerType,
        markerSemantics: "freeze",
        markerIndex: idx,
        segmentTargetFreezeIndex: idx,
        chosenStopPoint: isFinite(Number(mk.crossAt)) ? Math.round(Number(mk.crossAt) * 1000) / 1000 : null,
        clickAction: "skip_forward_to_next_freeze_stop",
    });
    applyFreezeMarkerStopAtCrossing(videoId, mk, idx, nowT, nowT, reason || "click_skip_to_next_stop");
    return true;
}

//Adds one to currentSlide, i.e. defines currentSlide as the next stop point
function nextSlide(clickEvt){ // FindMe1
    var clickEvent = clickEvt || ((typeof window !== "undefined" && window.event) ? window.event : null);
    if (!isActionableInVideoClick(clickEvent)) {
        logPlayerMarkerDebug({
            event: "click_branch",
            clickBranchTaken: "ignored_in_video_while_playing",
            clickIgnoredReason: "segment_already_playing",
            currentFreezeFrameIndex: currentFreezeFrameIdx,
            segmentTargetFreezeIndex: segmentTargetFreezeIdx,
        });
        return;
    }
    var syncResult = syncInteractiveRuntimeToCurrentTime("click_preflight_sync");
    var clickTarget = clickEvent && clickEvent.target
        ? (clickEvent.target.id || clickEvent.target.className || clickEvent.target.tagName || "unknown")
        : "unknown";
    var nowTime = (typeof videoId !== "undefined" && videoId && isFinite(Number(videoId.currentTime)))
        ? Number(videoId.currentTime) : null;
    var nearest = nearestPlaybackEventInfoAtTime(nowTime);
    var baseClickDebug = {
        event: "click_intent",
        clickedElement: clickTarget,
        mode: guidedPlaybackState,
        currentTime: nowTime != null ? Math.round(nowTime * 1000) / 1000 : null,
        currentSlide: currentSlide,
        nearestMarkerEventIndex: nearest ? nearest.eventIndex : null,
        nearestMarkerIndex: nearest ? nearest.markerIndex : null,
        nearestMarkerType: nearest ? nearest.markerType : null,
        nearestMarkerSemantics: nearest ? nearest.semantics : null,
        nearestMarkerCrossAt: nearest ? nearest.crossAt : null,
        nearestMarkerDeltaSec: nearest ? nearest.deltaSec : null,
    };

    if (CONTINUOUS_VIDEO_PLAYBACK && guidedPlaybackState === "paused_at_freeze") {
        var pausedIdx = pausedAtFreezeMarkerIdx;
        var pausedMk = pausedIdx >= 0 ? freezeMarkers[pausedIdx] : null;
        var resumeFromFreeze = pausedMk
            ? resolvePostFreezeStopTime(pausedMk, pausedIdx, "click_resume_from_freeze")
            : null;
        currentFreezeFrameIdx = pausedIdx >= 0 ? pausedIdx : currentFreezeFrameIdx;
        pausedAtFreezeMarkerIdx = -1;
        if (isFinite(Number(resumeFromFreeze))) {
            syncVideoSeekWithMarkerState(videoId, Number(resumeFromFreeze), "click_play_segment_to_next_freeze");
        }
        beginPlayToNextFreezeFrame("click_play_segment_to_next_freeze");
        logPlayerMarkerDebug({
            event: "click_play_segment_to_next_freeze",
            clickBranchTaken: "resume_from_paused_freeze",
            clickedElement: baseClickDebug.clickedElement,
            currentFreezeFrameIndex: currentFreezeFrameIdx,
            nextFreezeFrameIndex: nextFreezeFrameIdx,
            segmentTargetFreezeIndex: segmentTargetFreezeIdx,
            markerType: pausedMk ? pausedMk.markerType : null,
            clickAction: "play_current_freeze_to_next_freeze",
            chosenResumePoint: isFinite(Number(resumeFromFreeze))
                ? Math.round(Number(resumeFromFreeze) * 1000) / 1000 : null,
        });
        try { videoId.play(); } catch (err) { console.log(err); }
        return;
    }
    if (CONTINUOUS_VIDEO_PLAYBACK && guidedPlaybackState === "looping_at_red") {
        logPlayerMarkerDebug({
            event: "click_branch",
            clickBranchTaken: "break_red_loop",
            clickedElement: baseClickDebug.clickedElement,
            currentSlide: baseClickDebug.currentSlide,
            nearestMarkerEventIndex: baseClickDebug.nearestMarkerEventIndex,
            nearestMarkerIndex: baseClickDebug.nearestMarkerIndex,
            nearestMarkerType: baseClickDebug.nearestMarkerType,
            nearestMarkerSemantics: baseClickDebug.nearestMarkerSemantics,
            nearestMarkerDeltaSec: baseClickDebug.nearestMarkerDeltaSec,
            clickAction: "break_red_loop",
        });
        breakRedLoopAndResumePastRed("click_break_red_loop");
        return;
    }
    if (isInLessonVideoClickContext()) {
        if (videoId && videoId.paused) {
            syncPausedFreezeStateFromVideoTime("click_infer_paused_freeze");
            if (guidedPlaybackState === "paused_at_freeze") {
                var inferIdx = pausedAtFreezeMarkerIdx;
                var inferMk = inferIdx >= 0 ? freezeMarkers[inferIdx] : null;
                var inferResume = inferMk
                    ? resolvePostFreezeStopTime(inferMk, inferIdx, "click_resume_from_inferred_freeze")
                    : null;
                currentFreezeFrameIdx = inferIdx >= 0 ? inferIdx : currentFreezeFrameIdx;
                pausedAtFreezeMarkerIdx = -1;
                if (isFinite(Number(inferResume))) {
                    syncVideoSeekWithMarkerState(videoId, Number(inferResume), "click_play_segment_to_next_freeze");
                }
                beginPlayToNextFreezeFrame("click_play_segment_to_next_freeze");
                logPlayerMarkerDebug({
                    event: "click_play_segment_to_next_freeze",
                    clickedElement: baseClickDebug.clickedElement,
                    clickAction: "play_current_freeze_to_next_freeze",
                    currentFreezeFrameIndex: currentFreezeFrameIdx,
                    segmentTargetFreezeIndex: segmentTargetFreezeIdx,
                    chosenResumeTarget: isFinite(Number(inferResume))
                        ? Math.round(Number(inferResume) * 1000) / 1000 : null,
                });
                try { videoId.play(); } catch (errResume) { console.log(errResume); }
                return;
            }
            logPlayerMarkerDebug({
                event: "click_play_segment_to_next_freeze",
                clickedElement: baseClickDebug.clickedElement,
                clickAction: "play_current_freeze_to_next_freeze",
                currentFreezeFrameIndex: currentFreezeFrameIdx,
            });
            beginPlayToNextFreezeFrame("click_play_segment_to_next_freeze");
            try { videoId.play(); } catch (errResume2) { console.log(errResume2); }
            return;
        }
        if (videoId && !videoId.paused && isPlayingSegmentForward() &&
            segmentTargetFreezeIdx >= 0 && segmentTargetFreezeIdx < freezeMarkers.length) {
            advanceToNextMarkerEventOnClick("click_step_to_next_event", baseClickDebug.clickedElement);
            return;
        }
    }
    if (CONTINUOUS_VIDEO_PLAYBACK && videoId && !videoId.paused && isPlayingSegmentForward() &&
        segmentTargetFreezeIdx >= 0 && segmentTargetFreezeIdx < freezeMarkers.length) {
        advanceToNextMarkerEventOnClick("click_step_to_next_event", baseClickDebug.clickedElement);
        return;
    }
    if (CONTINUOUS_VIDEO_PLAYBACK && videoId && !videoId.paused && isPlayingSegmentForward() &&
        (segmentTargetFreezeIdx < 0 || segmentTargetFreezeIdx >= freezeMarkers.length)) {
        beginPlayToNextFreezeFrame("click_rearm_missing_segment_target");
        logPlayerMarkerDebug({
            event: "click_branch",
            clickBranchTaken: "rearm_missing_segment_target",
            clickedElement: baseClickDebug.clickedElement,
            clickAction: "rearm_missing_segment_target",
            clickIgnoredReason: "missing_segment_target",
            recoveryActionTaken: syncResult && syncResult.action ? syncResult.action : "click_rearm_missing_segment_target",
        });
        return;
    }
    if (isInLessonVideoClickContext()) {
        logPlayerMarkerDebug({
            clickedElement: baseClickDebug.clickedElement,
            clickAction: "ignored_chapter_advance_use_freeze_clicks",
            currentSlide: baseClickDebug.currentSlide,
        });
        return;
    }
    var enteringFromMenu = currentSlide <= 0;
    var nextSlideIdx = currentSlide + 1;
    if (Array.isArray(srcArray) && nextSlideIdx > 0 && nextSlideIdx < srcArray.length) {
        while (nextSlideIdx < srcArray.length && !isOpeningUIRow(safeSrcSegmentAt(nextSlideIdx)) &&
            !isPlayableContentSegment(safeSrcSegmentAt(nextSlideIdx))) {
            nextSlideIdx++;
        }
    }
    var entrySeg = safeSrcSegmentAt(nextSlideIdx);
    var forceZeroMenuEntry = shouldApplyForceZeroForSlide(entrySeg, nextSlideIdx);
    if (forceZeroMenuEntry && CONTINUOUS_VIDEO_PLAYBACK && freezeMarkers.length > 0) {
        currentSlide = nextSlideIdx;
        $('#lessonMenuPage').css('display', 'none');
        $('#lesson').css('display', 'block');
        states.menu = false;
        clickedLink = false;
        logPlayerMarkerDebug({
            event: "menu_lesson_entry",
            entryPath: "interactive_force_zero_start",
            currentSlide: currentSlide,
            forceFirstChapterStartAtZero: true,
            clickAction: "menu_direct_interactive_entry_at_zero",
        });
        updateVideoId(true);
        return;
    }
    logPlayerMarkerDebug({
        clickedElement: baseClickDebug.clickedElement,
        currentSlide: baseClickDebug.currentSlide,
        clickAction: enteringFromMenu ? "advance_chapter_row_menu_navigation" : "advance_chapter_row",
    });
	currentSlide++;
    if (Array.isArray(srcArray) && currentSlide > 0 && currentSlide < srcArray.length) {
        while (currentSlide < srcArray.length && !isOpeningUIRow(safeSrcSegmentAt(currentSlide)) && !isPlayableContentSegment(safeSrcSegmentAt(currentSlide))) {
            currentSlide++;
        }
    }
	update(true); // Go to FindMe2
}

//Go to previous slide
function backSlide() {
    if (!Array.isArray(srcArray) || currentSlide <= 1) return;
    var curBack = safeSrcSegmentAt(currentSlide);
    if (curBack && curBack.loop) {
        currentSlide--;
    }
    currentSlide--;
    while (currentSlide > 0 && !isOpeningUIRow(safeSrcSegmentAt(currentSlide)) && !isPlayableContentSegment(safeSrcSegmentAt(currentSlide))) {
        currentSlide--;
    }
    if (currentSlide < 1) {
        currentSlide = 1;
    }
    var bs = safeSrcSegmentAt(currentSlide);
    if (bs && bs.loop) {
        update(true);
    }
    else {
        update(false);
    }
}

// Global variables for jQuery mouseovers
var isSlowerOn = true;
var isFasterOn = true;

//Toggle Rate. Current speeds available:  0.5x, 1x, 2x
function slowDown(vidRate) {
    var rate = document.getElementById(vidRate);
	if (rate.playbackRate > 1) {
		rate.playbackRate -= 1;
        btnFaster.style.opacity = "1.0"; // 1x
        isFasterOn = true;
    }
    else if (rate.playbackRate == 1) {
		rate.playbackRate -= 0.5;
        btnSlower.style.opacity = "0.6"; // 0.5x
        isSlowerOn = false;
    }
}

function speedUp(vidRate) {
    var rate = document.getElementById(vidRate);
	if (rate.playbackRate < 1) {
		rate.playbackRate += 0.5;
        btnSlower.style.opacity = "1.0"; // 1x
        isSlowerOn = true;
    }
    else if (rate.playbackRate == 1) {
        rate.playbackRate += 1;
        btnFaster.style.opacity = "0.6"; // 2x
        isFasterOn = false;
    }
}

//Side Lesson Block
var sideVid = null;
var currentSlideSide = 0;
const firstSlideSide = 0;
var lastSlideSide = 0;
var sideSrcArray = null;
var sideId = '';

function openSide(sideIdString, sideVidId, sideArray) {
    sideId = sideIdString;
    
    $(sideId).fadeIn(); // automatically sets display = block
	$('#lesson').css('display', 'none');

	sideVid = document.getElementById(sideVidId);
	sideSrcArray = sideArray;
	lastSlideSide = sideSrcArray.length - 1;
	nextSlideSide(); // automatically advance slide and start playing
}

function closeSide() {
    $('#lesson').fadeIn(); // automatically sets display = block
    $(sideId).css('display', 'none');

	// reset values
	sideVid = null;
	currentSlideSide = 0;
	lastSlideSide = 0;
	sideSrcArray = null;
	sideId = '';
}

function nextSlideSide() {
	currentSlideSide++;
    
    if (currentSlideSide == sideSrcArray.length) {
        closeSide();
    }
    else {
        if (sideSrcArray[currentSlideSide].src_start != null) {
            sideVid.currentTime = sideSrcArray[currentSlideSide].src_start;
            console.log(currentSlideSide);
        }
        else {
            console.error("Invalid sideSrcArray[currentSlideSide]src_start. currentSlide = " + currentSlideSide);
        }
        try {
            sideVid.play();

            sideVid.addEventListener("timeupdate", function () {
                // if finished playing clip (reach src_end)
                if (sideSrcArray &&
                    this.currentTime >= sideSrcArray[currentSlideSide].src_end) {
                    // if next slide is a loop, then autoplay next slide
                    if (currentSlideSide + 1 <= lastSlideSide && 
                        sideSrcArray[currentSlideSide + 1].loop) {
                        currentSlideSide++;
                        playSideVid(true);
                    }
                    // if current slide is a loop, then loop
                    else if (sideSrcArray[currentSlideSide].loop) {
                        playSideVid(true);
                    }
                    // if last slide, automatically close side
                    else if (currentSlideSide == lastSlideSide) {
                        closeSide();
                    }
                    else {
                        this.pause();
                    }
                }
            });
        }
        catch (err) { console.log(err); }
    }
}

function backSlideSide() {
    if (currentSlideSide > 0) {
        if (sideSrcArray[currentSlideSide].loop) {
            currentSlideSide--;
        }
        currentSlideSide--;
    }
    
    if (currentSlideSide > 0) {
        console.log(currentSlideSide);
        playSideVid(false);
    }
    else {
        closeSide();
    }
}

function playSideVid(play) {
    if (play) {
		if (sideSrcArray[currentSlideSide].src_start != null) {
			sideVid.currentTime = sideSrcArray[currentSlideSide].src_start;
		}
		else {
			console.error("Invalid sideSrcArray/currentSlideSide/src_start. currentSlideSide = " + currentSlideSide);
        }
		try {
			sideVid.play();
            console.log("sideplay");
		}
		catch (err) { console.log(err); }
	}
	else{
		//Go to end of last clip
		if (sideSrcArray[currentSlideSide].src_end) {
			sideVid.currentTime = sideSrcArray[currentSlideSide].src_end;
		}
		else {
			console.error("Invalid sideSrcArray[currentSlideSide]src_end. currentSlideSide = " + currentSlideSide);
        }
	}
}
// End Side Lesson Block

//JQuery Button Implementation
$(function(){
    
	//LessonMenu BTN_ToCentralMenu mouseover
	$("#btnToCentralMenu").on({
		mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_ToCentralMenuOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_ToCentralMenuHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_ToCentralMenuOver.jpg'); },
		mouseleave: function () { $(this).attr('src', '../../../../CommonFiles/Buttons/BTN_ToCentralMenu.jpg'); }
	});
    
	//LessonMenu BTN_TogTextLessonMenuT mouseover
	$("#btnTogTextLessonMenuT").on({
		mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_TogLessonMenuTOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_TogLessonMenuTHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_TogLessonMenuTOver.jpg'); },
		mouseleave: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_TogLessonMenuT.jpg'); }
	});
    
	//LessonMenu BTN_TogTextLessonMenuX mouseover
	$("#btnTogTextLessonMenuX").on({
		mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_TogLessonMenuXOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_TogLessonMenuXHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_TogLessonMenuXOver.jpg'); },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_TogLessonMenuX.jpg'); }
	});
    
    //LessonMenu BTN_ToPopUps mouseover
    $("#btnToPopUps").on({
        mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_PopUpOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_PopUpHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_PopUpOver.jpg'); },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_PopUp.jpg'); }
    });
    
	//LessonMenu BTN_Excerpts mouseover
	$("#btnExcerpts").on({
		mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_ExcerptsOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_ExcerptsHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_ExcerptsOver.jpg'); },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_Excerpts.jpg'); }
	});
    
	//LessonMenu BTN_Questions mouseover
	$("#btnQuestions").on({
		mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_QuestionsOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_QuestionsHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_QuestionsOver.jpg'); },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_Questions.jpg'); }
	});

	//LessonMenu BTN_Feedback mouseover
	$("#btnFeedback").on({
		mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_FeedbackOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_FeedbackHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_FeedbackOver.jpg'); },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_Feedback.jpg'); }
	});

	//Lesson BTN_Back mouseover
	$("#btnBack").on({
		mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_BackOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_BackHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_BackOver.jpg'); },
		mouseleave: function () { $(this).attr('src', '../../../../CommonFiles/Buttons/BTN_Back.jpg'); }
	});
    
	//Lesson BTN_LessonMenu mouseover
	$("#btnLessonMenu").on({
		mouseup: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_LessonMenuOver.jpg'); },
		mousedown: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_LessonMenuHit.jpg'); },
		mouseenter: function () {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_LessonMenuOver.jpg'); },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_LessonMenu.jpg'); }
	});

	//Lesson BTN_Fast mouseover
	$("#btnFaster").on({
		mouseup: function () { if (isFasterOn) {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_FastOver.jpg');} },
		mousedown: function () { if (isFasterOn) {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_FastHit.jpg');} },
		mouseenter: function () { if (isFasterOn) {$(this).attr('src','../../../../CommonFiles/Buttons/BTN_FastOver.jpg');} },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_Fast.jpg'); }
	});

	//Lesson BTN_Slow mouseover
	$("#btnSlower").on({
		mouseup: function () { if (isSlowerOn) $(this).attr('src','../../../../CommonFiles/Buttons/BTN_SlowOver.jpg'); },
		mousedown: function () { if (isSlowerOn) $(this).attr('src','../../../../CommonFiles/Buttons/BTN_SlowHit.jpg'); },
		mouseenter: function () { if (isSlowerOn) $(this).attr('src','../../../../CommonFiles/Buttons/BTN_SlowOver.jpg'); },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_Slow.jpg'); }
	});

	//Lesson BTN_BlindScript mouseover
	$("#btnBlindScript").on({
		mouseup: function () { if (isSlowerOn) $(this).attr('src','../../../../CommonFiles/Buttons/BTN_BlindScriptOver.jpg'); },
		mousedown: function () { if (isSlowerOn) $(this).attr('src','../../../../CommonFiles/Buttons/BTN_BlindScriptHit.jpg'); },
		mouseenter: function () { if (isSlowerOn) $(this).attr('src','../../../../CommonFiles/Buttons/BTN_BlindScriptOver.jpg'); },
		mouseleave: function () {$(this).attr('src', '../../../../CommonFiles/Buttons/BTN_BlindScript.jpg'); }
	});

	// Normal back button
	$('#btnBack').on('click', function(){
		backSlide();
	});
});

// Side lesson buttons
$(function () {
	// Back Button for sides
	$(".btnSideBack").on({
		mouseup: function () { $(this).attr('src', '../../../../CommonFiles/Buttons/BTN_BackOver.jpg'); },
		mousedown: function () { $(this).attr('src', '../../../../CommonFiles/Buttons/BTN_BackHit.jpg'); },
		mouseenter: function () { $(this).attr('src', '../../../../CommonFiles/Buttons/BTN_BackOver.jpg'); },
		mouseleave: function () { $(this).attr('src', '../../../../CommonFiles/Buttons/BTN_Back.jpg'); }
	});
});
// End side lesson buttons

document.onkeydown=function(e){
    switch(e.keyCode){
        case 13:
		//'Enter' keyCode
        if (sideVid){
            nextSlideSide();
            console.log('enter side');
        }
        else {
            nextSlide();
            console.log('enter');
        }
		break;

		case 32:
		//'SpaceBar' keyCode
        if (sideVid){
            nextSlideSide();
            console.log('space key side');
        }
        else {
            nextSlide();
            console.log('space keystroke');
        }
		break;

		case 39:
		//right arrow
        if (sideVid){
            nextSlideSide();
            console.log('right arrow side');
        }
        else {
            nextSlide();
            console.log('right arrow');
        }
		break;

		case 34:
		//'PgDn' keyCode
        if (sideVid){
            nextSlideSide();
            console.log('pgdn side');
        }
        else {
            nextSlide();
            console.log('PgDn');
        }
		break;

		case 37:
		//left arrow
        if (sideVid){
            backSlideSide();
            console.log('left arrow side');
        }
        else {
            backSlide();
            console.log('left arrow');
        }
		break;

		case 33:
		//'PgUp' keyCode
        if (sideVid){
            backSlideSide();
            console.log('pgup side');
        }
        else {
            backSlide();
            console.log('PgUp');
        }
		break;

/*		case 77:
		//'ctrlM' keyCode
		backMenu();
		console.log('M keystroke');
		break;
*/	}
}

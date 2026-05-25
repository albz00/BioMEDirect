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

/** Unified freeze markers (yellow + green), sorted by crossAt. */
var freezeMarkers = [];
/** Loop markers (red), sorted by crossAt. */
var loopMarkers = [];
/** Chronological playback guide: freeze stops and red loop triggers. */
var playbackEvents = [];
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
    if (Array.isArray(data.redStopMarkers)) window.redStopMarkers = data.redStopMarkers;
    var hasYellow = (Array.isArray(window.yellowStopMarkers) && window.yellowStopMarkers.length > 0) ||
        (Array.isArray(window.yellowScreenRanges) && window.yellowScreenRanges.length > 0);
    var hasGreen = (Array.isArray(window.greenStopMarkers) && window.greenStopMarkers.length > 0) ||
        (Array.isArray(window.greenScreenRanges) && window.greenScreenRanges.length > 0) ||
        (window.greenDetection && Array.isArray(window.greenDetection.events) && window.greenDetection.events.length > 0);
    var hasRed = (Array.isArray(window.redStopMarkers) && window.redStopMarkers.length > 0) ||
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

/** Leapfrog red control cards only — yellow/green freeze spans use freeze-crossing + resolvePostFreezeStopTime. */
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
            if (r.markerType !== "red") continue;
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
 * During guided play, only red control cards are skipped invisibly. Yellow/green freeze spans
 * end the segment via tryCommitSegmentTargetFreezeStop (post-marker resolve + pause).
 */
function applyRedCardLeapfrogDuringGuidedPlay(videoEl, t) {
    if (!videoEl || !isFinite(Number(t))) return t;
    if (!isPlayingSegmentForward()) return t;
    var past = ensureSeekPastRedCardRangesOnly(Number(t));
    if (Math.abs(past - Number(t)) > 1e-5) {
        videoEl.currentTime = past;
        advanceMarkerCursorToTime(past);
        logPlayerMarkerDebug({
            event: "invisible_leapfrog_during_play",
            leapfrogApplied: true,
            leapfrogHelperUsed: true,
            chosenResumeTarget: Math.round(past * 1000) / 1000,
            previousTime: Math.round(Number(t) * 1000) / 1000,
            markerType: "red",
        });
        return past;
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
    var idx = findFirstFreezeMarkerIndexAfterTime(fromTime);
    if (idx < 0 && nextFreezeMarkerIdx >= 0 && nextFreezeMarkerIdx < freezeMarkers.length) {
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
    var nextIdx = fromIdx < 0 ? findFirstFreezeMarkerIndexAfterTime(t) : (fromIdx + 1);
    currentFreezeFrameIdx = fromIdx;
    pausedAtFreezeMarkerIdx = -1;
    syncLegacyYellowMarkerAliases();

    if (nextIdx >= freezeMarkers.length) {
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
    setGuidedPlaybackState("idle", "initialize");

    // Runtime-owned click wiring so in-video clicks always reach nextSlide()
    // even when a lesson template's inline onclick path is missing/broken.
    function isActionableInVideoClick() {
        if (!CONTINUOUS_VIDEO_PLAYBACK) return true;
        if (!videoId) return false;
        if (guidedPlaybackState === "paused_at_freeze") return true;
        if (guidedPlaybackState === "looping_at_red") return true;
        if (videoId.paused) return true;
        return false;
    }

    if (!videoId.__interactiveClickBound) {
        videoId.addEventListener("click", function(evt) {
            if (evt && typeof evt.stopPropagation === "function") evt.stopPropagation();
            if (!isActionableInVideoClick()) return;
            nextSlide(evt);
        });
        videoId.__interactiveClickBound = true;
    }
    var animContainer = document.getElementById("animation");
    if (animContainer && !animContainer.__interactiveClickBound) {
        animContainer.addEventListener("click", function(evt) {
            if (!isActionableInVideoClick()) return;
            nextSlide(evt);
        });
        animContainer.__interactiveClickBound = true;
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

        if (CONTINUOUS_VIDEO_PLAYBACK) {
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

                t = applyRedCardLeapfrogDuringGuidedPlay(this, t);
                if (Math.abs(Number(this.currentTime) - Number(t)) > 1e-5) {
                    lastPlaybackTimeForMarkerCheck = Number(this.currentTime);
                    return;
                }

                if (guidedPlaybackState === "looping_at_red" && activeRedLoopEventIdx >= 0 &&
                    activeRedLoopReturnTime != null && isFinite(Number(activeRedLoopReturnTime))) {
                    var loopMkActive = loopMarkers[activeRedLoopEventIdx];
                    if (loopMkActive && prev < loopMkActive.end && t >= loopMkActive.end) {
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
                            pauseFired = true;
                            applyFreezeMarkerStopAtCrossing(this, ev.marker, ev.freezeMarkerIndex, prev, t, "autoplay_freeze_crossing");
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
                            pauseFired = true;
                            applyFreezeMarkerStopAtCrossing(this, ev.marker, ev.freezeMarkerIndex, prev, t, "autoplay_freeze_stale_recover");
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

//Adds one to currentSlide, i.e. defines currentSlide as the next stop point
function nextSlide(clickEvt){ // FindMe1
    var clickEvent = clickEvt || ((typeof window !== "undefined" && window.event) ? window.event : null);
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
            var ctrlSnap = getInteractiveControlSnapshot();
            logPlayerMarkerDebug({
                clickedElement: baseClickDebug.clickedElement,
                clickAction: "ignored_already_playing_segment",
                clickIgnoredReason: ctrlSnap.clickIgnoreReason || "segment_already_playing",
                currentFreezeFrameIndex: currentFreezeFrameIdx,
                segmentTargetFreezeIndex: segmentTargetFreezeIdx,
            });
            return;
        }
    }
    if (CONTINUOUS_VIDEO_PLAYBACK && videoId && !videoId.paused && isPlayingSegmentForward() &&
        segmentTargetFreezeIdx >= 0 && segmentTargetFreezeIdx < freezeMarkers.length) {
        logPlayerMarkerDebug({
            clickedElement: baseClickDebug.clickedElement,
            clickAction: "ignored_already_playing_segment",
            clickIgnoredReason: "segment_already_playing",
        });
        return;
    }
    if (CONTINUOUS_VIDEO_PLAYBACK && videoId && !videoId.paused && isPlayingSegmentForward() &&
        (segmentTargetFreezeIdx < 0 || segmentTargetFreezeIdx >= freezeMarkers.length)) {
        beginPlayToNextFreezeFrame("click_rearm_missing_segment_target");
        logPlayerMarkerDebug({
            clickedElement: baseClickDebug.clickedElement,
            clickAction: "rearm_missing_segment_target",
            clickIgnoredReason: "missing_segment_target",
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

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

/** Nudge past yellow/content boundary so the first decoded frame is content, not the tail of a yellow card. */
var CONTENT_SEEK_LEAD_IN_SEC = 0.1;
/** When skipping yellow intervals, land clearly after the detected end (seconds). */
var YELLOW_RANGE_SKIP_EPS_SEC = 0.1;
/** Keep video continuous; timeline rows are chapter/navigation anchors. */
var CONTINUOUS_VIDEO_PLAYBACK = true;
/** Pause at yellow marker starts during continuous playback. */
var PAUSE_AT_YELLOW_MARKERS = true;
var yellowMarkers = [];
var nextYellowMarkerIdx = 0;
var pausedAtYellowMarkerIdx = -1;
var lastPlaybackTimeForMarkerCheck = null;

// Need to add 1 to lastSlide to account for extra click to return to menu at end

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

/**
 * Playback should never sit inside a persisted yellow-card interval. After computing a seek time
 * (prefer contentStart), advance to just past any overlapping yellowScreenRanges (safety net).
 */
function ensureSeekPastYellowRanges(t) {
    var eps = YELLOW_RANGE_SKIP_EPS_SEC;
    var cur = Number(t);
    if (!isFinite(cur)) return t;
    var ranges = typeof window !== "undefined" ? window.yellowScreenRanges : null;
    if (!Array.isArray(ranges) || ranges.length === 0) return cur;
    var guard = 0;
    while (guard < 48) {
        guard++;
        var moved = false;
        for (var i = 0; i < ranges.length; i++) {
            var r = ranges[i];
            if (!r || typeof r.start !== "number" || typeof r.end !== "number") continue;
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

function loadYellowMarkersFromWindow() {
    var ranges = (typeof window !== "undefined" && Array.isArray(window.yellowScreenRanges))
        ? window.yellowScreenRanges
        : [];
    yellowMarkers = ranges
        .filter(function(r) { return r && typeof r.start === "number" && typeof r.end === "number" && r.end > r.start; })
        .map(function(r) {
            return {
                start: Number(r.start),
                end: Number(r.end),
            };
        })
        .sort(function(a, b) { return a.start - b.start; });
    nextYellowMarkerIdx = 0;
    pausedAtYellowMarkerIdx = -1;
}

function advanceMarkerCursorToTime(t) {
    while (nextYellowMarkerIdx < yellowMarkers.length && t > (yellowMarkers[nextYellowMarkerIdx].end + YELLOW_RANGE_SKIP_EPS_SEC)) {
        nextYellowMarkerIdx++;
    }
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
    loadYellowMarkersFromWindow();
    lastPlaybackTimeForMarkerCheck = null;
    if (typeof window !== "undefined" && typeof window.pauseAtYellowMarkersEnabled === "boolean") {
        PAUSE_AT_YELLOW_MARKERS = window.pauseAtYellowMarkersEnabled;
    } else {
        PAUSE_AT_YELLOW_MARKERS = true;
    }

    videoId.addEventListener("play", function() {
        if (!CONTINUOUS_VIDEO_PLAYBACK) return;
        if (pausedAtYellowMarkerIdx < 0 || pausedAtYellowMarkerIdx >= yellowMarkers.length) return;
        var mk = yellowMarkers[pausedAtYellowMarkerIdx];
        var tNow = Number(this.currentTime);
        if (isFinite(tNow) && tNow >= mk.start - 0.05 && tNow <= mk.end + 0.1) {
            this.currentTime = mk.end + YELLOW_RANGE_SKIP_EPS_SEC;
        }
        pausedAtYellowMarkerIdx = -1;
        advanceMarkerCursorToTime(this.currentTime);
        lastPlaybackTimeForMarkerCheck = Number(this.currentTime);
    });
    
    // Listener to pause video when reach specified time and implements looping // FindMe4
    videoId.addEventListener("timeupdate", function(){
        var t = this.currentTime;

        if (CONTINUOUS_VIDEO_PLAYBACK) {
            if (PAUSE_AT_YELLOW_MARKERS && yellowMarkers.length > 0) {
                var prev = Number(lastPlaybackTimeForMarkerCheck);
                if (!isFinite(prev)) prev = Number(t);
                advanceMarkerCursorToTime(t);
                if (nextYellowMarkerIdx < yellowMarkers.length) {
                    var mk = yellowMarkers[nextYellowMarkerIdx];
                    var crossedStart = prev < mk.start && t >= mk.start;
                    var landedInside = t >= mk.start && t <= mk.end + YELLOW_RANGE_SKIP_EPS_SEC;
                    var shouldPauseAtMarker = crossedStart || landedInside;
                    console.log("[yellow-marker-check]", JSON.stringify({
                        markerIndex: nextYellowMarkerIdx,
                        previousTime: Math.round(prev * 1000) / 1000,
                        currentTime: Math.round(t * 1000) / 1000,
                        markerStart: Math.round(mk.start * 1000) / 1000,
                        markerEnd: Math.round(mk.end * 1000) / 1000,
                        crossedStart: crossedStart,
                        landedInside: landedInside,
                        markerPauseFired: shouldPauseAtMarker,
                    }));
                    if (shouldPauseAtMarker) {
                        this.pause();
                        this.currentTime = mk.start;
                        pausedAtYellowMarkerIdx = nextYellowMarkerIdx;
                        console.log("[yellow-marker-pause-fired]", JSON.stringify({
                            markerIndex: nextYellowMarkerIdx,
                            previousTime: Math.round(prev * 1000) / 1000,
                            currentTime: Math.round(t * 1000) / 1000,
                            markerStart: Math.round(mk.start * 1000) / 1000,
                            markerEnd: Math.round(mk.end * 1000) / 1000,
                        }));
                        nextYellowMarkerIdx++;
                        lastPlaybackTimeForMarkerCheck = Number(this.currentTime);
                        return;
                    }
                }
            }
            lastPlaybackTimeForMarkerCheck = Number(t);
            return;
        }

        // Legacy slice mode: skip yellow intervals when configured.
        if (typeof window.shouldSkipYellow !== 'undefined' && window.shouldSkipYellow &&
            Array.isArray(window.yellowScreenRanges) && window.yellowScreenRanges.length > 0) {
            var epsSkip = YELLOW_RANGE_SKIP_EPS_SEC;
            for (var i = 0; i < window.yellowScreenRanges.length; i++) {
                var r = window.yellowScreenRanges[i];
                if (!r || typeof r.start !== 'number' || typeof r.end !== 'number') continue;
                if (t >= r.start && t < r.end) {
                    this.currentTime = r.end + epsSkip;
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
        var startTime = segmentContentSeekTime(seg);
        if (startTime == null || !isFinite(startTime)) startTime = Number(seg.src_start);
            // If yellowScreenRanges are defined globally (from Firestore), and we are
            // supposed to skip them, move the start just past any yellow block.
            if (typeof window.shouldSkipYellow !== 'undefined' && window.shouldSkipYellow && Array.isArray(window.yellowScreenRanges)) {
                var epsNav = YELLOW_RANGE_SKIP_EPS_SEC;
                for (var i = 0; i < window.yellowScreenRanges.length; i++) {
                    var r = window.yellowScreenRanges[i];
                    if (!r || typeof r.start !== 'number' || typeof r.end !== 'number') continue;
                    if (startTime >= r.start && startTime < r.end) {
                        startTime = r.end + epsNav;
                    }
                }
            }
            startTime = ensureSeekPastYellowRanges(startTime);
            startTime += CONTENT_SEEK_LEAD_IN_SEC;
            var segEnd = Number(seg.src_end);
            if (isFinite(segEnd) && startTime > segEnd - 0.02) {
                startTime = segEnd - 0.035;
            }
			videoId.currentTime = startTime;
	}
	else {
		//Go to end of last clip
        var endTime = segmentContentEndTime(seg);
        if (endTime == null || !isFinite(endTime)) endTime = Number(seg.src_end);
		if (isFinite(endTime)) {
            if (typeof window.shouldSkipYellow !== 'undefined' && window.shouldSkipYellow && Array.isArray(window.yellowScreenRanges)) {
                var eps2 = 0.05;
                for (var j = 0; j < window.yellowScreenRanges.length; j++) {
                    var r2 = window.yellowScreenRanges[j];
                    if (!r2 || typeof r2.start !== 'number' || typeof r2.end !== 'number') continue;
                    if (endTime > r2.start && endTime <= r2.end + eps2) {
                        endTime = r2.end + eps2;
                    }
                }
            }
			videoId.currentTime = endTime;
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

	console.log(currentSlide);
    
    if (currentSlide > 0 && currentSlide < srcArray.length) {
    	if (playVid) {
            if (clickedLink) { // Added this to go to end of last clip when menu link is clicked
                updateVideoId(false);
                clickedLink = false;
            }
            else {
                updateVideoId(true); // Go to FindMe3
            }
        }
        else {
            updateVideoId(false);
        }  
    }
}

//Adds one to currentSlide, i.e. defines currentSlide as the next stop point
function nextSlide(){ // FindMe1
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

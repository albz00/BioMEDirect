const {onObjectFinalized} = require("firebase-functions/v2/storage");
const {onCall} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { Storage } = require("@google-cloud/storage");
const os = require("os");
const path = require("path");
const fs = require("fs");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const convert = require("color-convert");
const { createWorker } = require("tesseract.js");
const Fuse = require("fuse.js");

admin.initializeApp();

const storage = new Storage();
const db = admin.firestore();

async function resolveLessonIdForUploadedVideo({ filePath, objectMetadata }) {
  const explicitLessonId = objectMetadata && objectMetadata.lessonId ? String(objectMetadata.lessonId).trim() : "";
  if (explicitLessonId) return explicitLessonId;

  const byPathSnap = await db.collection("videoPaths")
    .where("videoPath", "==", filePath)
    .limit(1)
    .get();
  if (!byPathSnap.empty) {
    return byPathSnap.docs[0].id;
  }
  return null;
}

exports.generateSrcArray = onObjectFinalized(
  {
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    const bucketName = object.bucket;

    if (!filePath.startsWith("videos/") || !filePath.endsWith(".mp4")) {
      console.log("Skipping non-video file:", filePath);
      return;
    }

    const uploadedVideoId = path.basename(filePath, ".mp4");
    const bucket = storage.bucket(bucketName);
    const tmpFile = path.join(os.tmpdir(), `upload_${Date.now()}_${path.basename(filePath)}`);

    try {
      console.log("Downloading uploaded lesson video:", filePath);
      await bucket.file(filePath).download({ destination: tmpFile });

      // Resolve which lesson this video belongs to (from custom metadata or videoPaths mapping)
      const lessonId = await resolveLessonIdForUploadedVideo({
        filePath,
        objectMetadata: object.metadata || {},
      });

      const chapterTitles = lessonId ? await loadOrderedChapterTitles(lessonId) : [];

      const pipeline = await runDeterministicYellowPipeline({
        lessonId: lessonId || null,
        localVideoPath: tmpFile,
        chapterTitles,
        sourceLabel: "upload-trigger",
      });

      let srcArray = pipeline.srcArray;
      if (lessonId) {
        const existingDoc = await db.collection("lessons").doc(lessonId).get();
        const existing = existingDoc.exists ? (existingDoc.data().srcArray || []) : [];
        srcArray = mergeManualTimelineOverrides(pipeline.srcArray, existing);
      }
      console.log("Built srcArray segments:", srcArray.length);

      // If we know the lesson, write directly to its timeline document.
      // Otherwise, keep the proposal under videoAnalyses so it can be inspected later.
      if (lessonId) {
        await db.collection("lessons").doc(lessonId).set(
          {
            srcArray,
            originalSrcArray: srcArray,
            yellowScreenRanges: pipeline.yellowRanges,
            yellowScreenEvents: pipeline.yellowEvents,
            chapterTimeline: pipeline.chapterTimeline,
            timelineReview: pipeline.review,
            timelinePipeline: {
              version: "yellow-content-v2",
              source: "upload-trigger",
              status: "ok",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
          { merge: true }
        );
      } else {
        await db.collection("videoAnalyses").doc(uploadedVideoId).set(
          {
            videoPath: filePath,
            srcArrayProposal: srcArray,
            yellowScreenRanges: pipeline.yellowRanges,
            yellowScreenEvents: pipeline.yellowEvents,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            timelinePipeline: {
              version: "yellow-content-v2",
              source: "upload-trigger",
              status: "unassigned",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
          { merge: true }
        );
      }
    } catch (error) {
      console.error("generateSrcArray failed:", error);
      // Best‑effort error marker; do not rethrow so the upload itself still succeeds.
      await db.collection("videoAnalyses").doc(uploadedVideoId).set(
        {
          videoPath: filePath,
          timelinePipeline: {
            version: "yellow-content-v2",
            source: "upload-trigger",
            status: "failed",
            error: error.message || String(error),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }
);

function getDuration(video) {
  return new Promise((resolve, reject) => {
    let duration = null;

    const proc = spawn(ffmpegPath, [
      "-i", video,
      "-f", "null", "-"
    ]);

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      const match = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (match) {
        const h = parseInt(match[1]);
        const m = parseInt(match[2]);
        const s = parseFloat(match[3]);
        duration = h*3600 + m*60 + s;
      }
    });

    proc.on("close", () => {
      if (duration == null) reject(new Error("Unable to read duration"));
      else resolve(duration);
    });
  });
}

async function loadOrderedChapterTitles(lessonId) {
  const metaDoc = await db.collection("lessonMetadata").doc(lessonId).get();
  if (!metaDoc.exists) return [];
  const meta = metaDoc.data() || {};

  if (Array.isArray(meta.chapterOrder) && meta.chapterOrder.length > 0) {
    const displayMap = meta.chapterDisplayNames || {};
    return meta.chapterOrder
      .map((key) => (displayMap[key] != null ? String(displayMap[key]).trim() : String(key).trim()))
      .filter(Boolean);
  }

  const displayNames = meta.chapterDisplayNames || {};
  const orderedKeys = Object.keys(displayNames).sort((a, b) => {
    const na = parseInt(String(a).replace(/\D+/g, ""), 10);
    const nb = parseInt(String(b).replace(/\D+/g, ""), 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
  return orderedKeys.map((k) => String(displayNames[k] || "").trim()).filter(Boolean);
}

function getVideoStreamInfo(video) {
  return new Promise((resolve) => {
    const info = {
      width: null,
      height: null,
      codec: null,
      frameRate: null,
    };

    const proc = spawn(ffmpegPath, ["-i", video, "-f", "null", "-"]);
    proc.stderr.on("data", (data) => {
      const text = data.toString();

      if (!info.codec) {
        const codecMatch = text.match(/Video:\s*([^,\n]+)/i);
        if (codecMatch) info.codec = codecMatch[1].trim();
      }
      if (!info.width || !info.height) {
        const dimMatch = text.match(/(\d{2,5})x(\d{2,5})/);
        if (dimMatch) {
          info.width = parseInt(dimMatch[1], 10);
          info.height = parseInt(dimMatch[2], 10);
        }
      }
      if (!info.frameRate) {
        const fpsMatch = text.match(/(\d+(?:\.\d+)?)\s*fps/i);
        if (fpsMatch) info.frameRate = parseFloat(fpsMatch[1]);
      }
      if (!info.frameRate) {
        const tbrMatch = text.match(/(\d+(?:\.\d+)?)\s*tbr/i);
        if (tbrMatch) info.frameRate = parseFloat(tbrMatch[1]);
      }
    });

    proc.on("close", () => {
      resolve(info);
    });
    proc.on("error", () => resolve(info));
  });
}

async function prepareVideoForAnalysis(localVideoPath) {
  const info = await getVideoStreamInfo(localVideoPath);
  const isH264 = info.codec && /h264/i.test(info.codec);
  const hasGoodFps = Number.isFinite(info.frameRate) && info.frameRate >= 12 && info.frameRate <= 120;
  const needsNormalize = !(isH264 && hasGoodFps);

  if (!needsNormalize) {
    return {
      preparedPath: localVideoPath,
      cleanupPrepared: false,
      info: {
        ...info,
        frameRate: info.frameRate || 30,
      },
    };
  }

  const normalizedPath = path.join(os.tmpdir(), `normalized_${Date.now()}.mp4`);
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        "-y",
        "-i", localVideoPath,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-r", "30",
        "-vsync", "cfr",
        "-an",
        normalizedPath,
      ]);
      proc.on("close", (code) => {
        if (code === 0 || code === 1) resolve();
        else reject(new Error(`Normalization failed with code ${code}`));
      });
      proc.on("error", reject);
    });

    const normalizedInfo = await getVideoStreamInfo(normalizedPath);
    return {
      preparedPath: normalizedPath,
      cleanupPrepared: true,
      info: {
        ...normalizedInfo,
        frameRate: normalizedInfo.frameRate || 30,
      },
    };
  } catch (e) {
    // If normalization fails in cloud runtime, continue with original input.
    if (fs.existsSync(normalizedPath)) fs.unlinkSync(normalizedPath);
    return {
      preparedPath: localVideoPath,
      cleanupPrepared: false,
      info: {
        ...info,
        frameRate: info.frameRate || 30,
      },
    };
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function estimateYellowDominance(frameData, width, height, sampleStep = 4) {
  let yellowCount = 0;
  let brightCount = 0;
  let samples = 0;

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const offset = (y * width + x) * 3;
      const r = frameData[offset];
      const g = frameData[offset + 1];
      const b = frameData[offset + 2];
      if (r == null || g == null || b == null) continue;

      const bright = (r + g + b) / 3 > 90;
      if (bright) brightCount++;

      // Wide yellow rule (not exact RGB): high R+G, low B, and warm dominance.
      if (
        r > 120 &&
        g > 105 &&
        b < 205 &&
        (r + g) / 2 - b > 10 &&
        r - b > 8 &&
        g - b > 8 &&
        Math.abs(r - g) < 120
      ) {
        yellowCount++;
      }
      samples++;
    }
  }

  if (samples === 0) return { yellowRatio: 0, brightRatio: 0, sampleCount: 0 };
  return {
    yellowRatio: yellowCount / samples,
    brightRatio: brightCount / samples,
    sampleCount: samples,
  };
}

function estimateYellowDominanceCenter(frameData, width, height, sampleStep = 4) {
  const x0 = Math.floor(width * 0.2);
  const x1 = Math.floor(width * 0.8);
  const y0 = Math.floor(height * 0.2);
  const y1 = Math.floor(height * 0.8);
  let yellowCount = 0;
  let samples = 0;

  for (let y = y0; y < y1; y += sampleStep) {
    for (let x = x0; x < x1; x += sampleStep) {
      const offset = (y * width + x) * 3;
      const r = frameData[offset];
      const g = frameData[offset + 1];
      const b = frameData[offset + 2];
      if (r == null || g == null || b == null) continue;
      if (
        r > 120 &&
        g > 105 &&
        b < 205 &&
        (r + g) / 2 - b > 10 &&
        r - b > 8 &&
        g - b > 8 &&
        Math.abs(r - g) < 120
      ) {
        yellowCount++;
      }
      samples++;
    }
  }
  return samples > 0 ? yellowCount / samples : 0;
}

function buildYellowEventsFromFrames(frameDetections, frameRate, minDurationSeconds = 0.06) {
  if (!frameDetections.length) return [];
  const frameInterval = frameRate > 0 ? 1 / frameRate : 1 / 30;
  const minFrames = Math.max(1, Math.ceil(minDurationSeconds / frameInterval));
  const enterThreshold = 0.14;
  const exitThreshold = 0.09;
  const exitDebounceFrames = 1;

  let inEvent = false;
  let eventStartIdx = 0;
  let lastYellowIdx = -1;
  let belowCount = 0;
  let peakYellow = 0;
  let sumYellow = 0;
  let metricFrames = 0;
  const events = [];

  const closeEvent = (endIdx) => {
    const frames = endIdx - eventStartIdx + 1;
    if (frames < minFrames) return;
    const avgYellow = metricFrames > 0 ? sumYellow / metricFrames : 0;
    const confidence = clamp((avgYellow - exitThreshold) / 0.32, 0, 1);
    const startTime = eventStartIdx * frameInterval;
    const endTime = (endIdx + 1) * frameInterval;
    events.push({
      eventIndex: events.length + 1,
      startFrame: eventStartIdx,
      endFrame: endIdx,
      startTime: Math.round(startTime * 1000) / 1000,
      endTime: Math.round(endTime * 1000) / 1000,
      duration: Math.round((endTime - startTime) * 1000) / 1000,
      detectionConfidence: Math.round(confidence * 1000) / 1000,
      metrics: {
        averageYellowRatio: Math.round(avgYellow * 1000) / 1000,
        peakYellowRatio: Math.round(peakYellow * 1000) / 1000,
        frames,
      },
    });
  };

  for (let i = 0; i < frameDetections.length; i++) {
    const frame = frameDetections[i];
    const ratio = frame.yellowRatio;

    if (!inEvent) {
      if (ratio >= enterThreshold) {
        inEvent = true;
        eventStartIdx = i;
        lastYellowIdx = i;
        belowCount = 0;
        peakYellow = ratio;
        sumYellow = ratio;
        metricFrames = 1;
      }
      continue;
    }

    peakYellow = Math.max(peakYellow, ratio);
    sumYellow += ratio;
    metricFrames++;

    if (ratio >= exitThreshold) {
      lastYellowIdx = i;
      belowCount = 0;
    } else {
      belowCount++;
      if (belowCount >= exitDebounceFrames) {
        closeEvent(lastYellowIdx);
        inEvent = false;
      }
    }
  }

  if (inEvent) closeEvent(lastYellowIdx >= 0 ? lastYellowIdx : frameDetections.length - 1);
  return events;
}

/**
 * After a yellow block ends, find the first timecode where the frame is clearly not yellow
 * (so playback can seek to real content, not the tail of a transition).
 */
function attachContentStartsToEvents(frameDetections, frameRate, events) {
  if (!frameDetections.length || !events.length) return events;
  const frameInterval = frameRate > 0 ? 1 / frameRate : 1 / 30;
  const strictNonYellow = 0.072;
  const consecFrames = 2;

  return events.map((ev) => {
    const yellowStart = Math.round(ev.startTime * 1000) / 1000;
    const yellowEnd = Math.round(ev.endTime * 1000) / 1000;

    let idx = ev.endFrame + 1;
    let streak = 0;
    let firstContentFrame = null;
    while (idx < frameDetections.length) {
      const ratio = frameDetections[idx].yellowRatio || 0;
      if (ratio < strictNonYellow) {
        streak++;
        if (streak >= consecFrames) {
          firstContentFrame = idx - consecFrames + 1;
          break;
        }
      } else {
        streak = 0;
      }
      idx++;
    }

    if (firstContentFrame == null) {
      firstContentFrame = Math.min(ev.endFrame + 1, Math.max(0, frameDetections.length - 1));
    }

    let contentStart = Math.round(firstContentFrame * frameInterval * 1000) / 1000;
    contentStart = Math.max(contentStart, yellowEnd);

    return {
      ...ev,
      yellowStart,
      yellowEnd,
      contentStart,
      contentStartFrame: firstContentFrame,
    };
  });
}

/**
 * When regenerating a timeline, keep timing rows the editor explicitly locked.
 */
function mergeManualTimelineOverrides(newSegments, existing) {
  if (!Array.isArray(newSegments) || newSegments.length === 0) return newSegments;
  if (!Array.isArray(existing) || existing.length === 0) return newSegments;

  const byChapter = new Map();
  for (const seg of existing) {
    if (seg && seg.manualOverride === true && seg.chapterIndex != null) {
      byChapter.set(seg.chapterIndex, seg);
    }
  }
  if (byChapter.size === 0) return newSegments;

  return newSegments.map((neu) => {
    if (!neu || neu.chapterIndex == null || !byChapter.has(neu.chapterIndex)) return neu;
    const old = byChapter.get(neu.chapterIndex);
    return {
      ...neu,
      src_start: old.src_start,
      src_end: old.src_end,
      contentStart: old.contentStart != null ? old.contentStart : old.src_start,
      contentEnd: old.contentEnd != null ? old.contentEnd : old.src_end,
      yellowStart: old.yellowStart != null ? old.yellowStart : neu.yellowStart,
      yellowEnd: old.yellowEnd != null ? old.yellowEnd : neu.yellowEnd,
      manualOverride: true,
      menuLink: old.menuLink != null && String(old.menuLink).trim() !== ""
        ? old.menuLink
        : neu.menuLink,
      title: old.title != null && String(old.title).trim() !== ""
        ? old.title
        : neu.title,
      flagged: old.flagged != null ? old.flagged : neu.flagged,
    };
  });
}

function detectYellowEventsDense(video, streamInfo) {
  return new Promise((resolve, reject) => {
    const sourceWidth = Number.isFinite(streamInfo.width) ? streamInfo.width : 1280;
    const sourceHeight = Number.isFinite(streamInfo.height) ? streamInfo.height : 720;
    const frameRate = Number.isFinite(streamInfo.frameRate) && streamInfo.frameRate > 0 ? streamInfo.frameRate : 30;

    const targetWidth = Math.min(480, sourceWidth);
    const targetHeight = Math.max(2, Math.floor((sourceHeight / sourceWidth) * targetWidth / 2) * 2);
    const frameSize = targetWidth * targetHeight * 3;
    let buffer = Buffer.alloc(0);
    const frameDetections = [];

    const proc = spawn(ffmpegPath, [
      "-i", video,
      "-vf", `scale=${targetWidth}:${targetHeight}:flags=fast_bilinear`,
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-vsync", "cfr",
      "-an",
      "-",
    ]);

    proc.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= frameSize) {
        const frameData = buffer.slice(0, frameSize);
        buffer = buffer.slice(frameSize);
        const full = estimateYellowDominance(frameData, targetWidth, targetHeight, 4);
        const center = estimateYellowDominanceCenter(frameData, targetWidth, targetHeight, 4);
        const combined = Math.max(full, center * 0.85 + full * 0.15);
        frameDetections.push({
          yellowRatio: combined,
          fullYellowRatio: full,
          centerYellowRatio: center,
        });
      }
    });
    proc.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        reject(new Error(`Dense yellow detection failed (ffmpeg code ${code})`));
        return;
      }
      const rawEvents = buildYellowEventsFromFrames(frameDetections, frameRate, 0.06);
      const yellowEvents = attachContentStartsToEvents(frameDetections, frameRate, rawEvents);
      const maxYellowRatio = frameDetections.reduce((m, f) => Math.max(m, f.yellowRatio || 0), 0);
      const avgYellowRatio = frameDetections.length
        ? frameDetections.reduce((s, f) => s + (f.yellowRatio || 0), 0) / frameDetections.length
        : 0;
      resolve({
        frameRate,
        frameCount: frameDetections.length,
        yellowEvents,
        detectionSummary: {
          maxYellowRatio: Math.round(maxYellowRatio * 1000) / 1000,
          avgYellowRatio: Math.round(avgYellowRatio * 1000) / 1000,
        },
      });
    });
    proc.on("error", reject);
  });
}

function deriveYellowRangesFromEvents(events) {
  return events.map((e) => ({
    start: Math.round((e.yellowStart != null ? e.yellowStart : e.startTime) * 1000) / 1000,
    end: Math.round((e.yellowEnd != null ? e.yellowEnd : e.endTime) * 1000) / 1000,
  }));
}

function mapYellowEventsToChapters(chapterTitles, yellowEvents) {
  const chapters = chapterTitles || [];
  const events = yellowEvents || [];
  const mappedCount = Math.min(chapters.length, events.length);
  const mappings = [];
  const states = [];

  for (let i = 0; i < mappedCount; i++) {
    mappings.push({
      chapterIndex: i + 1,
      title: chapters[i],
      event: events[i],
      flagged: false,
      status: "ok",
      confidence: events[i].detectionConfidence,
    });
  }

  if (chapters.length > events.length) {
    states.push("missingYellowEvents");
    for (let i = mappedCount; i < chapters.length; i++) {
      mappings.push({
        chapterIndex: i + 1,
        title: chapters[i],
        event: null,
        flagged: true,
        status: "missingYellowEvent",
        confidence: 0,
      });
    }
  }

  let extraEvents = [];
  if (events.length > chapters.length) {
    states.push("extraYellowEvents");
    extraEvents = events.slice(chapters.length);
  }

  const lowConfidence = mappings.some((m) => m.event && m.confidence < 0.55);
  if (lowConfidence) states.push("lowConfidenceMapping");
  if (states.length > 0) states.push("needsManualReview");

  return {
    mappings,
    extraEvents,
    review: {
      states: [...new Set(states)],
      chapterCount: chapters.length,
      detectedEventCount: events.length,
      mappedCount,
      needsManualReview: states.length > 0,
    },
  };
}

function generateChapterAwareSrcArray(mappings, duration) {
  const srcArray = [{
    src_start: null,
    src_end: null,
    freezeFrame: null,
    menuLink: "Opening",
    side: false,
    loop: false,
  }];

  if (!mappings.length) {
    srcArray.push({
      index: 0,
      chapterIndex: 1,
      title: "Unmapped Segment",
      contentStart: 0,
      contentEnd: Math.round(duration * 1000) / 1000,
      yellowStart: null,
      yellowEnd: null,
      start: 0,
      end: Math.round(duration * 1000) / 1000,
      src_start: 0,
      src_end: Math.round(duration * 1000) / 1000,
      menuLink: "",
      freezeFrame: 0,
      source: "yellow-detection",
      confidence: 0,
      status: "needsManualReview",
      flagged: true,
      manualOverride: false,
      side: false,
      loop: false,
    });
    return srcArray;
  }

  for (let i = 0; i < mappings.length; i++) {
    const current = mappings[i];
    const next = mappings[i + 1] || null;
    const ev = current.event;

    let yellowStart = null;
    let yellowEnd = null;
    let contentStart = null;
    let contentEnd = next && next.event
      ? (next.event.yellowStart != null ? next.event.yellowStart : next.event.startTime)
      : duration;

    if (ev) {
      yellowStart = ev.yellowStart != null ? ev.yellowStart : ev.startTime;
      yellowEnd = ev.yellowEnd != null ? ev.yellowEnd : ev.endTime;
      contentStart = ev.contentStart != null ? ev.contentStart : ev.endTime;
      contentStart = Math.max(contentStart, yellowEnd);
    }

    let flagged = !!current.flagged;
    let status = current.status || "ok";

    if (ev == null) {
      flagged = true;
      status = status === "ok" ? "missingYellowEvent" : status;
    }

    if (!Number.isFinite(contentStart) || !Number.isFinite(contentEnd) || contentEnd <= contentStart) {
      flagged = true;
      status = status === "ok" ? "invalidSegmentBounds" : status;
      if (!Number.isFinite(contentStart)) contentStart = null;
      if (!Number.isFinite(contentEnd) && Number.isFinite(contentStart)) {
        contentEnd = Math.min(duration, contentStart + 0.01);
      }
    }

    const rs = contentStart != null ? Math.round(contentStart * 1000) / 1000 : null;
    const re = contentEnd != null ? Math.round(contentEnd * 1000) / 1000 : null;

    srcArray.push({
      index: i,
      chapterIndex: current.chapterIndex,
      title: current.title,
      yellowStart: yellowStart != null ? Math.round(yellowStart * 1000) / 1000 : null,
      yellowEnd: yellowEnd != null ? Math.round(yellowEnd * 1000) / 1000 : null,
      contentStart: rs,
      contentEnd: re,
      start: rs,
      end: re,
      src_start: rs,
      src_end: re,
      menuLink: current.title || "",
      freezeFrame: i,
      source: "yellow-pipeline",
      confidence: Math.round((current.confidence || 0) * 1000) / 1000,
      status,
      flagged,
      manualOverride: false,
      side: false,
      loop: false,
    });
  }

  return srcArray;
}

async function runDeterministicYellowPipeline({ lessonId, localVideoPath, chapterTitles, sourceLabel }) {
  // Stage 1: prep / normalize only if stream is clearly unsuitable.
  const prepared = await prepareVideoForAnalysis(localVideoPath);
  const analysisDuration = await getDuration(prepared.preparedPath);

  try {
    // Stage 2: dense sequential yellow detection with event state machine.
    const detection = await detectYellowEventsDense(prepared.preparedPath, prepared.info);
    const yellowEvents = detection.yellowEvents;
    const yellowRanges = deriveYellowRangesFromEvents(yellowEvents);

    // Stage 3: deterministic ordered chapter mapping (bootstrap strategy).
    const effectiveChapterTitles = (chapterTitles && chapterTitles.length > 0)
      ? chapterTitles
      : yellowEvents.map((_, i) => `Chapter ${i + 1}`);
    const mapping = mapYellowEventsToChapters(effectiveChapterTitles, yellowEvents);

    // Stage 4: chapter-aware srcArray proposal generation.
    const srcArray = generateChapterAwareSrcArray(mapping.mappings, analysisDuration);

    // Stage 5: explicit review/mismatch states, easy to render in admin.
    const review = {
      ...mapping.review,
      source: sourceLabel || "pipeline",
      duration: analysisDuration,
      frameRate: detection.frameRate,
      frameCount: detection.frameCount,
      detectionSummary: detection.detectionSummary || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Stage 6 hook: reserved shape for future GPT frame refinement.
      refinementHook: {
        ready: true,
        strategy: "gpt-vision-future",
        callable: "refineFlaggedTimelineSegment",
        notes: "Per-segment AI hook; does not run automatically.",
      },
    };

    return {
      srcArray,
      yellowRanges,
      yellowEvents,
      chapterTimeline: mapping.mappings,
      review,
      duration: analysisDuration,
      extraEvents: mapping.extraEvents,
      detectionSummary: detection.detectionSummary || null,
    };
  } finally {
    if (prepared.cleanupPrepared && fs.existsSync(prepared.preparedPath)) {
      fs.unlinkSync(prepared.preparedPath);
    }
  }
}

// Build srcArray only from the complement of yellow (non-yellow intervals).
// Segments: [0, firstYellow.start], [yellow[i].end, yellow[i+1].start], ..., [lastYellow.end, duration].
// No segment overlaps any yellow range; leapfrog uses exact stored yellowScreenRanges.
function buildSrcArrayFromYellow(yellowRanges, duration, minSegmentSeconds) {
  const arr = [];
  let freeze = 0;

  arr.push({
    src_start: null,
    src_end: null,
    freezeFrame: null,
    menuLink: "Opening",
    side: false,
    loop: false,
  });

  const minSegment = Number.isFinite(minSegmentSeconds) && minSegmentSeconds > 0 ? minSegmentSeconds : 0.05;

  if (!yellowRanges || yellowRanges.length === 0) {
    arr.push({
      src_start: 0,
      src_end: Math.round(duration * 100) / 100,
      freezeFrame: freeze++,
      menuLink: "",
      side: false,
      loop: false,
    });
    return arr;
  }

  const ranges = [...yellowRanges].sort((a, b) => {
    const as = typeof a.start === "number" ? a.start : 0;
    const bs = typeof b.start === "number" ? b.start : 0;
    return as - bs;
  });

  // Content before first yellow
  const firstStart = typeof ranges[0].start === "number" ? ranges[0].start : 0;
  if (firstStart >= minSegment) {
    arr.push({
      src_start: 0,
      src_end: Math.round(firstStart * 100) / 100,
      freezeFrame: freeze++,
      menuLink: "",
      side: false,
      loop: false,
    });
  }

  // Gaps between yellow ranges
  for (let i = 0; i < ranges.length; i++) {
    const endYellow = typeof ranges[i].end === "number" ? ranges[i].end : 0;
    const startNext = ranges[i + 1] && typeof ranges[i + 1].start === "number"
      ? ranges[i + 1].start
      : duration;
    const start = Math.max(0, endYellow);
    const end = i + 1 < ranges.length ? startNext : duration;
    if (end - start >= minSegment) {
      arr.push({
        src_start: Math.round(start * 100) / 100,
        src_end: Math.round(end * 100) / 100,
        freezeFrame: freeze++,
        menuLink: "",
        side: false,
        loop: false,
      });
    }
  }

  return arr;
}

// Fallback: original scene-based srcArray builder
function buildSceneBasedSrcArray(scenes, duration) {
  const boundaries = [0, ...scenes, duration];

  const arr = [];
  let freeze = 0;

  arr.push({
    src_start: null,
    src_end: null,
    freezeFrame: null,
    menuLink: "Opening",
    side: false,
    loop: false,
  });

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];

    if (end - start < 0.4) continue; // skip very short flashes

    arr.push({
      src_start: Math.round(start * 100) / 100,
      src_end: Math.round(end * 100) / 100,
      freezeFrame: freeze++,
      menuLink: "",
      side: false,
      loop: false,
    });
  }

  return arr;
}

// Cloud Function to detect yellow screen frames, store ranges, and write a cleaned srcArray
// (while preserving originalSrcArray for restore).
exports.detectYellowScreen = onCall(
  {
    memory: "2GiB",
    timeoutSeconds: 300,
  },
  async (request) => {
    const { videoPath, lessonId } = request.data;
    if (!videoPath || !lessonId) {
      throw new Error("videoPath and lessonId are required");
    }

    const bucket = admin.storage().bucket();
    const tmpFile = path.join(os.tmpdir(), `yellow_detect_${Date.now()}.mp4`);

    try {
      await bucket.file(videoPath).download({ destination: tmpFile });
      const chapterTitles = await loadOrderedChapterTitles(lessonId);
      const pipeline = await runDeterministicYellowPipeline({
        lessonId,
        localVideoPath: tmpFile,
        chapterTitles,
        sourceLabel: "manual-yellow-regenerate",
      });

      const existingDoc = await db.collection("lessons").doc(lessonId).get();
      const existing = existingDoc.exists ? (existingDoc.data().srcArray || []) : [];
      const srcArray = mergeManualTimelineOverrides(pipeline.srcArray, existing);

      await db.collection("lessons").doc(lessonId).set({
        srcArray,
        originalSrcArray: srcArray,
        yellowScreenRanges: pipeline.yellowRanges,
        yellowScreenEvents: pipeline.yellowEvents,
        chapterTimeline: pipeline.chapterTimeline,
        timelineReview: pipeline.review,
        timelinePipeline: {
          version: "yellow-content-v2",
          source: "manual-yellow-regenerate",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      }, { merge: true });

      return {
        success: true,
        yellowRanges: pipeline.yellowRanges,
        yellowEvents: pipeline.yellowEvents.length,
        adjustedSegments: srcArray.length,
        reviewStates: pipeline.review.states,
      };
    } catch (error) {
      console.error("Error detecting yellow screen:", error);
      throw new Error(`Yellow screen detection failed: ${error.message}`);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }
);

// Manually generate a srcArray for a lesson's assigned video using yellow detection
// with configurable sampling FPS and minimum non-yellow segment length.
exports.generateSrcArrayWithYellowOptions = onCall(
  {
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    const { videoPath, lessonId, fps, minSegmentSeconds } = request.data || {};
    if (!videoPath || !lessonId) {
      throw new Error("videoPath and lessonId are required");
    }

    const effectiveFps = Number.isFinite(fps) && fps > 0 ? fps : 10;
    const effectiveMinSeg = Number.isFinite(minSegmentSeconds) && minSegmentSeconds > 0 ? minSegmentSeconds : 0.05;

    const bucket = admin.storage().bucket();
    const tmpFile = path.join(os.tmpdir(), `yellow_manual_${Date.now()}.mp4`);

    try {
      await bucket.file(videoPath).download({ destination: tmpFile });

      const chapterTitles = await loadOrderedChapterTitles(lessonId);
      const pipeline = await runDeterministicYellowPipeline({
        lessonId,
        localVideoPath: tmpFile,
        chapterTitles,
        sourceLabel: "manual-editor",
      });

      const existingDoc = await db.collection("lessons").doc(lessonId).get();
      const existing = existingDoc.exists ? (existingDoc.data().srcArray || []) : [];
      const srcArray = mergeManualTimelineOverrides(pipeline.srcArray, existing);

      await db.collection("lessons").doc(lessonId).set(
        {
          srcArray,
          originalSrcArray: srcArray,
          yellowScreenRanges: pipeline.yellowRanges,
          yellowScreenEvents: pipeline.yellowEvents,
          chapterTimeline: pipeline.chapterTimeline,
          timelineReview: pipeline.review,
          timelinePipeline: {
            version: "yellow-content-v2",
            source: "manual-editor",
            status: "ok",
            note: "Dense detection; fps/minSegmentSeconds are recorded for reference only",
            requestedFps: effectiveFps,
            requestedMinSegmentSeconds: effectiveMinSeg,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

      return {
        success: true,
        segments: srcArray.length,
        yellowRanges: pipeline.yellowRanges.length,
        duration: pipeline.duration,
        reviewStates: pipeline.review.states || [],
        fps: effectiveFps,
        minSegmentSeconds: effectiveMinSeg,
      };
    } catch (error) {
      console.error("generateSrcArrayWithYellowOptions failed:", error);
      throw new Error(`generateSrcArrayWithYellowOptions failed: ${error.message}`);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }
);

// Detect yellow screen frames using raw RGB frame data and LAB color space.
// Optional options: { fps, sampleStep, yellowPixelThreshold, deltaEThreshold }
// Avoids all FFmpeg color filters - uses raw video output and pixel sampling.
// Returns yellow frame ranges after converting raw detections to contiguous spans.
function detectYellowFrames(video, options = {}) {
  return new Promise((resolve, reject) => {
    const yellowFrames = [];
    let videoWidth = null;
    let videoHeight = null;
    const frameRate = Number.isFinite(options.fps) && options.fps > 0 ? options.fps : 10;
    let frameIndex = 0;
    let frameBuffer = Buffer.alloc(0);
    
    // Yellow target in LAB color space
    const yellowLAB = { L: 97, A: -21, B: 94 };
    // Tuned defaults; caller may override via options.
    const deltaEThreshold = options.deltaEThreshold != null ? options.deltaEThreshold : 55;
    const sampleStep = options.sampleStep != null ? options.sampleStep : 24;
    const yellowPixelThreshold = options.yellowPixelThreshold != null ? options.yellowPixelThreshold : 0.4;

    // First, get video dimensions from FFmpeg
    getVideoDimensions(video).then(({ width, height }) => {
      videoWidth = width;
      videoHeight = height;
      const frameSize = width * height * 3; // RGB24 = 3 bytes per pixel

      // Use ffmpeg to output raw RGB frames at the requested fps for accurate yellow ranges
      const proc = spawn(ffmpegPath, [
        "-i", video,
        "-vf", `fps=${frameRate}`,
        "-f", "image2pipe",
        "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24",
        "-"
      ]);

      proc.stdout.on("data", (data) => {
        // Accumulate frame data
        frameBuffer = Buffer.concat([frameBuffer, data]);

        // Process complete frames
        while (frameBuffer.length >= frameSize) {
          const frameData = frameBuffer.slice(0, frameSize);
          frameBuffer = frameBuffer.slice(frameSize);

          // Sample pixels and check for yellow
          const yellowPixelCount = sampleFrameForYellow(
            frameData,
            videoWidth,
            videoHeight,
            sampleStep,
            yellowLAB,
            deltaEThreshold
          );

          const totalSamples = Math.floor(videoWidth / sampleStep) * Math.floor(videoHeight / sampleStep);
          const yellowRatio = yellowPixelCount / totalSamples;

          if (yellowRatio > yellowPixelThreshold) {
            const time = frameIndex / frameRate;
            yellowFrames.push({ frame: frameIndex, time });
          }

          frameIndex++;
        }
      });

      proc.stderr.on("data", (data) => {
        // FFmpeg info/errors go to stderr, but we don't need to parse it
      });

      proc.on("close", (code) => {
        if (code !== 0 && code !== 1) {
          reject(new Error(`FFmpeg process failed with code ${code}`));
          return;
        }

        // Convert raw {frame, time} entries to time ranges (exact per-card duration: end = lastFrameTime + 1/fps)
        const sortedTimes = yellowFrames.map((e) => e.time).sort((a, b) => a - b);
        const frameInterval = 1 / frameRate;
        const yellowRanges = framesToRanges(sortedTimes, frameInterval);
        console.log("Detected yellow ranges:", yellowRanges);
        resolve(yellowRanges);
      });

      proc.on("error", (error) => {
        reject(error);
      });
    }).catch(reject);
  });
}

// Get video dimensions from FFmpeg
function getVideoDimensions(video) {
  return new Promise((resolve, reject) => {
    let width = null;
    let height = null;

    const proc = spawn(ffmpegPath, [
      "-i", video,
      "-f", "null", "-"
    ]);

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      // Look for video stream info: "Stream #0:0 ... Video: ... 1484x1080"
      const match = text.match(/(\d+)x(\d+)/);
      if (match && !width) {
        width = parseInt(match[1], 10);
        height = parseInt(match[2], 10);
      }
    });

    proc.on("close", () => {
      if (width && height) {
        resolve({ width, height });
      } else {
        reject(new Error("Could not determine video dimensions"));
      }
    });

    proc.on("error", reject);
  });
}

// Sample frame pixels and count yellow pixels using LAB color space
function sampleFrameForYellow(frameData, width, height, sampleStep, yellowLAB, deltaEThreshold) {
  let yellowCount = 0;
  let totalSamples = 0;

  // Sample every Nth pixel horizontally and vertically
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      // Calculate pixel offset in buffer (RGB24 format)
      const offset = (y * width + x) * 3;
      
      if (offset + 2 < frameData.length) {
        // Read RGB values
        const R = frameData[offset];
        const G = frameData[offset + 1];
        const B = frameData[offset + 2];

        // Convert RGB to LAB
        const pixelLAB = convert.rgb.lab([R, G, B]);

        // Calculate ΔE distance (CIE76)
        const deltaE = calculateDeltaE(pixelLAB, yellowLAB);

        if (deltaE < deltaEThreshold) {
          yellowCount++;
        }
        totalSamples++;
      }
    }
  }

  return yellowCount;
}

// Calculate ΔE (CIE76) color distance between two LAB colors
// lab1 is array [L, A, B] from color-convert, lab2 is object {L, A, B}
function calculateDeltaE(lab1, lab2) {
  const dL = lab1[0] - lab2.L;
  const dA = lab1[1] - lab2.A;
  const dB = lab1[2] - lab2.B;
  return Math.sqrt(dL * dL + dA * dA + dB * dB);
}

// Convert frame detections to time ranges. Uses actual per-card duration: end = last frame time + frameInterval.
// frameInterval = 1/fps so each yellow card's length is measured, not assumed.
function framesToRanges(sortedFrameTimes, frameInterval) {
  if (sortedFrameTimes.length === 0) return [];
  const gapThreshold = Math.max(1.5 * (frameInterval || 0.1), 0.15); // same card if within ~1.5 frames
  const interval = frameInterval != null && frameInterval > 0 ? frameInterval : 0.1;

  const ranges = [];
  let rangeStart = sortedFrameTimes[0];
  let rangeEnd = sortedFrameTimes[0];

  for (let i = 1; i < sortedFrameTimes.length; i++) {
    const t = sortedFrameTimes[i];
    if (t - rangeEnd <= gapThreshold) {
      rangeEnd = t;
    } else {
      ranges.push({
        start: Math.round(rangeStart * 100) / 100,
        end: Math.round((rangeEnd + interval) * 100) / 100 // one frame past last yellow
      });
      rangeStart = t;
      rangeEnd = t;
    }
  }
  ranges.push({
    start: Math.round(rangeStart * 100) / 100,
    end: Math.round((rangeEnd + interval) * 100) / 100
  });

  const merged = mergeYellowRanges(ranges);
  // Drop very short blips (e.g. single-frame noise) so they don't create tiny segments
  return filterShortYellowRanges(merged, 0.2);
}

// Merge yellow ranges that are close together (within 0.5 seconds)
function mergeYellowRanges(ranges) {
  if (ranges.length === 0) return [];
  const merged = [];
  ranges.sort((a, b) => a.start - b.start);
  let current = { ...ranges[0] };
  for (let i = 1; i < ranges.length; i++) {
    const next = ranges[i];
    if (next.start - current.end < 0.5) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

// Remove yellow ranges shorter than minDuration (seconds) to avoid single-frame false positives
function filterShortYellowRanges(ranges, minDuration) {
  if (!ranges.length || minDuration <= 0) return ranges;
  return ranges.filter(r => typeof r.start === "number" && typeof r.end === "number" && (r.end - r.start) >= minDuration);
}

// Adjust srcArray to skip yellow screen ranges completely:
// - Any segment fully inside a yellow range is dropped.
// - Any segment that touches a yellow range is truncated so its end never enters yellow.
//   (We keep only the pre-yellow portion; we do NOT keep a "tail" after yellow.)
function adjustSrcArrayForYellowScreen(srcArray, yellowRanges) {
  if (!yellowRanges || yellowRanges.length === 0) {
    return srcArray; // No yellow screens detected, return original
  }

  const adjusted = [];
  const ranges = (yellowRanges || []).slice().sort((a, b) => a.start - b.start);

  for (const segment of srcArray) {
    // Keep opening segment (no timing)
    if (segment.src_start === null || segment.src_end === null) {
      adjusted.push(segment);
      continue;
    }

    let segmentStart = segment.src_start;
    let segmentEnd = segment.src_end;
    let skip = false;

    for (const r of ranges) {
      const ys = typeof r.start === "number" ? r.start : null;
      const ye = typeof r.end === "number" ? r.end : null;
      if (ys == null || ye == null) continue;

      // Segment entirely inside yellow → drop it
      if (segmentStart >= ys && segmentEnd <= ye) {
        skip = true;
        break;
      }

      // If yellow starts before our end and after our start, clamp segmentEnd
      if (ys < segmentEnd && ye > segmentStart) {
        // We only keep content strictly before the yellow card
        segmentEnd = Math.min(segmentEnd, ys);
      }
    }

    if (skip) continue;

    if (segmentEnd - segmentStart > 0.1) {
      adjusted.push({
        ...segment,
        src_start: Math.round(segmentStart * 100) / 100,
        src_end: Math.round(segmentEnd * 100) / 100
      });
    }
  }

  return adjusted;
}

// Detect video titles using OCR
// Extracts frames at regular intervals and uses OCR to detect text
// Returns array of { timestamp, text, confidence } objects
async function detectVideoTitles(video, sampleInterval = 0.5) {
  const detectedTitles = [];
  const tmpDir = path.join(os.tmpdir(), `title_detect_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Get video duration first
    const duration = await getDuration(video);
    console.log(`Video duration: ${duration} seconds`);

    // Extract frames at regular intervals
    const framePattern = path.join(tmpDir, "frame_%06d.png");
    const frameRate = 1 / sampleInterval; // frames per second

    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        "-i", video,
        "-vf", `fps=${frameRate}`,
        "-frames:v", Math.ceil(duration * frameRate),
        framePattern
      ]);

      proc.on("close", (code) => {
        if (code === 0 || code === 1) resolve(); // 1 is sometimes OK
        else reject(new Error(`FFmpeg frame extraction failed with code ${code}`));
      });

      proc.on("error", reject);
    });

    // Get list of extracted frames
    const frameFiles = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith("frame_") && f.endsWith(".png"))
      .sort();

    console.log(`Extracted ${frameFiles.length} frames for OCR`);

    // Initialize Tesseract worker
    const worker = await createWorker("eng");

    // Process each frame with OCR
    for (let i = 0; i < frameFiles.length; i++) {
      const frameFile = path.join(tmpDir, frameFiles[i]);
      const timestamp = i * sampleInterval;

      try {
        const { data: { text, confidence } } = await worker.recognize(frameFile);

        // Filter for significant text content (title-like)
        const cleanText = text.trim();
        if (cleanText.length >= 3 && confidence > 50) {
          // Check if text looks like a title (not too long, has some structure)
          const lines = cleanText.split("\n").filter(l => l.trim().length > 0);
          if (lines.length <= 5 && cleanText.length < 100) {
            detectedTitles.push({
              timestamp: Math.round(timestamp * 100) / 100,
              text: cleanText,
              confidence: Math.round(confidence)
            });
          }
        }
      } catch (error) {
        console.error(`Error processing frame ${frameFile}:`, error);
      }
    }

    await worker.terminate();

    // Remove duplicate titles at similar timestamps (within 1 second)
    const uniqueTitles = [];
    for (const title of detectedTitles) {
      const isDuplicate = uniqueTitles.some(existing =>
        Math.abs(existing.timestamp - title.timestamp) < 1.0 &&
        existing.text.toLowerCase() === title.text.toLowerCase()
      );
      if (!isDuplicate) {
        uniqueTitles.push(title);
      }
    }

    console.log(`Detected ${uniqueTitles.length} unique titles`);
    return uniqueTitles.sort((a, b) => a.timestamp - b.timestamp);

  } catch (error) {
    console.error("Error detecting video titles:", error);
    throw error;
  } finally {
    // Clean up temp directory
    if (fs.existsSync(tmpDir)) {
      fs.readdirSync(tmpDir).forEach(file => {
        fs.unlinkSync(path.join(tmpDir, file));
      });
      fs.rmdirSync(tmpDir);
    }
  }
}

// Calculate Levenshtein distance for fuzzy string matching
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1
        );
      }
    }
  }

  return matrix[len1][len2];
}

// Calculate similarity score between two strings (0-1, higher is better)
function stringSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  if (s1 === s2) return 1.0;
  
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  
  const distance = levenshteinDistance(s1, s2);
  return 1 - (distance / maxLen);
}

// Match detected titles to segments
// Returns object mapping segment indices to title matches
function matchTitlesToSegments(detectedTitles, segmentLinks, srcArray) {
  const matches = {
    // For segments with existing menuLink: { segmentIndex, title, timestamp }
    refineExisting: [],
    // For unmapped segments: { segmentIndex, title, timestamp, menuLink }
    assignNew: []
  };

  // Get all available segment link labels
  const availableLabels = segmentLinks.map(link => link.label);
  
  // Get segments with existing menuLinks
  const segmentsWithMenuLinks = srcArray
    .map((seg, idx) => ({ segment: seg, index: idx }))
    .filter(({ segment }) => segment.menuLink && segment.menuLink !== "" && segment.menuLink !== "Opening");

  // Get unmapped segments (those without menuLink)
  const unmappedSegments = srcArray
    .map((seg, idx) => ({ segment: seg, index: idx }))
    .filter(({ segment }) => 
      segment.src_start !== null && 
      segment.src_end !== null &&
      (!segment.menuLink || segment.menuLink === "")
    );

  // Match detected titles to existing menuLinks (for boundary refinement)
  for (const { segment, index } of segmentsWithMenuLinks) {
    const menuLinkText = segment.menuLink;
    let bestMatch = null;
    let bestScore = 0.5; // Minimum similarity threshold

    for (const detectedTitle of detectedTitles) {
      // Try exact match first
      if (detectedTitle.text.toLowerCase().includes(menuLinkText.toLowerCase()) ||
          menuLinkText.toLowerCase().includes(detectedTitle.text.toLowerCase())) {
        bestMatch = detectedTitle;
        bestScore = 1.0;
        break;
      }

      // Try fuzzy match
      const score = stringSimilarity(detectedTitle.text, menuLinkText);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = detectedTitle;
      }
    }

    if (bestMatch) {
      matches.refineExisting.push({
        segmentIndex: index,
        title: bestMatch.text,
        timestamp: bestMatch.timestamp,
        confidence: bestMatch.confidence,
        similarity: bestScore
      });
    }
  }

  // Match detected titles to available segment links (for assignment to unmapped segments)
  // Use Fuse.js for better fuzzy matching
  const fuse = new Fuse(availableLabels, {
    threshold: 0.4, // 0 = exact match, 1 = match anything
    includeScore: true
  });

  // Match each detected title to available labels
  const titleToLabelMap = new Map();
  for (const detectedTitle of detectedTitles) {
    const results = fuse.search(detectedTitle.text);
    if (results.length > 0 && results[0].score < 0.6) {
      // Good match found
      const matchedLabel = results[0].item;
      if (!titleToLabelMap.has(matchedLabel)) {
        titleToLabelMap.set(matchedLabel, detectedTitle);
      }
    }
  }

  // Assign matched titles to unmapped segments chronologically
  const usedLabels = new Set();
  for (const { segment, index } of unmappedSegments) {
    // Find the closest detected title that matches an available label
    let bestMatch = null;
    let bestLabel = null;
    let minDistance = Infinity;

    for (const [label, title] of titleToLabelMap.entries()) {
      if (usedLabels.has(label)) continue;

      // Check if this title timestamp is close to this segment's start time
      const distance = Math.abs(title.timestamp - segment.src_start);
      if (distance < minDistance && distance < 10) { // Within 10 seconds
        minDistance = distance;
        bestMatch = title;
        bestLabel = label;
      }
    }

    if (bestMatch && bestLabel) {
      matches.assignNew.push({
        segmentIndex: index,
        title: bestMatch.text,
        timestamp: bestMatch.timestamp,
        menuLink: bestLabel,
        confidence: bestMatch.confidence
      });
      usedLabels.add(bestLabel);
    }
  }

  return matches;
}

// Adjust srcArray boundaries and assign missing menuLinks based on title timestamps
function adjustSrcArrayWithTitleTimestamps(srcArray, titleMatches, segmentLinks) {
  const adjusted = srcArray.map(seg => ({ ...seg }));

  // First, refine boundaries for segments with existing menuLinks
  for (const match of titleMatches.refineExisting) {
    const segment = adjusted[match.segmentIndex];
    if (segment && segment.src_start !== null) {
      // Adjust src_start to the detected title timestamp
      const newStart = match.timestamp;
      
      // Ensure we don't overlap with previous segment
      if (match.segmentIndex > 0) {
        const prevSegment = adjusted[match.segmentIndex - 1];
        if (prevSegment.src_end !== null && newStart <= prevSegment.src_end) {
          // Adjust previous segment's end if needed
          prevSegment.src_end = Math.round((newStart - 0.01) * 100) / 100;
        }
      }

      segment.src_start = Math.round(newStart * 100) / 100;
      console.log(`Refined segment ${match.segmentIndex} (${segment.menuLink}) to start at ${segment.src_start}s`);
    }
  }

  // Second, assign menuLinks to unmapped segments
  for (const match of titleMatches.assignNew) {
    const segment = adjusted[match.segmentIndex];
    if (segment && (!segment.menuLink || segment.menuLink === "")) {
      segment.menuLink = match.menuLink;
      
      // Also adjust src_start to the detected title timestamp
      if (segment.src_start !== null) {
        const newStart = match.timestamp;
        
        // Ensure we don't overlap with previous segment
        if (match.segmentIndex > 0) {
          const prevSegment = adjusted[match.segmentIndex - 1];
          if (prevSegment.src_end !== null && newStart <= prevSegment.src_end) {
            prevSegment.src_end = Math.round((newStart - 0.01) * 100) / 100;
          }
        }

        segment.src_start = Math.round(newStart * 100) / 100;
      }

      console.log(`Assigned menuLink "${match.menuLink}" to segment ${match.segmentIndex} at ${segment.src_start}s`);
    }
  }

  // Ensure no overlapping segments
  for (let i = 1; i < adjusted.length; i++) {
    const prev = adjusted[i - 1];
    const curr = adjusted[i];

    if (prev.src_end !== null && curr.src_start !== null) {
      if (curr.src_start <= prev.src_end) {
        // Adjust current segment start to be just after previous
        curr.src_start = Math.round((prev.src_end + 0.01) * 100) / 100;
      }
    }
  }

  return adjusted;
}

// Cloud Function to detect video titles and adjust srcArray timing
exports.detectVideoTitles = onCall(
  {
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    const { videoPath, lessonId, segmentLinks } = request.data;
    if (!videoPath || !lessonId) {
      throw new Error("videoPath and lessonId are required");
    }

    const bucket = admin.storage().bucket();
    const tmpFile = path.join(os.tmpdir(), `title_detect_${Date.now()}.mp4`);

    try {
      console.log("Downloading video for title detection:", videoPath);
      await bucket.file(videoPath).download({ destination: tmpFile });

      const lessonDoc = await db.collection("lessons").doc(lessonId).get();
      if (!lessonDoc.exists) {
        throw new Error(`Lesson timeline not found: ${lessonId}`);
      }
      const srcArray = (lessonDoc.data().srcArray) || [];
      if (srcArray.length === 0) {
        throw new Error(`srcArray is empty for lesson: ${lessonId}`);
      }

      console.log("Detecting titles in video...");
      const detectedTitles = await detectVideoTitles(tmpFile);
      console.log(`Detected ${detectedTitles.length} titles:`, detectedTitles);

      // Get segment links - use provided segmentLinks or extract from existing menuLinks
      let segmentLinksToUse = segmentLinks || [];
      
      if (segmentLinksToUse.length === 0) {
        // Fallback: extract from existing menuLinks in srcArray
        const existingMenuLinks = srcArray
          .filter(seg => seg.menuLink && seg.menuLink !== "" && seg.menuLink !== "Opening")
          .map(seg => ({ label: seg.menuLink }));
        
        const uniqueLabels = [...new Set(existingMenuLinks.map(l => l.label))];
        segmentLinksToUse = uniqueLabels.map(label => ({ label }));
      }

      console.log(`Using ${segmentLinksToUse.length} segment links for matching`);

      // Match detected titles to segments
      console.log("Matching titles to segments...");
      const titleMatches = matchTitlesToSegments(detectedTitles, segmentLinksToUse, srcArray);
      console.log(`Found ${titleMatches.refineExisting.length} matches for existing segments`);
      console.log(`Found ${titleMatches.assignNew.length} new assignments`);

      // Adjust srcArray with title timestamps
      const adjustedSrcArray = adjustSrcArrayWithTitleTimestamps(
        srcArray,
        titleMatches,
        segmentLinksToUse
      );

      await db.collection("lessons").doc(lessonId).set({
        srcArray: adjustedSrcArray,
        titleDetectionResults: {
          detectedTitles: detectedTitles,
          matches: {
            refined: titleMatches.refineExisting.length,
            assigned: titleMatches.assignNew.length
          },
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        }
      }, { merge: true });

      console.log("Title detection and adjustment complete");
      return {
        success: true,
        detectedTitles: detectedTitles.length,
        refinedSegments: titleMatches.refineExisting.length,
        assignedMenuLinks: titleMatches.assignNew.length,
        matches: {
          refineExisting: titleMatches.refineExisting,
          assignNew: titleMatches.assignNew
        }
      };
    } catch (error) {
      console.error("Error detecting video titles:", error);
      throw new Error(`Title detection failed: ${error.message}`);
    } finally {
      // Clean up temp file
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  }
);

// Generate a chapter-aware srcArray using yellow screens in order (no OCR/AI).
// This is a provisional, ordered mapping:
// - If the number of yellow detections is close to the chapter count, it will
//   map chapters to yellow ranges in order.
// - Otherwise it records a status flag so the lesson can be reviewed.
exports.generateSrcArrayFromYellowScreens = onCall(
  {
    memory: "1GiB",
    timeoutSeconds: 300,
  },
  async (request) => {
    const { videoPath, lessonId, chapters } = request.data;
    if (!videoPath || !lessonId || !Array.isArray(chapters)) {
      throw new Error("videoPath, lessonId and chapters[] are required");
    }

    const bucket = admin.storage().bucket();
    const tmpFile = path.join(os.tmpdir(), `srcarray_yellow_${Date.now()}.mp4`);

    try {
      await bucket.file(videoPath).download({ destination: tmpFile });
      const pipeline = await runDeterministicYellowPipeline({
        lessonId,
        localVideoPath: tmpFile,
        chapterTitles: chapters,
        sourceLabel: "manual-generate-from-yellow",
      });

      const existingDoc = await db.collection("lessons").doc(lessonId).get();
      const existing = existingDoc.exists ? (existingDoc.data().srcArray || []) : [];
      const mergedSrc = mergeManualTimelineOverrides(pipeline.srcArray, existing);

      await db.collection("lessons").doc(lessonId).set(
        {
          srcArray: mergedSrc,
          originalSrcArray: mergedSrc,
          yellowScreenRanges: pipeline.yellowRanges,
          yellowScreenEvents: pipeline.yellowEvents,
          chapterTimeline: pipeline.chapterTimeline,
          timelineReview: pipeline.review,
          autoMapping: {
            method: "yellowSequentialDeterministic",
            lessonId,
            videoPath,
            chapters: chapters.length,
            detections: pipeline.yellowEvents.length,
            states: pipeline.review.states,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

      return {
        success: true,
        status: pipeline.review.needsManualReview ? "needs_review" : "ok",
        chapters: chapters.length,
        detections: pipeline.yellowEvents.length,
        reason: pipeline.review.states.join(", "),
        segments: mergedSrc.length,
        states: pipeline.review.states,
      };
    } catch (error) {
      console.error("Error generating srcArray from yellow screens:", error);
      throw new Error(`generateSrcArrayFromYellowScreens failed: ${error.message}`);
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  }
);

/**
 * Isolated hook for future per-segment vision/LLM refinement (OpenAI, etc.).
 * Deterministic pipeline only until frames are extracted and merged here.
 */
exports.refineFlaggedTimelineSegment = onCall(
  {
    memory: "1GiB",
    timeoutSeconds: 120,
  },
  async (request) => {
    const data = request.data || {};
    const { lessonId } = data;
    const segmentRef = data.segmentId != null ? data.segmentId : data.segmentIndex;
    if (!lessonId || segmentRef == null) {
      throw new Error("lessonId and segmentId (or segmentIndex) are required");
    }
    const idx = parseInt(String(segmentRef), 10);
    if (!Number.isFinite(idx) || idx < 0) {
      throw new Error("segmentIndex must be a non-negative integer");
    }

    const snap = await db.collection("lessons").doc(lessonId).get();
    if (!snap.exists) {
      throw new Error(`Lesson not found: ${lessonId}`);
    }
    const srcArray = snap.data().srcArray || [];
    const seg = srcArray[idx];
    if (!seg) {
      throw new Error(`No segment at index ${idx}`);
    }

    return {
      ok: false,
      message: "AI refinement is not implemented yet; timeline architecture is ready for a frame-extract + OpenAI step.",
      lessonId,
      segmentId: idx,
      segmentIndex: idx,
      flagged: seg.flagged === true,
      hasYellowBounds: seg.yellowStart != null && seg.yellowEnd != null,
    };
  }
);

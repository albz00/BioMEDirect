const {onObjectFinalized} = require("firebase-functions/v2/storage");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { Storage } = require("@google-cloud/storage");

/**
 * --- Callable / trigger map ---
 * PRIMARY TIMELINE PATH (all call runDeterministicYellowPipeline → dense RGB yellow detector):
 *   generateSrcArray              Storage trigger, videos/*.mp4 upload; lessonId from metadata/videoPaths
 *   generateSrcArrayWithYellowOptions  HTTPS — admin "Generate source" (minDurationSeconds only)
 *   detectYellowScreen            HTTPS — "Regenerate from yellow" in admin (same pipeline)
 *   generateSrcArrayFromYellowScreens  HTTPS — passes chapters[] from menu HTML labels
 * OTHER:
 *   refineFlaggedTimelineSegment  HTTPS — AI title-map one segment (yellow event) via vision + JSON
 *   mapYellowEventsToChaptersWithAI  HTTPS — batch AI title-map for yellow events (optional eventIndexes)
 *   detectVideoTitles             HTTPS — OCR timestamps for menuLink labels; does not build yellow timeline
 * INTERNAL / LEGACY (not admin "Generate source"):
 *   detectYellowFrames            Sparse LAB @ fps; used by older helpers if any; not the dense path
 *   buildSrcArrayFromYellow       Gap-based segments from ranges; legacy; not written on success path now
 */
const path = require("path");
require("dotenv").config({path: path.join(__dirname, ".env")});

const os = require("os");
const fs = require("fs");
const ffmpegPath = require("ffmpeg-static");
const { spawn, spawnSync } = require("child_process");
const convert = require("color-convert");
const { createWorker } = require("tesseract.js");
const Fuse = require("fuse.js");
const {
  getOpenAiConfig,
  isAiTitleMappingConfigured,
  callOpenAiChapterMatch,
  logOpenAiTitleMappingEnvHealth,
} = require("./openaiTitleMappingService");

logOpenAiTitleMappingEnvHealth();

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
    const contentType = (object.contentType && String(object.contentType)) || "";
    const ext = path.extname(filePath || "").toLowerCase();
    const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

    if (!filePath || filePath.startsWith("yellow-debug/")) {
      return;
    }
    if (!VIDEO_EXTS.has(ext)) {
      return;
    }
    if (contentType && !contentType.startsWith("video/")) {
      return;
    }
    if (!filePath.startsWith("videos/")) {
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

      if (!pipeline.hasYellowEvents) {
        console.warn("[generateSrcArray] no yellow events; not writing srcArray", { lessonId, filePath });
        if (lessonId) {
          await persistLessonYellowDetectionFailure(lessonId, filePath, "upload-trigger", pipeline);
        } else {
          await db.collection("videoAnalyses").doc(uploadedVideoId).set(
            {
              videoPath: filePath,
              yellowDetection: pipeline.yellowDetection,
              timelinePipeline: {
                version: "yellow-content-v2",
                source: "upload-trigger",
                status: "no_yellow_detected",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
            },
            { merge: true }
          );
        }
        return;
      }

      let srcArray = pipeline.srcArray;
      if (lessonId) {
        const existingDoc = await db.collection("lessons").doc(lessonId).get();
        const existing = existingDoc.exists ? (existingDoc.data().srcArray || []) : [];
        srcArray = mergeManualTimelineOverrides(pipeline.srcArray, existing);
        srcArray = finalizePlayableSrcArrayAfterMerge(srcArray, "upload-trigger");
        if (pipeline.yellowDetection && pipeline.yellowDetection.timelineGenerationSummary) {
          pipeline.yellowDetection.timelineGenerationSummary = {
            ...pipeline.yellowDetection.timelineGenerationSummary,
            validPlayableSegmentCount: srcArray.filter((s) => isPlayableContentTiming(s)).length,
            srcArrayLengthPersisted: srcArray.length,
          };
        }
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
            yellowDetection: pipeline.yellowDetection,
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
            yellowDetection: pipeline.yellowDetection,
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
  const displayMap = meta.chapterDisplayNames || {};
  const menuLabels = meta.chapterMenuLabels || {};

  if (Array.isArray(meta.chapterOrder) && meta.chapterOrder.length > 0) {
    return meta.chapterOrder
      .map((menuId) => {
        const id = String(menuId).trim();
        if (!id) return null;
        if (displayMap[id] != null && String(displayMap[id]).trim() !== "") {
          return String(displayMap[id]).trim();
        }
        if (menuLabels[id] != null && String(menuLabels[id]).trim() !== "") {
          return String(menuLabels[id]).trim();
        }
        return id;
      })
      .filter(Boolean);
  }

  const orderedKeys = Object.keys(displayMap).sort((a, b) => {
    const na = parseInt(String(a).replace(/\D+/g, ""), 10);
    const nb = parseInt(String(b).replace(/\D+/g, ""), 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
  return orderedKeys
    .map((k) => {
      const fromDisplay = displayMap[k] != null ? String(displayMap[k]).trim() : "";
      if (fromDisplay) return fromDisplay;
      const fromMenu = menuLabels[k] != null ? String(menuLabels[k]).trim() : "";
      return fromMenu || String(k).trim();
    })
    .filter(Boolean);
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

/**
 * FFmpeg rawvideo rgb24 byte order: R, G, B (not BGR). Classifier uses RGB only.
 * Broad warm title-card band: yellow / gold / mustard / yellow-orange via HSV + loose RGB.
 */
const COLOR_PIPELINE_LABEL = "title_card_v3_maroon_reject+coverage_gate+tighter_hsv46-64+structure24/19";

function pixelWarmTitleCard(r, g, b) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  if (maxc < 28) return false;

  const hsv = convert.rgb.hsv([r, g, b]);
  const h = hsv[0];
  const s = hsv[1] / 100;
  const v = hsv[2] / 100;

  if (
    v >= 0.22 &&
    s >= 0.12 &&
    h >= 12 &&
    h <= 105
  ) {
    return true;
  }

  const warm = (r + g) / 2;
  if (
    warm > b + 18 &&
    r > 55 &&
    g > 45 &&
    b < Math.min(r, g) + 95 &&
    Math.abs(r - g) < 110
  ) {
    return true;
  }

  return false;
}

/**
 * Narrow HSV band for bright saturated yellow TITLE cards (full-frame), not beige/skin.
 */
function pixelStrictTitleYellow(r, g, b) {
  const maxc = Math.max(r, g, b);
  if (maxc < 48) return false;
  const hsv = convert.rgb.hsv([r, g, b]);
  const h = hsv[0];
  const s = hsv[1] / 100;
  const v = hsv[2] / 100;
  if (v < 0.32 || s < 0.42) return false;
  if (h >= 46 && h <= 64) return true;
  return false;
}

/** Dark maroon / red content slides (high edge, complex) — must not count as yellow card pixels. */
function pixelMaroonOrDarkRedContent(r, g, b) {
  const hsv = convert.rgb.hsv([r, g, b]);
  const h = hsv[0];
  const s = hsv[1] / 100;
  const v = hsv[2] / 100;
  if ((h <= 18 || h >= 338) && v < 0.58 && s > 0.18 && r > 45 && g < r - 12 && b < r - 12) return true;
  if (r > 65 && g < r - 28 && b < r - 28 && v < 0.52) return true;
  return false;
}

function lumaAtOffset(frameData, offset) {
  const r = frameData[offset];
  const g = frameData[offset + 1];
  const b = frameData[offset + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Flat full-frame yellow cards vs maroon detail slides: stricter flatness. */
const TITLE_LUMA_STD_MAX = 24;
/** Title cards: low edge density; maroon science slides have high edge energy. */
const TITLE_EDGE_MEAN_MAX = 19;

function structureGateFromMetrics(lumaStd, edgeMean) {
  const u = lumaStd <= TITLE_LUMA_STD_MAX
    ? 1
    : Math.max(0, 1 - (lumaStd - TITLE_LUMA_STD_MAX) / 48);
  const e = edgeMean <= TITLE_EDGE_MEAN_MAX
    ? 1
    : Math.max(0, 1 - (edgeMean - TITLE_EDGE_MEAN_MAX) / 58);
  return Math.min(1, u * e);
}

/**
 * Single-pass title-card score: strict yellow band + warm (legacy) + flatness + low edge density.
 * Warm pixels alone are down-weighted; structure gate suppresses long “warm content” false runs.
 */
function scoreTitleCardFrame(frameData, width, height, sampleStep = 4) {
  let warmFull = 0;
  let strictFull = 0;
  let maroonFull = 0;
  let samples = 0;
  const lumas = [];

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const offset = (y * width + x) * 3;
      const r = frameData[offset];
      const g = frameData[offset + 1];
      const b = frameData[offset + 2];
      if (r == null || g == null || b == null) continue;
      samples++;
      if (pixelMaroonOrDarkRedContent(r, g, b)) maroonFull++;
      if (pixelWarmTitleCard(r, g, b)) warmFull++;
      if (pixelStrictTitleYellow(r, g, b)) strictFull++;
      lumas.push(lumaAtOffset(frameData, offset));
    }
  }

  const warmFullRatio = samples ? warmFull / samples : 0;
  const strictFullRatio = samples ? strictFull / samples : 0;
  const maroonRatio = samples ? maroonFull / samples : 0;

  const x0 = Math.floor(width * 0.2);
  const x1 = Math.floor(width * 0.8);
  const y0 = Math.floor(height * 0.2);
  const y1 = Math.floor(height * 0.8);
  let warmCt = 0;
  let strictCt = 0;
  let maroonCt = 0;
  let sampC = 0;
  for (let y = y0; y < y1; y += sampleStep) {
    for (let x = x0; x < x1; x += sampleStep) {
      const offset = (y * width + x) * 3;
      const r = frameData[offset];
      const g = frameData[offset + 1];
      const b = frameData[offset + 2];
      if (r == null || g == null || b == null) continue;
      sampC++;
      if (pixelMaroonOrDarkRedContent(r, g, b)) maroonCt++;
      if (pixelWarmTitleCard(r, g, b)) warmCt++;
      if (pixelStrictTitleYellow(r, g, b)) strictCt++;
    }
  }
  const warmCenterRatio = sampC ? warmCt / sampC : 0;
  const strictCenterRatio = sampC ? strictCt / sampC : 0;
  const maroonCenterRatio = sampC ? maroonCt / sampC : 0;

  const warmCombined = Math.max(warmFullRatio, warmCenterRatio * 0.85 + warmFullRatio * 0.15);
  const strictCombined = Math.max(strictFullRatio, strictCenterRatio * 0.85 + strictFullRatio * 0.15);
  const maroonCombined = Math.max(maroonRatio, maroonCenterRatio * 0.85 + maroonRatio * 0.15);

  const meanL = lumas.length ? lumas.reduce((a, b) => a + b, 0) / lumas.length : 0;
  const varL = lumas.length
    ? lumas.reduce((s, x) => s + (x - meanL) * (x - meanL), 0) / lumas.length
    : 0;
  const lumaStd = Math.sqrt(varL);

  let edgeSum = 0;
  let edgeN = 0;
  for (let y = 0; y < height - sampleStep; y += sampleStep) {
    for (let x = 0; x < width - sampleStep; x += sampleStep) {
      const o = (y * width + x) * 3;
      const ox = (y * width + x + sampleStep) * 3;
      const oy = ((y + sampleStep) * width + x) * 3;
      const l0 = lumaAtOffset(frameData, o);
      const l1 = lumaAtOffset(frameData, ox);
      const l2 = lumaAtOffset(frameData, oy);
      edgeSum += Math.abs(l0 - l1) + Math.abs(l0 - l2);
      edgeN++;
    }
  }
  const edgeMean = edgeN ? edgeSum / edgeN : 0;

  const gate = structureGateFromMetrics(lumaStd, edgeMean);
  const coverageOk = strictFullRatio >= 0.36 && strictCenterRatio >= 0.3;
  const coveragePenalty = coverageOk ? 1 : 0.48;
  let yellowRatio = Math.max(
    strictCombined * gate,
    warmCombined * gate * 0.14,
  );
  yellowRatio *= coveragePenalty;
  if (maroonCombined > 0.08) {
    yellowRatio *= Math.max(0.08, 1 - maroonCombined * 2.2);
  }

  return {
    yellowRatio,
    warmFullRatio,
    strictFullRatio,
    maroonFullRatio: Math.round(maroonCombined * 1000) / 1000,
    warmCombined,
    strictCombined,
    warmCenterRatio,
    strictCenterRatio,
    lumaStd: Math.round(lumaStd * 1000) / 1000,
    edgeMean: Math.round(edgeMean * 1000) / 1000,
    structureGate: Math.round(gate * 1000) / 1000,
    coveragePenalty: Math.round(coveragePenalty * 1000) / 1000,
    samplePixels: samples,
  };
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

      const bright = (r + g + b) / 3 > 70;
      if (bright) brightCount++;

      if (pixelWarmTitleCard(r, g, b)) yellowCount++;
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
      if (pixelWarmTitleCard(r, g, b)) yellowCount++;
      samples++;
    }
  }
  return samples > 0 ? yellowCount / samples : 0;
}

const YELLOW_ENTER_THRESHOLD = 0.115;
const YELLOW_EXIT_THRESHOLD = 0.078;
/** Temporary comparison: how many frames exceed this loose ratio (logged with calibration). */
const YELLOW_DEBUG_LOOSE_ENTER = 0.04;

function buildYellowEventsFromFrames(frameDetections, frameRate, minDurationSeconds = 0.06) {
  if (!frameDetections.length) {
    return {
      events: [],
      rawCandidateSpans: [],
      candidateSpanSummary: {
        candidateSpanCount: 0,
        survivingSpanCount: 0,
        shortestCandidate: null,
        longestCandidate: null,
        minDurationSecondsUsed: minDurationSeconds,
      },
      stats: {
        framesDecoded: 0,
        framesAtOrAboveEnter: 0,
        minFramesRequired: 0,
        eventsEmitted: 0,
        eventsRejectedTooShort: 0,
        enterThreshold: YELLOW_ENTER_THRESHOLD,
        exitThreshold: YELLOW_EXIT_THRESHOLD,
        minDurationSeconds,
      },
    };
  }
  const frameInterval = frameRate > 0 ? 1 / frameRate : 1 / 30;
  const minFrames = Math.max(1, Math.ceil(minDurationSeconds / frameInterval));
  const enterThreshold = YELLOW_ENTER_THRESHOLD;
  const exitThreshold = YELLOW_EXIT_THRESHOLD;
  const exitDebounceFrames = 1;

  const framesAtOrAboveEnter = frameDetections.filter((f) => (f.yellowRatio || 0) >= enterThreshold).length;

  let inEvent = false;
  let eventStartIdx = 0;
  let lastYellowIdx = -1;
  let belowCount = 0;
  let peakYellow = 0;
  let sumYellow = 0;
  let metricFrames = 0;
  const events = [];
  const rawCandidateSpans = [];
  let eventsRejectedTooShort = 0;

  const closeEvent = (endIdx) => {
    const frames = endIdx - eventStartIdx + 1;
    const avgYellow = metricFrames > 0 ? sumYellow / metricFrames : 0;
    const startTime = eventStartIdx * frameInterval;
    const endTime = (endIdx + 1) * frameInterval;
    const duration = endTime - startTime;
    const rejected = frames < minFrames;
    const rejectionReason = rejected ? "below_min_duration_seconds" : "accepted";
    rawCandidateSpans.push({
      startFrame: eventStartIdx,
      endFrame: endIdx,
      startTime: Math.round(startTime * 1000) / 1000,
      endTime: Math.round(endTime * 1000) / 1000,
      duration: Math.round(duration * 1000) / 1000,
      averageYellowRatio: Math.round(avgYellow * 1000) / 1000,
      peakYellowRatio: Math.round(peakYellow * 1000) / 1000,
      minDurationSecondsUsed: minDurationSeconds,
      minFramesRequired: minFrames,
      frames,
      rejected,
      rejectionReason,
    });
    if (frames < minFrames) {
      eventsRejectedTooShort++;
      return;
    }
    const confidence = clamp((avgYellow - exitThreshold) / 0.32, 0, 1);
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
  const durations = rawCandidateSpans.map((s) => s.duration).filter((d) => Number.isFinite(d));
  const shortestCandidate = durations.length ? Math.min(...durations) : null;
  const longestCandidate = durations.length ? Math.max(...durations) : null;

  return {
    events,
    rawCandidateSpans,
    candidateSpanSummary: {
      candidateSpanCount: rawCandidateSpans.length,
      survivingSpanCount: events.length,
      shortestCandidate: shortestCandidate != null ? Math.round(shortestCandidate * 1000) / 1000 : null,
      longestCandidate: longestCandidate != null ? Math.round(longestCandidate * 1000) / 1000 : null,
      minDurationSecondsUsed: minDurationSeconds,
    },
    stats: {
      framesDecoded: frameDetections.length,
      framesAtOrAboveEnter,
      minFramesRequired: minFrames,
      eventsEmitted: events.length,
      eventsRejectedTooShort,
      enterThreshold,
      exitThreshold,
      minDurationSeconds,
    },
  };
}

/**
 * After a yellow block ends, find the first timecode where the frame is clearly not yellow
 * (so playback can seek to real content, not the tail of a transition).
 */
function attachContentStartsToEvents(frameDetections, frameRate, events) {
  if (!frameDetections.length || !events.length) return events;
  const frameInterval = frameRate > 0 ? 1 / frameRate : 1 / 30;
  const strictNonYellow = 0.055;
  const consecFrames = 3;

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

function extractFrameRgbAtVideoTime(videoPath, tSec, tw, th) {
  const res = spawnSync(ffmpegPath, [
    "-ss", String(Math.max(0, tSec)),
    "-i", videoPath,
    "-frames", "1",
    "-vf", `scale=${tw}:${th}:flags=fast_bilinear`,
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 30 * 1024 * 1024 });
  if (res.error || !res.stdout || res.stdout.length < tw * th * 3) return null;
  return res.stdout;
}

function writeRgbBufferAsPng(rgb, w, h, outPath) {
  const raw = `${outPath}.rgb.tmp`;
  fs.writeFileSync(raw, rgb);
  const r = spawnSync(ffmpegPath, [
    "-y",
    "-f", "rawvideo",
    "-pixel_format", "rgb24",
    "-video_size", `${w}x${h}`,
    "-i", raw,
    "-frames", "1",
    outPath,
  ], { encoding: "utf8" });
  try {
    fs.unlinkSync(raw);
  } catch (e) { /* ignore */ }
  return r.status === 0 || r.status === 1;
}

/** Small 16:9 frames for OpenAI vision (isolated from dense detector resolution). */
const AI_TITLE_MAP_FRAME_W = 480;
const AI_TITLE_MAP_FRAME_H = 270;

function extractPngBase64AtVideoTime(videoPath, tSec) {
  const rgb = extractFrameRgbAtVideoTime(videoPath, tSec, AI_TITLE_MAP_FRAME_W, AI_TITLE_MAP_FRAME_H);
  if (!rgb || rgb.length < AI_TITLE_MAP_FRAME_W * AI_TITLE_MAP_FRAME_H * 3) return null;
  const tmp = path.join(os.tmpdir(), `ai_title_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.png`);
  writeRgbBufferAsPng(rgb, AI_TITLE_MAP_FRAME_W, AI_TITLE_MAP_FRAME_H, tmp);
  try {
    const b64 = fs.readFileSync(tmp).toString("base64");
    fs.unlinkSync(tmp);
    return b64;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (e2) { /* ignore */ }
    return null;
  }
}

/**
 * Up to 3 times around yellowStart / yellowEnd / contentStart (deterministic pipeline).
 */
function pickRepresentativeTimesForYellowEvent(ev, durationSec) {
  const ys = ev.yellowStart != null ? ev.yellowStart : ev.startTime;
  const ye = ev.yellowEnd != null ? ev.yellowEnd : ev.endTime;
  const cs = ev.contentStart != null ? ev.contentStart : ye;
  const mid = ys + Math.max(0, (ye - ys) / 2);
  const picks = [];
  const seen = new Set();
  const maxT = Math.max(0, durationSec - 0.02);
  const add = (t, label) => {
    const x = Math.max(0, Math.min(maxT, t));
    const k = Math.round(x * 1000);
    if (!seen.has(k)) {
      seen.add(k);
      picks.push({ label, t: x });
    }
  };
  add(ys, "yellowStart");
  if (picks.length < 3) add(ye, "yellowEnd");
  if (picks.length < 3) add(cs, "contentStart");
  if (picks.length < 2) add(mid, "midYellow");
  return picks.slice(0, 3);
}

function deterministicGuessChapterIndex1Based(eventIndexZeroBased, chapterCount) {
  if (chapterCount <= 0) return 1;
  return Math.min(chapterCount, Math.max(1, eventIndexZeroBased + 1));
}

async function downloadLessonVideoToTemp(lessonId) {
  const vpDoc = await db.collection("videoPaths").doc(lessonId).get();
  let videoPath = `videos/${lessonId}.mp4`;
  if (vpDoc.exists && vpDoc.data().videoPath) {
    videoPath = String(vpDoc.data().videoPath).trim();
  }
  const bucket = admin.storage().bucket();
  const localPath = path.join(os.tmpdir(), `ai_map_${lessonId}_${Date.now()}.mp4`);
  await bucket.file(videoPath).download({ destination: localPath });
  return { localPath, videoPath };
}

/**
 * Merges aiChapterMapping into lesson yellowDetection without dropping other yellowDetection fields.
 */
async function mergeLessonAiChapterMapping(lessonId, patch) {
  const ref = db.collection("lessons").doc(lessonId);
  const snap = await ref.get();
  const prevYd = snap.exists ? { ...(snap.data().yellowDetection || {}) } : {};
  prevYd.aiChapterMapping = { ...(prevYd.aiChapterMapping || {}), ...patch };
  await ref.set({ yellowDetection: prevYd }, { merge: true });
}

/** Callable responses must not include FieldValue / sentinel objects. */
function sanitizeAiChapterMappingResultsForClient(map) {
  const out = {};
  if (!map || typeof map !== "object") return out;
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (!v || typeof v !== "object") continue;
    out[k] = {
      bestChapterIndex: v.bestChapterIndex,
      matchedTitle: v.matchedTitle,
      normalizedTitle: v.normalizedTitle,
      confidence: v.confidence,
      startAdjustmentSec: v.startAdjustmentSec,
      endAdjustmentSec: v.endAdjustmentSec,
      reason: v.reason,
      needsManualReview: v.needsManualReview,
      model: v.model,
    };
  }
  return out;
}

/**
 * @param {string} lessonId
 * @param {number[]} eventIndexesZeroBased
 * @returns {Promise<object>}
 */
async function runAiChapterMappingForEventIndexes(lessonId, eventIndexesZeroBased) {
  const cfg = getOpenAiConfig();
  if (!cfg.enabled) {
    return {
      success: false,
      ok: false,
      lessonId,
      reason: "ai_disabled",
      message: "Set OPENAI_TITLE_MAPPING_ENABLED=true (Firebase Functions env).",
    };
  }
  if (!isAiTitleMappingConfigured()) {
    throw new HttpsError("failed-precondition", "OPENAI_API_KEY is not configured on the server.");
  }

  const lessonSnap = await db.collection("lessons").doc(lessonId).get();
  if (!lessonSnap.exists) {
    throw new HttpsError("not-found", `Lesson not found: ${lessonId}`);
  }
  const lesson = lessonSnap.data();
  const events = lesson.yellowScreenEvents || (lesson.yellowDetection && lesson.yellowDetection.events) || [];
  if (!events.length) {
    return {
      success: false,
      ok: false,
      lessonId,
      reason: "no_yellow_events",
      message: "No yellowScreenEvents / yellowDetection.events on lesson.",
    };
  }

  const chapterTitles = await loadOrderedChapterTitles(lessonId);
  if (!chapterTitles.length) {
    return {
      success: false,
      ok: false,
      lessonId,
      reason: "no_chapters",
      message: "lessonMetadata chapterOrder / titles missing.",
    };
  }

  const indexes = (eventIndexesZeroBased || [])
    .map((x) => parseInt(String(x), 10))
    .filter((i) => Number.isFinite(i) && i >= 0 && i < events.length);
  if (!indexes.length) {
    return {
      success: false,
      ok: false,
      lessonId,
      reason: "no_event_indexes",
      message: "No valid event indexes in range.",
    };
  }

  let localPath = null;
  const results = [];
  const errors = [];

  try {
    const dl = await downloadLessonVideoToTemp(lessonId);
    localPath = dl.localPath;
    const durationSec = await getDuration(localPath);

    for (const i of indexes) {
      const ev = events[i];
      try {
        const times = pickRepresentativeTimesForYellowEvent(ev, durationSec);
        const images = [];
        for (const p of times) {
          const b64 = extractPngBase64AtVideoTime(localPath, p.t);
          if (b64) images.push({ label: p.label, base64Png: b64 });
        }
        if (!images.length) {
          errors.push({ eventIndex: i, error: "frame_extraction_failed" });
          continue;
        }

        const guessed = deterministicGuessChapterIndex1Based(i, chapterTitles.length);
        const t0 = Date.now();
        console.log("[aiChapterMapping] request", { lessonId, eventIndex: i, model: cfg.model, frameCount: images.length });

        const ai = await callOpenAiChapterMatch({
          chapterTitles,
          images,
          eventContext: {
            eventIndex: i,
            eventIndex1Based: i + 1,
            yellowStart: ev.yellowStart != null ? ev.yellowStart : ev.startTime,
            yellowEnd: ev.yellowEnd != null ? ev.yellowEnd : ev.endTime,
            contentStart: ev.contentStart,
            deterministicGuessChapterIndex: guessed,
            guessedTitle: chapterTitles[guessed - 1] || null,
          },
        });

        const ms = Date.now() - t0;
        console.log("[aiChapterMapping] response", {
          lessonId,
          eventIndex: i,
          bestChapterIndex: ai.bestChapterIndex,
          confidence: ai.confidence,
          needsManualReview: ai.needsManualReview,
          ms,
        });

        results.push({
          eventIndex: i,
          model: cfg.model,
          ...ai,
        });
      } catch (err) {
        console.error("[aiChapterMapping] event failed", { lessonId, eventIndex: i, err: err.message });
        errors.push({ eventIndex: i, error: err.message || String(err) });
      }
    }

    const ydSnap = lessonSnap.data().yellowDetection || {};
    const aimSnap = ydSnap.aiChapterMapping || {};
    const prevByIdx = {
      ...((aimSnap.resultsByEventIndex) || {}),
    };
    const resultsByEventIndex = { ...prevByIdx };
    for (const r of results) {
      resultsByEventIndex[String(r.eventIndex)] = {
        bestChapterIndex: r.bestChapterIndex,
        matchedTitle: r.matchedTitle,
        normalizedTitle: r.normalizedTitle,
        confidence: r.confidence,
        startAdjustmentSec: r.startAdjustmentSec,
        endAdjustmentSec: r.endAdjustmentSec,
        reason: r.reason,
        needsManualReview: r.needsManualReview,
        model: r.model,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    }

    await mergeLessonAiChapterMapping(lessonId, {
      version: 1,
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      model: cfg.model,
      videoPath: dl.videoPath,
      resultsByEventIndex,
      lastRunErrors: errors,
    });

    const processedEventCount = indexes.length;
    const mappedCount = results.length;
    const manualReviewCount = results.filter((r) => r.needsManualReview === true).length;
    const allFailed = mappedCount === 0 && errors.length > 0;

    return {
      success: !allFailed,
      lessonId,
      processedEventCount,
      mappedCount,
      manualReviewCount,
      model: cfg.model,
      resultsByEventIndex: sanitizeAiChapterMappingResultsForClient(resultsByEventIndex),
      errors,
      results,
      ok: !allFailed,
      processed: mappedCount,
      reason: allFailed ? "all_events_failed" : undefined,
    };
  } finally {
    if (localPath && fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch (e) { /* ignore */ }
    }
  }
}

function writeWarmMaskPng(frameData, w, h, outPath) {
  const raw = `${outPath}.gray.tmp`;
  const buf = Buffer.alloc(w * h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const r = frameData[o];
      const g = frameData[o + 1];
      const b = frameData[o + 2];
      buf[i++] = pixelWarmTitleCard(r, g, b) ? 255 : 0;
    }
  }
  fs.writeFileSync(raw, buf);
  const r = spawnSync(ffmpegPath, [
    "-y",
    "-f", "rawvideo",
    "-pixel_format", "gray",
    "-video_size", `${w}x${h}`,
    "-i", raw,
    "-frames", "1",
    outPath,
  ], { encoding: "utf8" });
  try {
    fs.unlinkSync(raw);
  } catch (e) { /* ignore */ }
  return r.status === 0 || r.status === 1;
}

function writePredicateMaskPng(frameData, w, h, predicate, outPath) {
  const raw = `${outPath}.gray.tmp`;
  const buf = Buffer.alloc(w * h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const pr = frameData[o];
      const pg = frameData[o + 1];
      const pb = frameData[o + 2];
      buf[i++] = predicate(pr, pg, pb) ? 255 : 0;
    }
  }
  fs.writeFileSync(raw, buf);
  const ff = spawnSync(ffmpegPath, [
    "-y",
    "-f", "rawvideo",
    "-pixel_format", "gray",
    "-video_size", `${w}x${h}`,
    "-i", raw,
    "-frames", "1",
    outPath,
  ], { encoding: "utf8" });
  try {
    fs.unlinkSync(raw);
  } catch (e) { /* ignore */ }
  return ff.status === 0 || ff.status === 1;
}

/**
 * When the first detected yellow event is very long (false positive run), export start/mid/end frames,
 * warm vs strict masks, and a JSON report with per-metric reasons (logged + optional Storage upload).
 */
async function saveFirstGiantYellowEventDebug({
  videoPath,
  firstEvent,
  frameDetections,
  frameRate,
  targetWidth,
  targetHeight,
  lessonId,
}) {
  const dur = firstEvent.duration != null ? firstEvent.duration : 0;
  if (dur < 6 || !frameDetections.length) return null;

  const runId = `firstEv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const debugDir = path.join(os.tmpdir(), `yellow_first_ev_${runId}`);
  fs.mkdirSync(debugDir, { recursive: true });

  const sf = firstEvent.startFrame != null ? firstEvent.startFrame : 0;
  const ef = firstEvent.endFrame != null ? firstEvent.endFrame : 0;
  const mid = Math.floor((sf + ef) / 2);
  const picks = [
    { label: "near_start", frameIndex: Math.min(sf + 3, frameDetections.length - 1) },
    { label: "middle", frameIndex: Math.min(Math.max(sf + 1, mid), frameDetections.length - 1) },
    { label: "near_end", frameIndex: Math.min(Math.max(sf + 1, ef - 3), frameDetections.length - 1) },
  ];

  const report = {
    runId,
    lessonId: lessonId || null,
    eventDurationSec: Math.round(dur * 1000) / 1000,
    startFrame: sf,
    endFrame: ef,
    frameRate,
    classifier: COLOR_PIPELINE_LABEL,
    thresholds: {
      enter: YELLOW_ENTER_THRESHOLD,
      exit: YELLOW_EXIT_THRESHOLD,
      titleLumaStdMax: TITLE_LUMA_STD_MAX,
      titleEdgeMeanMax: TITLE_EDGE_MEAN_MAX,
    },
    samples: [],
  };

  for (const p of picks) {
    const idx = Math.min(Math.max(0, p.frameIndex), frameDetections.length - 1);
    const t = idx / frameRate;
    const rgb = extractFrameRgbAtVideoTime(videoPath, t, targetWidth, targetHeight);
    if (!rgb || rgb.length < targetWidth * targetHeight * 3) continue;
    const scored = scoreTitleCardFrame(rgb, targetWidth, targetHeight, 4);
    const frameSnap = frameDetections[idx] || {};
    const base = path.join(debugDir, p.label);
    writeRgbBufferAsPng(rgb, targetWidth, targetHeight, `${base}_frame.png`);
    writePredicateMaskPng(rgb, targetWidth, targetHeight, pixelWarmTitleCard, `${base}_mask_warm.png`);
    writePredicateMaskPng(rgb, targetWidth, targetHeight, pixelStrictTitleYellow, `${base}_mask_strict.png`);
    report.samples.push({
      label: p.label,
      frameIndex: idx,
      timeSec: Math.round(t * 1000) / 1000,
      fromDenseDecode: {
        yellowRatio: frameSnap.yellowRatio,
        warmFullRatio: frameSnap.warmFullRatio,
        strictFullRatio: frameSnap.strictFullRatio,
        structureGate: frameSnap.structureGate,
        lumaStd: frameSnap.lumaStd,
        edgeMean: frameSnap.edgeMean,
      },
      rescoredFromExtractedPng: scored,
      whyPassedYellowRule: {
        combinedUses: "max(strictCombined*gate, warmCombined*gate*0.22)",
        passedEnter: (frameSnap.yellowRatio || 0) >= YELLOW_ENTER_THRESHOLD,
        note: "Old false-positive runs: high warmCombined with weak strict band; v2 suppresses via structureGate (flat luma + low edges) and strict HSV band.",
      },
    });
  }

  fs.writeFileSync(path.join(debugDir, "first_giant_event_report.json"), JSON.stringify(report, null, 2));
  console.log("[yellow-first-event-debug]", JSON.stringify(report, null, 2));

  let uploaded = [];
  if (lessonId) {
    try {
      const bucket = admin.storage().bucket();
      const prefix = `yellow-debug/${lessonId}/${runId}/first-giant-event`;
      const names = fs.readdirSync(debugDir);
      for (const name of names) {
        const localPath = path.join(debugDir, name);
        const ct = name.endsWith(".json") ? "application/json" : "image/png";
        const dest = `${prefix}/${name}`;
        await bucket.upload(localPath, { destination: dest, metadata: { contentType: ct } });
        uploaded.push(`gs://${bucket.name}/${dest}`);
      }
    } catch (e) {
      console.error("[yellow-first-event-debug] upload failed:", e.message);
    }
  }

  try {
    fs.rmSync(debugDir, { recursive: true, force: true });
  } catch (e) { /* ignore */ }

  return { runId, gcsPaths: uploaded, report };
}

/**
 * Saves frame PNGs, mask PNGs, report JSON under Storage prefix yellow-debug/{lessonId}/{runId}/ when upload succeeds.
 */
async function runYellowCalibrationExport({
  videoPath,
  lessonId,
  frameDetections,
  frameRate,
  targetWidth,
  targetHeight,
  runId,
}) {
  const debugDir = path.join(os.tmpdir(), `yellow_cal_${runId}`);
  fs.mkdirSync(debugDir, { recursive: true });
  const n = frameDetections.length;
  const uniformIdx = [];
  if (n > 0) {
    for (let k = 0; k < 10; k++) {
      uniformIdx.push(Math.min(n - 1, Math.floor((k / 9) * Math.max(0, n - 1))));
    }
  }
  const ranked = frameDetections
    .map((f, i) => ({ i, r: f.yellowRatio || 0 }))
    .sort((a, b) => b.r - a.r)
    .slice(0, 20)
    .map((x) => x.i);
  const indices = [...new Set([...uniformIdx, ...ranked])].slice(0, 22);

  const topForLog = frameDetections
    .map((f, i) => ({
      frameIndex: i,
      timeSec: Math.round((i / frameRate) * 1000) / 1000,
      yellowRatio: Math.round((f.yellowRatio || 0) * 10000) / 10000,
      passedEnter: (f.yellowRatio || 0) >= YELLOW_ENTER_THRESHOLD,
      passedExit: (f.yellowRatio || 0) >= YELLOW_EXIT_THRESHOLD,
      passedLooseDebug: (f.yellowRatio || 0) >= YELLOW_DEBUG_LOOSE_ENTER,
    }))
    .sort((a, b) => b.yellowRatio - a.yellowRatio)
    .slice(0, 20);

  for (const idx of indices) {
    const t = idx / frameRate;
    const rgb = extractFrameRgbAtVideoTime(videoPath, t, targetWidth, targetHeight);
    if (!rgb || rgb.length < targetWidth * targetHeight * 3) continue;
    const base = `f${String(idx).padStart(5, "0")}`;
    writeRgbBufferAsPng(rgb, targetWidth, targetHeight, path.join(debugDir, `${base}_frame.png`));
    writeWarmMaskPng(rgb, targetWidth, targetHeight, path.join(debugDir, `${base}_mask.png`));
  }

  fs.writeFileSync(
    path.join(debugDir, "report.json"),
    JSON.stringify({
      colorPipeline: COLOR_PIPELINE_LABEL,
      rgbByteOrder: "R,G,B per FFmpeg rawvideo rgb24 (not BGR)",
      hsv: "color-convert rgb→hsv, hue 0–360°, s/v 0–100 scaled to 0–1 for rules",
      thresholds: {
        enter: YELLOW_ENTER_THRESHOLD,
        exit: YELLOW_EXIT_THRESHOLD,
        debugLooseEnter: YELLOW_DEBUG_LOOSE_ENTER,
      },
      topFramesByRatio: topForLog,
    }, null, 2)
  );

  let uploaded = [];
  try {
    const bucket = admin.storage().bucket();
    const prefix = `yellow-debug/${lessonId}/${runId}`;
    const names = fs.readdirSync(debugDir);
    for (const name of names) {
      const localPath = path.join(debugDir, name);
      const dest = `${prefix}/${name}`;
      const ct = name.endsWith(".json") ? "application/json" : "image/png";
      await bucket.upload(localPath, { destination: dest, metadata: { contentType: ct } });
      uploaded.push(`gs://${bucket.name}/${dest}`);
    }
  } catch (e) {
    console.error("[yellow-cal] Storage upload failed:", e.message);
  }

  const framesLoose = frameDetections.filter((f) => (f.yellowRatio || 0) >= YELLOW_DEBUG_LOOSE_ENTER).length;

  console.log("[yellow-cal]", JSON.stringify({
    lessonId,
    runId,
    savedFrameIndices: indices.length,
    gcsUploaded: uploaded.length,
    topFramesByRatio: topForLog,
    framesAtOrAboveLooseEnter: framesLoose,
  }));

  try {
    fs.rmSync(debugDir, { recursive: true, force: true });
  } catch (e) { /* ignore */ }

  return {
    topFramesByRatio: topForLog,
    gcsPaths: uploaded,
    gcsPrefix: uploaded.length ? `yellow-debug/${lessonId}/${runId}` : null,
    framesAtOrAboveLooseEnter: framesLoose,
  };
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

function detectYellowEventsDense(video, streamInfo, options = {}) {
  const minDurationSeconds = Number.isFinite(options.minDurationSeconds) && options.minDurationSeconds > 0
    ? options.minDurationSeconds
    : 0.06;

  return new Promise((resolve, reject) => {
    const sourceWidth = Number.isFinite(streamInfo.width) ? streamInfo.width : 1280;
    const sourceHeight = Number.isFinite(streamInfo.height) ? streamInfo.height : 720;
    const frameRate = Number.isFinite(streamInfo.frameRate) && streamInfo.frameRate > 0 ? streamInfo.frameRate : 30;

    const targetWidth = Math.min(480, sourceWidth);
    const targetHeight = Math.max(2, Math.floor((sourceHeight / sourceWidth) * targetWidth / 2) * 2);
    const frameSize = targetWidth * targetHeight * 3;
    let buffer = Buffer.alloc(0);
    const frameDetections = [];
    let stderrTail = "";

    const proc = spawn(ffmpegPath, [
      "-i", video,
      "-vf", `scale=${targetWidth}:${targetHeight}:flags=fast_bilinear`,
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-vsync", "cfr",
      "-an",
      "-",
    ]);

    proc.stderr.on("data", (data) => {
      const s = data.toString();
      stderrTail = (stderrTail + s).slice(-4000);
    });

    proc.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= frameSize) {
        const frameData = buffer.slice(0, frameSize);
        buffer = buffer.slice(frameSize);
        const scored = scoreTitleCardFrame(frameData, targetWidth, targetHeight, 4);
        frameDetections.push({
          yellowRatio: scored.yellowRatio,
          warmFullRatio: scored.warmFullRatio,
          strictFullRatio: scored.strictFullRatio,
          maroonFullRatio: scored.maroonFullRatio,
          warmCombined: scored.warmCombined,
          strictCombined: scored.strictCombined,
          structureGate: scored.structureGate,
          coveragePenalty: scored.coveragePenalty,
          lumaStd: scored.lumaStd,
          edgeMean: scored.edgeMean,
        });
      }
    });
    proc.on("close", async (code) => {
      if (code !== 0 && code !== 1) {
        console.error("[yellow-dense] ffmpeg failed code", code, stderrTail.slice(-800));
        reject(new Error(`Dense yellow detection failed (ffmpeg code ${code})`));
        return;
      }

      const built = buildYellowEventsFromFrames(frameDetections, frameRate, minDurationSeconds);
      const rawGroupedEvents = built.events;
      const rawCandidateSpans = built.rawCandidateSpans || [];
      const candidateSpanSummary = built.candidateSpanSummary || {
        candidateSpanCount: rawCandidateSpans.length,
        survivingSpanCount: rawGroupedEvents.length,
        shortestCandidate: null,
        longestCandidate: null,
        minDurationSecondsUsed: minDurationSeconds,
      };
      const yellowEvents = attachContentStartsToEvents(frameDetections, frameRate, rawGroupedEvents);

      if (yellowEvents.length > 0) {
        const d0 = yellowEvents[0].duration != null ? yellowEvents[0].duration : 0;
        if (d0 >= 6) {
          try {
            await saveFirstGiantYellowEventDebug({
              videoPath: video,
              firstEvent: yellowEvents[0],
              frameDetections,
              frameRate,
              targetWidth,
              targetHeight,
              lessonId: options.lessonId || null,
            });
          } catch (err) {
            console.error("[yellow-first-event-debug]", err.message);
          }
        }
      }

      const maxYellowRatio = frameDetections.reduce((m, f) => Math.max(m, f.yellowRatio || 0), 0);
      const avgYellowRatio = frameDetections.length
        ? frameDetections.reduce((s, f) => s + (f.yellowRatio || 0), 0) / frameDetections.length
        : 0;
      const framesAtOrAboveLooseEnter = frameDetections.filter(
        (f) => (f.yellowRatio || 0) >= YELLOW_DEBUG_LOOSE_ENTER
      ).length;

      const zeroReason = (() => {
        if (frameDetections.length === 0) {
          return "no_frames_decoded_check_video_and_ffmpeg_stderr";
        }
        if (built.stats.framesAtOrAboveEnter === 0) {
          return "no_frames_met_enter_threshold_color_may_not_match_yellow_card_rule";
        }
        if (rawGroupedEvents.length === 0 && built.stats.eventsRejectedTooShort > 0) {
          return "yellow_candidates_found_but_all_shorter_than_min_duration_seconds_lower_min_segment_seconds";
        }
        if (rawGroupedEvents.length === 0) {
          return "grouping_produced_zero_events";
        }
        return null;
      })();

      let calibrationReport = null;
      if (options.yellowDebugCalibration && options.lessonId && frameDetections.length > 0) {
        const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        try {
          calibrationReport = await runYellowCalibrationExport({
            videoPath: video,
            lessonId: options.lessonId,
            frameDetections,
            frameRate,
            targetWidth,
            targetHeight,
            runId,
          });
        } catch (e) {
          console.error("[yellow-cal] run failed:", e.message);
        }
      }

      const topRatioSnapshot = frameDetections
        .map((f, i) => ({
          frameIndex: i,
          timeSec: Math.round((i / frameRate) * 1000) / 1000,
          yellowRatio: Math.round((f.yellowRatio || 0) * 10000) / 10000,
          passedEnter: (f.yellowRatio || 0) >= YELLOW_ENTER_THRESHOLD,
          passedExit: (f.yellowRatio || 0) >= YELLOW_EXIT_THRESHOLD,
          passedLooseDebug: (f.yellowRatio || 0) >= YELLOW_DEBUG_LOOSE_ENTER,
        }))
        .sort((a, b) => b.yellowRatio - a.yellowRatio)
        .slice(0, 20);

      console.log("[yellow-dense]", JSON.stringify({
        video: path.basename(video),
        frameRate,
        frameCount: frameDetections.length,
        minDurationSeconds,
        colorPipeline: COLOR_PIPELINE_LABEL,
        thresholds: {
          enter: YELLOW_ENTER_THRESHOLD,
          exit: YELLOW_EXIT_THRESHOLD,
          debugLooseEnter: YELLOW_DEBUG_LOOSE_ENTER,
        },
        framesAtOrAboveLooseEnter,
        stats: built.stats,
        rawCandidateSpanCount: rawCandidateSpans.length,
        rawGroupedEventCount: rawGroupedEvents.length,
        finalEventCount: yellowEvents.length,
        candidateSpanSummary,
        rawCandidateSpans,
        maxYellowRatio: Math.round(maxYellowRatio * 1000) / 1000,
        avgYellowRatio: Math.round(avgYellowRatio * 1000) / 1000,
        topFramesByRatio: topRatioSnapshot,
        zeroReason,
      }));

      if (frameDetections.length === 0) {
        console.error("[yellow-dense] stderr tail:", stderrTail.slice(-1200));
      }

      resolve({
        frameRate,
        frameCount: frameDetections.length,
        yellowEvents,
        rawCandidateSpans,
        candidateSpanSummary,
        rawGroupedEvents,
        groupingStats: built.stats,
        detectionSummary: {
          maxYellowRatio: Math.round(maxYellowRatio * 1000) / 1000,
          avgYellowRatio: Math.round(avgYellowRatio * 1000) / 1000,
          framesAtOrAboveLooseEnter,
          colorPipeline: COLOR_PIPELINE_LABEL,
          topFramesByRatio: topRatioSnapshot,
        },
        zeroReason,
        calibrationReport,
        stderrTail: frameDetections.length === 0 ? stderrTail.slice(-2000) : undefined,
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

function analyzeExtraYellowEvents(yellowEvents, chapterCount, videoDurationSec) {
  const evs = yellowEvents || [];
  if (!evs.length || evs.length <= chapterCount) return [];
  const extras = evs.slice(chapterCount);
  return extras.map((ev, i) => {
    const ys = ev.yellowStart != null ? ev.yellowStart : ev.startTime;
    const ye = ev.yellowEnd != null ? ev.yellowEnd : ev.endTime;
    const dur = ye - ys;
    const nearEnd = videoDurationSec > 0 && ys >= videoDurationSec * 0.86;
    const veryShort = dur < 1.1;
    const conf = ev.detectionConfidence != null ? ev.detectionConfidence : null;
    let likelyReason = "ordered_detection_after_chapter_list_exhausted";
    let suggestedAction = "kept_unmapped_for_debug; does_not_add_playable_rows";
    if (nearEnd) {
      likelyReason = "often_outro_endcard_or_final_transition_near_video_end";
      suggestedAction = "review_merge_with_last_chapter_if_duplicate_or_real_extra_card";
    }
    if (veryShort) {
      likelyReason += "; very_short_span_possible_flash_or_duplicate_edge";
      suggestedAction = "often_ignore_or_merge_if_spurious";
    }
    return {
      ordinal: chapterCount + i + 1,
      eventIndex: ev.eventIndex != null ? ev.eventIndex : chapterCount + i + 1,
      yellowStart: Math.round(ys * 1000) / 1000,
      yellowEnd: Math.round(ye * 1000) / 1000,
      durationSec: Math.round(dur * 1000) / 1000,
      detectionConfidence: conf,
      likelyReason,
      suggestedAction,
    };
  });
}

function buildSegmentBuildExplanation({
  effectiveChapterTitles,
  yellowEvents,
  mappings,
  extraEvents,
  srcArray,
  review,
  unmappedChapters,
  validationExcluded,
  videoDurationSec,
}) {
  const chapters = effectiveChapterTitles || [];
  const evs = yellowEvents || [];
  const openingRows = (srcArray || []).filter((s) => isOpeningTimelineRow(s)).length;
  const validPlayable = (srcArray || []).filter((s) => isPlayableContentTiming(s)).length;

  const chaptersWithoutYellow = (unmappedChapters || []).length > 0
    ? (unmappedChapters || []).map((u) => ({
      chapterIndex: u.chapterIndex,
      title: u.title,
      reason: u.reason || "unmapped",
    }))
    : (mappings || [])
      .filter((m) => m.event == null)
      .map((m) => ({
        chapterIndex: m.chapterIndex,
        title: m.title,
        status: m.status,
        reason: "no_yellow_detection_for_this_chapter_slot",
      }));

  const extraYellowEventAnalysis = analyzeExtraYellowEvents(evs, chapters.length, videoDurationSec || 0);

  const filteredOut = validationExcluded && validationExcluded.length
    ? `${validationExcluded.length} row(s) removed by final playable validation (see timelineGenerationSummary.excludedRowsDetail)`
    : null;

  return {
    chapterTitlesLoaded: chapters.length,
    chapterTitlesOrder: chapters.slice(),
    yellowEventsDetected: evs.length,
    timelineRowsTotal: (srcArray || []).length,
    openingRowCount: openingRows,
    validPlayableSegmentCount: validPlayable,
    mappedChapterEventPairs: review.mappedCount,
    chaptersWithoutMatchingYellow: chaptersWithoutYellow,
    extraYellowEventAnalysis,
    extraYellowEventsNotMappedToRows: extraYellowEventAnalysis,
    reviewStates: review.states || [],
    validationExcludedRows: validationExcluded || [],
    summaryLines: [
      `${chapters.length} chapter title(s) loaded (ordered)`,
      `${evs.length} yellow event(s) detected`,
      `${openingRows} opening row(s), ${validPlayable} playable timed segment(s) (player-facing)`,
      evs.length > chapters.length
        ? `${evs.length - chapters.length} extra detection(s) beyond chapter list — see extraYellowEventAnalysis for time/role hints`
        : null,
      chaptersWithoutYellow.length
        ? `${chaptersWithoutYellow.length} chapter(s) pending / unmapped (no playable row emitted)`
        : null,
      filteredOut,
    ].filter(Boolean),
  };
}

function timelineReviewForSuccessfulGeneration(review) {
  return {
    ...review,
    generationFailed: false,
    failureReason: null,
    message: null,
    videoPath: null,
    lastSuccessfulGenerationAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/** Opening/menu row: not a timed content segment. */
function isOpeningTimelineRow(seg) {
  if (!seg) return false;
  if (seg.menuLink === "Opening") return true;
  if (seg.role === "opening") return true;
  return seg.freezeFrame === null && seg.src_start == null && seg.src_end == null;
}

/** Player-facing playable content: finite bounds, strictly increasing. */
function isPlayableContentTiming(seg) {
  if (!seg) return false;
  const a = seg.src_start;
  const b = seg.src_end;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return b > a;
}

/**
 * Final gate before persisting: drop any non-opening row that fails timing contract.
 * Re-assigns freezeFrame for content rows in order.
 */
function validatePlayableSrcArrayForWrite(srcArray, logLabel) {
  const excluded = [];
  const kept = [];
  if (!Array.isArray(srcArray)) {
    return { srcArray: [], excluded, invalidRowCountFilteredOut: 0 };
  }

  for (let i = 0; i < srcArray.length; i++) {
    const row = srcArray[i];
    if (!row) {
      excluded.push({ arrayIndex: i, reason: "null_row" });
      continue;
    }
    if (isOpeningTimelineRow(row)) {
      kept.push({ ...row, role: row.role || "opening" });
      continue;
    }
    if (isPlayableContentTiming(row)) {
      kept.push(row);
      continue;
    }
    excluded.push({
      arrayIndex: i,
      chapterIndex: row.chapterIndex != null ? row.chapterIndex : null,
      menuLink: row.menuLink != null ? String(row.menuLink) : "",
      reason: "not_playable_timing",
      src_start: row.src_start,
      src_end: row.src_end,
    });
  }

  let fz = 0;
  for (const row of kept) {
    if (!isOpeningTimelineRow(row)) {
      row.freezeFrame = fz;
      fz += 1;
    }
  }

  if (excluded.length > 0) {
    console.warn(`[validatePlayableSrcArrayForWrite${logLabel ? `:${logLabel}` : ""}] excluded ${excluded.length} row(s)`, JSON.stringify(excluded));
  }

  return {
    srcArray: kept,
    excluded,
    invalidRowCountFilteredOut: excluded.length,
  };
}

/** After merge: re-validate so manual edits cannot persist invalid playable rows. */
function finalizePlayableSrcArrayAfterMerge(srcArray, logLabel) {
  const v = validatePlayableSrcArrayForWrite(srcArray, logLabel);
  return v.srcArray;
}

/**
 * Only emits opening + rows with real content timing. Chapters without a yellow event
 * (or with unusable bounds) go to unmappedChapters — not into player srcArray.
 */
function generateChapterAwareSrcArray(mappings, duration) {
  const unmappedChapters = [];

  const srcArray = [{
    role: "opening",
    src_start: null,
    src_end: null,
    freezeFrame: null,
    menuLink: "Opening",
    side: false,
    loop: false,
  }];

  if (!mappings.length) {
    const end = Math.round(duration * 1000) / 1000;
    srcArray.push({
      index: 0,
      chapterIndex: 1,
      title: "Unmapped Segment",
      contentStart: 0,
      contentEnd: end,
      yellowStart: null,
      yellowEnd: null,
      start: 0,
      end: end,
      src_start: 0,
      src_end: end,
      menuLink: "",
      freezeFrame: 0,
      source: "yellow-detection",
      confidence: 0,
      status: "needsManualReview",
      flagged: true,
      manualOverride: false,
      side: false,
      loop: false,
      playable: true,
    });
    return { srcArray, unmappedChapters };
  }

  let contentIdx = 0;

  for (let i = 0; i < mappings.length; i++) {
    const current = mappings[i];
    const next = mappings[i + 1] || null;
    const ev = current.event;

    if (ev == null) {
      unmappedChapters.push({
        chapterIndex: current.chapterIndex,
        title: current.title || "",
        reason: "missing_yellow_detection_for_chapter_slot",
      });
      continue;
    }

    let yellowStart = null;
    let yellowEnd = null;
    let contentStart = null;
    let contentEnd = next && next.event
      ? (next.event.yellowStart != null ? next.event.yellowStart : next.event.startTime)
      : duration;

    yellowStart = ev.yellowStart != null ? ev.yellowStart : ev.startTime;
    yellowEnd = ev.yellowEnd != null ? ev.yellowEnd : ev.endTime;
    contentStart = ev.contentStart != null ? ev.contentStart : ev.endTime;
    contentStart = Math.max(contentStart, yellowEnd);

    let flagged = !!current.flagged;
    let status = current.status || "ok";

    if (!Number.isFinite(contentStart) || !Number.isFinite(contentEnd) || contentEnd <= contentStart) {
      flagged = true;
      status = status === "ok" ? "invalidSegmentBounds" : status;
      unmappedChapters.push({
        chapterIndex: current.chapterIndex,
        title: current.title || "",
        reason: "invalid_content_bounds_after_mapping",
        detail: { contentStart, contentEnd, yellowStart, yellowEnd },
      });
      continue;
    }

    const rs = Math.round(contentStart * 1000) / 1000;
    const re = Math.round(contentEnd * 1000) / 1000;

    if (!isPlayableContentTiming({ src_start: rs, src_end: re })) {
      unmappedChapters.push({
        chapterIndex: current.chapterIndex,
        title: current.title || "",
        reason: "non_playable_bounds",
        detail: { rs, re },
      });
      continue;
    }

    srcArray.push({
      index: contentIdx,
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
      freezeFrame: contentIdx,
      source: "yellow-pipeline",
      confidence: Math.round((current.confidence || 0) * 1000) / 1000,
      status,
      flagged,
      manualOverride: false,
      side: false,
      loop: false,
      playable: true,
    });
    contentIdx += 1;
  }

  return { srcArray, unmappedChapters };
}

async function runDeterministicYellowPipeline({
  lessonId,
  localVideoPath,
  chapterTitles,
  sourceLabel,
  minDurationSeconds,
  yellowDebugCalibration,
}) {
  const minSeg = Number.isFinite(minDurationSeconds) && minDurationSeconds > 0 ? minDurationSeconds : 0.06;

  // Stage 1: prep / normalize only if stream is clearly unsuitable.
  const prepared = await prepareVideoForAnalysis(localVideoPath);
  const analysisDuration = await getDuration(prepared.preparedPath);

  console.log("[yellow-pipeline] start", JSON.stringify({
    lessonId: lessonId || null,
    source: sourceLabel || "pipeline",
    localVideo: path.basename(localVideoPath),
    durationSec: Math.round(analysisDuration * 1000) / 1000,
    minDurationSeconds: minSeg,
    normalization: {
      cleanupPrepared: prepared.cleanupPrepared,
      width: prepared.info.width,
      height: prepared.info.height,
      frameRate: prepared.info.frameRate,
      codec: prepared.info.codec,
    },
  }));

  try {
    // Stage 2: dense sequential yellow detection with event state machine.
    const detection = await detectYellowEventsDense(prepared.preparedPath, prepared.info, {
      minDurationSeconds: minSeg,
      yellowDebugCalibration: yellowDebugCalibration === true,
      lessonId: lessonId || null,
    });
    const yellowEvents = detection.yellowEvents;
    const yellowRanges = deriveYellowRangesFromEvents(yellowEvents);

    const yellowDetection = {
      version: 2,
      lessonId: lessonId || null,
      sourceLabel: sourceLabel || "pipeline",
      analyzedVideoBasename: path.basename(prepared.preparedPath),
      durationSec: Math.round(analysisDuration * 1000) / 1000,
      minDurationSeconds: minSeg,
      normalization: {
        usedTranscodedFile: prepared.cleanupPrepared === true,
        streamWidth: prepared.info.width,
        streamHeight: prepared.info.height,
        streamFrameRate: prepared.info.frameRate,
        streamCodec: prepared.info.codec,
      },
      thresholds: {
        enter: YELLOW_ENTER_THRESHOLD,
        exit: YELLOW_EXIT_THRESHOLD,
        debugLooseEnter: YELLOW_DEBUG_LOOSE_ENTER,
      },
      colorPipeline: COLOR_PIPELINE_LABEL,
      rawGroupedEvents: detection.rawGroupedEvents || [],
      rawCandidateSpans: detection.rawCandidateSpans || [],
      candidateSpanSummary: detection.candidateSpanSummary || null,
      events: yellowEvents,
      groupingStats: detection.groupingStats || null,
      frameCount: detection.frameCount,
      decodeFrameRate: detection.frameRate,
      detectionSummary: detection.detectionSummary || null,
      calibrationReport: detection.calibrationReport || null,
      zeroReason: detection.zeroReason || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Stage 3: deterministic ordered chapter mapping (bootstrap strategy).
    const effectiveChapterTitles = (chapterTitles && chapterTitles.length > 0)
      ? chapterTitles
      : yellowEvents.map((_, i) => `Chapter ${i + 1}`);
    const mapping = mapYellowEventsToChapters(effectiveChapterTitles, yellowEvents);

    // Stage 4: chapter-aware playable srcArray (opening + valid timed rows only).
    const built = generateChapterAwareSrcArray(mapping.mappings, analysisDuration);
    let srcArray = built.srcArray;
    const validation = validatePlayableSrcArrayForWrite(srcArray, sourceLabel || "pipeline");
    srcArray = validation.srcArray;

    const timelineGenerationSummary = {
      chapterCount: effectiveChapterTitles.length,
      yellowEventCount: yellowEvents.length,
      validPlayableSegmentCount: srcArray.filter((s) => isPlayableContentTiming(s)).length,
      unmappedChapterCount: built.unmappedChapters.length,
      invalidRowCountFilteredOut: validation.invalidRowCountFilteredOut,
      unmappedChapterIndexes: built.unmappedChapters.map((u) => u.chapterIndex).filter((x) => x != null),
      excludedRowsDetail: validation.excluded,
    };

    yellowDetection.unmappedChapters = built.unmappedChapters;
    yellowDetection.timelineGenerationSummary = timelineGenerationSummary;

    const segmentBuildExplanation = buildSegmentBuildExplanation({
      effectiveChapterTitles,
      yellowEvents,
      mappings: mapping.mappings,
      extraEvents: mapping.extraEvents,
      srcArray,
      review: mapping.review,
      unmappedChapters: built.unmappedChapters,
      validationExcluded: validation.excluded,
      videoDurationSec: analysisDuration,
    });

    yellowDetection.segmentBuildExplanation = segmentBuildExplanation;

    console.log("[yellow-pipeline] mapping", JSON.stringify({
      source: sourceLabel || "pipeline",
      chapterTitlesLoaded: effectiveChapterTitles.length,
      chapterTitlesOrder: effectiveChapterTitles,
      yellowEventsDetected: yellowEvents.length,
      srcArrayRows: srcArray.length,
      validPlayableSegmentCount: timelineGenerationSummary.validPlayableSegmentCount,
      unmappedChapterCount: timelineGenerationSummary.unmappedChapterCount,
      mappedPairs: mapping.review.mappedCount,
      reviewStates: mapping.review.states,
    }));

    // Stage 5: explicit review/mismatch states, easy to render in admin.
    const reviewExpanded = {
      ...mapping.review,
      source: sourceLabel || "pipeline",
      duration: analysisDuration,
      frameRate: detection.frameRate,
      frameCount: detection.frameCount,
      detectionSummary: detection.detectionSummary || null,
      chapterTitlesCount: effectiveChapterTitles.length,
      chapterTitlesOrder: effectiveChapterTitles.slice(),
      detectedEventCount: yellowEvents.length,
      timelineGenerationSummary,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      refinementHook: {
        ready: true,
        strategy: "gpt-vision-future",
        callable: "refineFlaggedTimelineSegment",
        notes: "Per-segment AI hook; does not run automatically.",
      },
    };
    const review = yellowEvents.length > 0
      ? timelineReviewForSuccessfulGeneration(reviewExpanded)
      : reviewExpanded;

    return {
      srcArray,
      yellowRanges,
      yellowEvents,
      yellowDetection,
      hasYellowEvents: yellowEvents.length > 0,
      chapterTimeline: mapping.mappings,
      review,
      duration: analysisDuration,
      extraEvents: mapping.extraEvents,
      detectionSummary: detection.detectionSummary || null,
      segmentBuildExplanation,
    };
  } finally {
    if (prepared.cleanupPrepared && fs.existsSync(prepared.preparedPath)) {
      fs.unlinkSync(prepared.preparedPath);
    }
  }
}

/**
 * Writes detector output + explicit failure status without overwriting srcArray (timeline playback).
 */
async function persistLessonYellowDetectionFailure(lessonId, videoPath, sourceLabel, pipeline, extraPipeline = {}) {
  const yd = pipeline.yellowDetection || {};
  const cand = yd.candidateSpanSummary || {};
  const allTooShort = yd.zeroReason ===
    "yellow_candidates_found_but_all_shorter_than_min_duration_seconds_lower_min_segment_seconds";
  const detail = allTooShort
    ? ` Yellow candidates were found (${cand.candidateSpanCount || 0}), but all were shorter than minDurationSeconds (${cand.minDurationSecondsUsed || yd.minDurationSeconds || "n/a"}). Try lowering minDurationSeconds.`
    : "";
  const failureReview = {
    ...pipeline.review,
    generationFailed: true,
    failureReason: "no_yellow_events_detected",
    message: `No yellow transition cards met detection rules; existing timeline left unchanged. Inspect yellowDetection in Firestore.${detail}`,
    videoPath: videoPath || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("lessons").doc(lessonId).set(
    {
      yellowDetection: pipeline.yellowDetection,
      yellowScreenEvents: [],
      yellowScreenRanges: [],
      chapterTimeline: pipeline.chapterTimeline,
      timelineReview: failureReview,
      timelinePipeline: {
        version: "yellow-content-v2",
        source: sourceLabel,
        status: "no_yellow_detected",
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        ...extraPipeline,
      },
    },
    { merge: true }
  );
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
    const { videoPath, lessonId, minSegmentSeconds, yellowDebugCalibration } = request.data || {};
    if (!videoPath || !lessonId) {
      throw new Error("videoPath and lessonId are required");
    }
    const minSeg = Number.isFinite(minSegmentSeconds) && minSegmentSeconds > 0 ? minSegmentSeconds : 0.06;

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
        minDurationSeconds: minSeg,
        yellowDebugCalibration: yellowDebugCalibration === true,
      });

      if (!pipeline.hasYellowEvents) {
        const csum = (pipeline.yellowDetection && pipeline.yellowDetection.candidateSpanSummary) || null;
        await persistLessonYellowDetectionFailure(lessonId, videoPath, "manual-yellow-regenerate", pipeline);
        return {
          success: false,
          reason: "no_yellow_events_detected",
          message: (pipeline.yellowDetection && pipeline.yellowDetection.zeroReason) || "No yellow events detected",
          yellowDetection: pipeline.yellowDetection,
          candidateSpanCount: csum ? csum.candidateSpanCount : 0,
          survivingSpanCount: csum ? csum.survivingSpanCount : 0,
          shortestCandidate: csum ? csum.shortestCandidate : null,
          longestCandidate: csum ? csum.longestCandidate : null,
          minDurationSecondsUsed: csum ? csum.minDurationSecondsUsed : minSeg,
          reviewStates: pipeline.review.states,
        };
      }

      const existingDoc = await db.collection("lessons").doc(lessonId).get();
      const existing = existingDoc.exists ? (existingDoc.data().srcArray || []) : [];
      let srcArray = mergeManualTimelineOverrides(pipeline.srcArray, existing);
      srcArray = finalizePlayableSrcArrayAfterMerge(srcArray, "manual-yellow-regenerate");
      if (pipeline.yellowDetection && pipeline.yellowDetection.timelineGenerationSummary) {
        pipeline.yellowDetection.timelineGenerationSummary = {
          ...pipeline.yellowDetection.timelineGenerationSummary,
          validPlayableSegmentCount: srcArray.filter((s) => isPlayableContentTiming(s)).length,
          srcArrayLengthPersisted: srcArray.length,
        };
      }

      await db.collection("lessons").doc(lessonId).set({
        srcArray,
        originalSrcArray: srcArray,
        yellowScreenRanges: pipeline.yellowRanges,
        yellowScreenEvents: pipeline.yellowEvents,
        yellowDetection: pipeline.yellowDetection,
        chapterTimeline: pipeline.chapterTimeline,
        timelineReview: pipeline.review,
        timelinePipeline: {
          version: "yellow-content-v2",
          source: "manual-yellow-regenerate",
          status: "ok",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      }, { merge: true });

      return {
        success: true,
        yellowRanges: pipeline.yellowRanges,
        yellowEvents: pipeline.yellowEvents.length,
        adjustedSegments: srcArray.length,
        reviewStates: pipeline.review.states,
        timelineGenerationSummary: pipeline.yellowDetection?.timelineGenerationSummary || null,
      };
    } catch (error) {
      console.error("Error detecting yellow screen:", error);
      throw new Error(`Yellow screen detection failed: ${error.message}`);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }
);

// Manually generate a srcArray for a lesson's assigned video (dense decode; min yellow duration only).
exports.generateSrcArrayWithYellowOptions = onCall(
  {
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    const { videoPath, lessonId, minSegmentSeconds, yellowDebugCalibration } = request.data || {};
    if (!videoPath || !lessonId) {
      throw new Error("videoPath and lessonId are required");
    }

    const effectiveMinSeg = Number.isFinite(minSegmentSeconds) && minSegmentSeconds > 0 ? minSegmentSeconds : 0.05;

    const bucket = admin.storage().bucket();
    const tmpFile = path.join(os.tmpdir(), `yellow_manual_${Date.now()}.mp4`);

    try {
      await bucket.file(videoPath).download({ destination: tmpFile });

      const chapterTitles = await loadOrderedChapterTitles(lessonId);
      console.log("[generateSrcArrayWithYellowOptions]", JSON.stringify({
        lessonId,
        videoPath,
        chapterTitleCount: chapterTitles.length,
        minDurationSeconds: effectiveMinSeg,
      }));

      const pipeline = await runDeterministicYellowPipeline({
        lessonId,
        localVideoPath: tmpFile,
        chapterTitles,
        sourceLabel: "manual-editor",
        minDurationSeconds: effectiveMinSeg,
        yellowDebugCalibration: yellowDebugCalibration === true,
      });

      if (!pipeline.hasYellowEvents) {
        const csum = (pipeline.yellowDetection && pipeline.yellowDetection.candidateSpanSummary) || null;
        await persistLessonYellowDetectionFailure(lessonId, videoPath, "manual-editor", pipeline, {
          minDurationSecondsApplied: effectiveMinSeg,
        });
        return {
          success: false,
          reason: "no_yellow_events_detected",
          message: (pipeline.yellowDetection && pipeline.yellowDetection.zeroReason) || "No yellow events detected",
          yellowDetection: pipeline.yellowDetection,
          calibrationReport: (pipeline.yellowDetection && pipeline.yellowDetection.calibrationReport) || null,
          candidateSpanCount: csum ? csum.candidateSpanCount : 0,
          survivingSpanCount: csum ? csum.survivingSpanCount : 0,
          shortestCandidate: csum ? csum.shortestCandidate : null,
          longestCandidate: csum ? csum.longestCandidate : null,
          minDurationSecondsUsed: csum ? csum.minDurationSecondsUsed : effectiveMinSeg,
          reviewStates: pipeline.review.states || [],
          duration: pipeline.duration,
          minSegmentSeconds: effectiveMinSeg,
        };
      }

      const existingDoc = await db.collection("lessons").doc(lessonId).get();
      const existing = existingDoc.exists ? (existingDoc.data().srcArray || []) : [];
      let srcArray = mergeManualTimelineOverrides(pipeline.srcArray, existing);
      srcArray = finalizePlayableSrcArrayAfterMerge(srcArray, "manual-editor");
      if (pipeline.yellowDetection && pipeline.yellowDetection.timelineGenerationSummary) {
        pipeline.yellowDetection.timelineGenerationSummary = {
          ...pipeline.yellowDetection.timelineGenerationSummary,
          validPlayableSegmentCount: srcArray.filter((s) => isPlayableContentTiming(s)).length,
          srcArrayLengthPersisted: srcArray.length,
        };
      }

      await db.collection("lessons").doc(lessonId).set(
        {
          srcArray,
          originalSrcArray: srcArray,
          yellowScreenRanges: pipeline.yellowRanges,
          yellowScreenEvents: pipeline.yellowEvents,
          yellowDetection: pipeline.yellowDetection,
          chapterTimeline: pipeline.chapterTimeline,
          timelineReview: pipeline.review,
          timelinePipeline: {
            version: "yellow-content-v2",
            source: "manual-editor",
            status: "ok",
            minDurationSecondsApplied: effectiveMinSeg,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

      const tgs = pipeline.yellowDetection?.timelineGenerationSummary || null;
      return {
        success: true,
        segments: srcArray.length,
        yellowRanges: pipeline.yellowRanges.length,
        duration: pipeline.duration,
        reviewStates: pipeline.review.states || [],
        minSegmentSeconds: effectiveMinSeg,
        calibrationReport: pipeline.yellowDetection?.calibrationReport || null,
        segmentBuildExplanation: pipeline.segmentBuildExplanation || pipeline.yellowDetection?.segmentBuildExplanation || null,
        chapterTitlesLoaded: pipeline.review?.chapterTitlesCount,
        chapterTitlesOrder: pipeline.review?.chapterTitlesOrder,
        yellowEventsDetected: pipeline.yellowEvents?.length,
        chapterCount: tgs?.chapterCount,
        yellowEventCount: tgs?.yellowEventCount,
        validPlayableSegmentCount: tgs?.validPlayableSegmentCount,
        unmappedChapterCount: tgs?.unmappedChapterCount,
        invalidRowCountFilteredOut: tgs?.invalidRowCountFilteredOut,
        unmappedChapterIndexes: tgs?.unmappedChapterIndexes,
        timelineGenerationSummary: tgs,
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

      if (!pipeline.hasYellowEvents) {
        const csum = (pipeline.yellowDetection && pipeline.yellowDetection.candidateSpanSummary) || null;
        await persistLessonYellowDetectionFailure(lessonId, videoPath, "manual-generate-from-yellow", pipeline);
        return {
          success: false,
          reason: "no_yellow_events_detected",
          message: (pipeline.yellowDetection && pipeline.yellowDetection.zeroReason) || "No yellow events detected",
          yellowDetection: pipeline.yellowDetection,
          candidateSpanCount: csum ? csum.candidateSpanCount : 0,
          survivingSpanCount: csum ? csum.survivingSpanCount : 0,
          shortestCandidate: csum ? csum.shortestCandidate : null,
          longestCandidate: csum ? csum.longestCandidate : null,
          minDurationSecondsUsed: csum ? csum.minDurationSecondsUsed : 0.06,
          chapters: chapters.length,
          detections: 0,
          states: pipeline.review.states,
        };
      }

      const existingDoc = await db.collection("lessons").doc(lessonId).get();
      const existing = existingDoc.exists ? (existingDoc.data().srcArray || []) : [];
      let mergedSrc = mergeManualTimelineOverrides(pipeline.srcArray, existing);
      mergedSrc = finalizePlayableSrcArrayAfterMerge(mergedSrc, "manual-generate-from-yellow");
      if (pipeline.yellowDetection && pipeline.yellowDetection.timelineGenerationSummary) {
        pipeline.yellowDetection.timelineGenerationSummary = {
          ...pipeline.yellowDetection.timelineGenerationSummary,
          validPlayableSegmentCount: mergedSrc.filter((s) => isPlayableContentTiming(s)).length,
          srcArrayLengthPersisted: mergedSrc.length,
        };
      }

      await db.collection("lessons").doc(lessonId).set(
        {
          srcArray: mergedSrc,
          originalSrcArray: mergedSrc,
          yellowScreenRanges: pipeline.yellowRanges,
          yellowScreenEvents: pipeline.yellowEvents,
          yellowDetection: pipeline.yellowDetection,
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
          timelinePipeline: {
            version: "yellow-content-v2",
            source: "manual-generate-from-yellow",
            status: "ok",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

      const tgs = pipeline.yellowDetection?.timelineGenerationSummary || null;
      return {
        success: true,
        status: pipeline.review.needsManualReview ? "needs_review" : "ok",
        chapters: chapters.length,
        detections: pipeline.yellowEvents.length,
        reason: pipeline.review.states.join(", "),
        segments: mergedSrc.length,
        states: pipeline.review.states,
        chapterCount: tgs?.chapterCount,
        yellowEventCount: tgs?.yellowEventCount,
        validPlayableSegmentCount: tgs?.validPlayableSegmentCount,
        unmappedChapterCount: tgs?.unmappedChapterCount,
        invalidRowCountFilteredOut: tgs?.invalidRowCountFilteredOut,
        unmappedChapterIndexes: tgs?.unmappedChapterIndexes,
        timelineGenerationSummary: tgs,
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
 * AI title-mapping for one yellow event (vision + structured JSON). Does not re-run yellow detection.
 * Pass either yellowEventIndex (0-based, aligned with yellowScreenEvents) or segmentId/segmentIndex
 * (srcArray row: 0 = opening, 1 = first chapter row → yellow event 0).
 */
exports.refineFlaggedTimelineSegment = onCall(
  {
    memory: "2GiB",
    timeoutSeconds: 300,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const data = request.data || {};
    const { lessonId, yellowEventIndex } = data;
    const segmentRef = data.segmentId != null ? data.segmentId : data.segmentIndex;

    if (!lessonId) {
      throw new HttpsError("invalid-argument", "lessonId is required");
    }

    let eventIdx = null;
    if (yellowEventIndex != null && String(yellowEventIndex).trim() !== "") {
      eventIdx = parseInt(String(yellowEventIndex), 10);
    } else if (segmentRef != null && String(segmentRef).trim() !== "") {
      const segIdx = parseInt(String(segmentRef), 10);
      if (!Number.isFinite(segIdx) || segIdx < 0) {
        throw new HttpsError("invalid-argument", "segmentIndex must be a non-negative integer");
      }
      if (segIdx === 0) {
        throw new HttpsError(
          "invalid-argument",
          "segmentIndex 0 is opening; use yellowEventIndex or a content row index >= 1."
        );
      }
      eventIdx = segIdx - 1;
    } else {
      throw new HttpsError(
        "invalid-argument",
        "Provide yellowEventIndex (0-based) or segmentId / segmentIndex (srcArray row, >= 1 for content)."
      );
    }

    if (!Number.isFinite(eventIdx) || eventIdx < 0) {
      throw new HttpsError("invalid-argument", "Invalid yellow event index");
    }

    const snap = await db.collection("lessons").doc(lessonId).get();
    if (!snap.exists) {
      throw new HttpsError("not-found", `Lesson not found: ${lessonId}`);
    }
    const snapData = snap.data();
    const events = snapData.yellowScreenEvents ||
      (snapData.yellowDetection && snapData.yellowDetection.events) || [];
    if (eventIdx >= events.length) {
      throw new HttpsError("out-of-range", `No yellow event at index ${eventIdx} (${events.length} events).`);
    }

    return runAiChapterMappingForEventIndexes(lessonId, [eventIdx]);
  }
);

/**
 * Batch AI title-mapping: optional eventIndexes (0-based); defaults to all yellow events.
 */
exports.mapYellowEventsToChaptersWithAI = onCall(
  {
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const { lessonId, eventIndexes } = request.data || {};
    if (!lessonId) {
      throw new HttpsError("invalid-argument", "lessonId is required");
    }

    const lessonSnap = await db.collection("lessons").doc(lessonId).get();
    if (!lessonSnap.exists) {
      throw new HttpsError("not-found", `Lesson not found: ${lessonId}`);
    }
    const lsData = lessonSnap.data();
    const events = lsData.yellowScreenEvents ||
      (lsData.yellowDetection && lsData.yellowDetection.events) || [];
    let idxs;
    if (Array.isArray(eventIndexes) && eventIndexes.length > 0) {
      idxs = eventIndexes;
    } else {
      idxs = events.map((_, i) => i);
    }
    return runAiChapterMappingForEventIndexes(lessonId, idxs);
  }
);

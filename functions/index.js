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

exports.generateSrcArray = onObjectFinalized(
  {
    memory: "1GiB",
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

  const lessonId = path.basename(filePath, ".mp4");

  const bucket = storage.bucket(bucketName);
  const tmpFile = path.join(os.tmpdir(), path.basename(filePath));

  console.log("Downloading video to:", tmpFile);
  await bucket.file(filePath).download({ destination: tmpFile });

  console.log("Getting duration...");
  const duration = await getDuration(tmpFile);
  console.log("Duration:", duration);

  console.log("Detecting yellow screens for initial srcArray...");
  let yellowRanges = [];
  try {
    yellowRanges = await detectYellowFrames(tmpFile);
  } catch (e) {
    console.error("detectYellowFrames failed during generateSrcArray:", e);
    yellowRanges = [];
  }
  console.log("Detected yellow ranges for srcArray generation:", yellowRanges);

  let srcArray;
  if (yellowRanges && yellowRanges.length > 0) {
    console.log("Building srcArray from yellow ranges...");
    srcArray = buildSrcArrayFromYellow(yellowRanges, duration);
  } else {
    console.log("No yellow ranges detected, falling back to scene-based srcArray...");
    const scenes = await detectScenes(tmpFile);
    console.log("Detected scenes for fallback:", scenes);
    srcArray = buildSceneBasedSrcArray(scenes, duration);
  }

  console.log("Writing srcArray to Firestore...");
  await db.collection("lessons").doc(lessonId).set(
    { srcArray },
    { merge: true }
  );

  console.log("Cleaning up temp file...");
  fs.unlinkSync(tmpFile);

  console.log("Done!");
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

// Build a baseline srcArray driven by yellow screen detections.
// Each yellow card is treated as the start of a content segment:
// - segment i starts just after yellowRanges[i].end
// - segment i ends at the start of yellowRanges[i+1] (or video end for the last)
// If no yellow screens are detected, fall back to a single full-length segment.
function buildSrcArrayFromYellow(yellowRanges, duration) {
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

  if (!yellowRanges || yellowRanges.length === 0) {
    // No yellow screens: single segment for the whole video
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

  // Sort ranges by start time
  const ranges = [...yellowRanges].sort((a, b) => {
    const as = typeof a.start === "number" ? a.start : 0;
    const bs = typeof b.start === "number" ? b.start : 0;
    return as - bs;
  });

  const EPS = 0.05; // 50ms offset to jump past yellow frames

  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const next = ranges[i + 1] || null;

    const rawStart = typeof r.end === "number" ? r.end : (typeof r.start === "number" ? r.start : 0);
    let start = rawStart + EPS;
    if (!isFinite(start) || start < 0) start = 0;

    let end;
    if (next && typeof next.start === "number") {
      end = Math.max(start + 0.01, next.start);
    } else {
      end = duration;
    }

    if (end - start < 0.05) {
      continue; // skip degenerate segments
    }

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
    memory: "1GiB",
    timeoutSeconds: 120,
  },
  async (request) => {
  const { videoPath, videoFilename } = request.data;
  
  if (!videoPath || !videoFilename) {
    throw new Error("videoPath and videoFilename are required");
  }

  const bucket = admin.storage().bucket();
  const tmpFile = path.join(os.tmpdir(), `yellow_detect_${Date.now()}.mp4`);

  try {
    console.log("Downloading video for yellow screen detection:", videoPath);
    await bucket.file(videoPath).download({ destination: tmpFile });

    console.log("Detecting yellow screen frames...");
    const yellowRanges = await detectYellowFrames(tmpFile);
    console.log("Detected yellow screen ranges:", yellowRanges);

    // Load current srcArray/originalSrcArray
    const videoDocRef = db.collection("lessons").doc(videoFilename);
    const videoSnap = await videoDocRef.get();
    const videoData = videoSnap.exists ? videoSnap.data() : {};
    const currentSrcArray = Array.isArray(videoData.srcArray) ? videoData.srcArray : [];
    const originalSrcArray = Array.isArray(videoData.originalSrcArray) && videoData.originalSrcArray.length > 0
      ? videoData.originalSrcArray
      : currentSrcArray;

    // Compute cleaned srcArray that skips yellow ranges
    const cleanedSrcArray = adjustSrcArrayForYellowScreen(originalSrcArray, yellowRanges);
    const adjustedSegments = cleanedSrcArray.length;

    // Store ranges and cleaned srcArray, preserving originalSrcArray
    await videoDocRef.set({
      yellowScreenRanges: yellowRanges,
      srcArray: cleanedSrcArray,
      originalSrcArray: originalSrcArray
    }, { merge: true });

    console.log("Yellow screen detection complete (ranges stored and srcArray cleaned)");
    return {
      success: true,
      yellowRanges: yellowRanges,
      adjustedSegments
    };
  } catch (error) {
    console.error("Error detecting yellow screen:", error);
    throw new Error(`Yellow screen detection failed: ${error.message}`);
  } finally {
    // Clean up temp file
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  }
});

// Detect yellow screen frames using raw RGB frame data and LAB color space
// Avoids all FFmpeg color filters - uses raw video output and pixel sampling
// Returns yellow frame ranges after converting raw detections to contiguous spans
function detectYellowFrames(video) {
  return new Promise((resolve, reject) => {
    const yellowFrames = [];
    let videoWidth = null;
    let videoHeight = null;
    let frameRate = 5; // fps=5 from ffmpeg command
    let frameIndex = 0;
    let frameBuffer = Buffer.alloc(0);
    
    // Yellow target in LAB color space
    const yellowLAB = { L: 97, A: -21, B: 94 };
    // Relaxed thresholds so we reliably see bright yellow title cards:
    const deltaEThreshold = 55; // larger ΔE allows more variation around target yellow
    const sampleStep = 24; // sample grid a bit more coarsely
    const yellowPixelThreshold = 0.25; // at least 25% of sampled pixels must be yellow

    // First, get video dimensions from FFmpeg
    getVideoDimensions(video).then(({ width, height }) => {
      videoWidth = width;
      videoHeight = height;
      const frameSize = width * height * 3; // RGB24 = 3 bytes per pixel

      // Use ffmpeg to output raw RGB frames at 5 fps
      const proc = spawn(ffmpegPath, [
        "-i", video,
        "-vf", "fps=5",
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

        // Convert raw {frame, time} entries to time ranges
        const uniqueTimes = [...new Set(yellowFrames.map((entry) => entry.time))].sort((a, b) => a - b);
        console.log("Detected yellow frames:", yellowFrames);

        const yellowRanges = framesToRanges(uniqueTimes);
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

// Convert frame detections to time ranges
function framesToRanges(yellowFrames) {
  if (yellowFrames.length === 0) return [];
  
  const ranges = [];
  let rangeStart = yellowFrames[0];
  let rangeEnd = yellowFrames[0];
  
  for (let i = 1; i < yellowFrames.length; i++) {
    const currentFrame = yellowFrames[i];
    
    // If frames are consecutive or very close (within 0.6s), treat as same yellow card
    if (currentFrame - rangeEnd <= 0.6) {
      rangeEnd = currentFrame;
    } else {
      // End current range and start new one
      ranges.push({
        start: Math.round(rangeStart * 100) / 100,
        end: Math.round((rangeEnd + 0.2) * 100) / 100 // small buffer after last yellow frame
      });
      rangeStart = currentFrame;
      rangeEnd = currentFrame;
    }
  }
  
  // Add final range
  ranges.push({
    start: Math.round(rangeStart * 100) / 100,
    end: Math.round((rangeEnd + 0.4) * 100) / 100 // slightly larger buffer after last yellow frame
  });
  
  return mergeYellowRanges(ranges);
}

// Merge yellow ranges that are close together (within 0.5 seconds)
function mergeYellowRanges(ranges) {
  if (ranges.length === 0) return [];
  
  const merged = [];
  ranges.sort((a, b) => a.start - b.start);
  
  let current = { ...ranges[0] };
  
  for (let i = 1; i < ranges.length; i++) {
    const next = ranges[i];
    // If ranges are close (within 0.5 seconds), merge them
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

// Adjust srcArray to skip yellow screen ranges
function adjustSrcArrayForYellowScreen(srcArray, yellowRanges) {
  if (!yellowRanges || yellowRanges.length === 0) {
    return srcArray; // No yellow screens detected, return original
  }

  const adjusted = [];
  
  for (const segment of srcArray) {
    // Keep opening segment (no timing)
    if (segment.src_start === null || segment.src_end === null) {
      adjusted.push(segment);
      continue;
    }

    let segmentStart = segment.src_start;
    let segmentEnd = segment.src_end;
    let segmentSkipped = false;

    // Check if segment overlaps with any yellow screen range
    for (const yellowRange of yellowRanges) {
      // If segment is entirely within yellow range, skip it
      if (segmentStart >= yellowRange.start && segmentEnd <= yellowRange.end) {
        segmentSkipped = true;
        break;
      }
      
      // If segment overlaps with yellow range, adjust it
      if (segmentStart < yellowRange.end && segmentEnd > yellowRange.start) {
        // Segment starts before yellow but overlaps
        if (segmentStart < yellowRange.start && segmentEnd > yellowRange.start) {
          // Split: keep part before yellow
          if (yellowRange.start - segmentStart > 0.1) {
            adjusted.push({
              ...segment,
              src_start: segmentStart,
              src_end: yellowRange.start
            });
          }
          // Adjust segment to start after yellow
          segmentStart = yellowRange.end;
        }
        
        // Segment starts in yellow but extends beyond
        if (segmentStart < yellowRange.end && segmentEnd > yellowRange.end) {
          segmentStart = yellowRange.end;
        }
      }
    }

    // Add segment if it wasn't entirely skipped and has valid timing
    if (!segmentSkipped && segmentEnd > segmentStart && segmentEnd - segmentStart > 0.1) {
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
    const { videoPath, videoFilename, lessonId, segmentLinks } = request.data;

    if (!videoPath || !videoFilename) {
      throw new Error("videoPath and videoFilename are required");
    }

    const bucket = admin.storage().bucket();
    const tmpFile = path.join(os.tmpdir(), `title_detect_${Date.now()}.mp4`);

    try {
      console.log("Downloading video for title detection:", videoPath);
      await bucket.file(videoPath).download({ destination: tmpFile });

      // Get current srcArray from Firestore
      const videoDoc = await db.collection("lessons").doc(videoFilename).get();
      if (!videoDoc.exists) {
        throw new Error(`Video document not found: ${videoFilename}`);
      }

      const videoData = videoDoc.data();
      const srcArray = videoData.srcArray || [];

      if (srcArray.length === 0) {
        throw new Error(`srcArray is empty for video: ${videoFilename}`);
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

      // Update Firestore with adjusted srcArray
      await db.collection("lessons").doc(videoFilename).set({
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
    const { videoPath, videoFilename, lessonId, chapters } = request.data;

    if (!videoPath || !videoFilename || !Array.isArray(chapters)) {
      throw new Error("videoPath, videoFilename and chapters[] are required");
    }

    const bucket = admin.storage().bucket();
    const tmpFile = path.join(os.tmpdir(), `srcarray_yellow_${Date.now()}.mp4`);

    try {
      console.log("Downloading video for srcArray generation:", videoPath);
      await bucket.file(videoPath).download({ destination: tmpFile });

      // Get duration for fallback segment boundaries
      const duration = await getDuration(tmpFile);
      console.log("Video duration for srcArray:", duration);

      // Detect yellow screen ranges
      let yellowRanges = [];
      try {
        yellowRanges = await detectYellowFrames(tmpFile);
      } catch (e) {
        console.error("detectYellowFrames failed, continuing with no detections:", e);
        yellowRanges = [];
      }
      console.log("Detected yellow ranges:", yellowRanges);

      // Use the end of each yellow range as a boundary between chapters
      let starts = yellowRanges
        .map((r) => (r && typeof r.end === "number" ? r.end : r && typeof r.start === "number" ? r.start : null))
        .filter((t) => typeof t === "number" && !isNaN(t))
        .sort((a, b) => a - b);

      // Filter out extremely short gaps between boundaries (likely noise)
      const MIN_GAP = 0.3;
      const filtered = [];
      let last = null;
      for (const t of starts) {
        if (last == null || t - last >= MIN_GAP) {
          filtered.push(t);
          last = t;
        }
      }
      starts = filtered;

      const chapterCount = chapters.length;
      const detectionCount = starts.length;

      let status = "ok";
      let reason = "";

      const diff = Math.abs(chapterCount - detectionCount);
      if (detectionCount === 0) {
        status = "needs_review";
        reason = "no yellow screens detected; using even spacing across duration";
      } else if (diff > 3) {
        status = "failed";
        reason = `chapter/detection mismatch (chapters=${chapterCount}, detections=${detectionCount})`;
      } else if (diff > 1) {
        status = "needs_review";
        reason = `counts differ (chapters=${chapterCount}, detections=${detectionCount})`;
      }

      // If the mismatch is too large, don't attempt to auto-map segments
      if (status === "failed") {
        await db.collection("lessons").doc(videoFilename).set(
          {
            autoMapping: {
              method: "yellowSequential",
              lessonId,
              videoPath,
              chapters: chapterCount,
              detections: detectionCount,
              status,
              reason,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
          { merge: true }
        );

        return {
          success: false,
          status,
          reason,
          chapters: chapterCount,
          detections: detectionCount,
        };
      }

      // Build srcArray: Opening + one segment per chapter
      // Trim or pad boundaries to chapter count
      const usableCount = Math.min(chapterCount, detectionCount);
      const usedStarts = starts.slice(0, usableCount);

      const srcArray = [];

      // Opening segment
      srcArray.push({
        src_start: null,
        src_end: null,
        freezeFrame: null,
        menuLink: "Opening",
        side: false,
        loop: false,
      });

      for (let i = 0; i < chapterCount; i++) {
        // For chapters beyond the number of detections, approximate their start
        // by interpolating towards the end of the video.
        let start;
        if (i < usedStarts.length) {
          start = usedStarts[i];
        } else if (usedStarts.length > 0) {
          const lastDetected = usedStarts[usedStarts.length - 1];
          const remaining = chapterCount - usedStarts.length;
          const offsetIndex = i - usedStarts.length + 1;
          const gapPerChapter = (duration - lastDetected) / (remaining + 1);
          start = lastDetected + gapPerChapter * offsetIndex;
        } else {
          // No detections at all: distribute evenly across the video
          const gap = duration / (chapterCount + 1);
          start = gap * (i + 1);
        }

        let end;
        if (i + 1 < usedStarts.length) {
          end = usedStarts[i + 1];
        } else {
          // Last chapter runs to the end of the video
          end = duration;
        }

        // Clamp and round
        start = Math.max(0, Math.min(start, duration));
        end = Math.max(start + 0.01, Math.min(end, duration));

        srcArray.push({
          src_start: Math.round(start * 100) / 100,
          src_end: Math.round(end * 100) / 100,
          freezeFrame: i,
          menuLink: chapters[i],
          side: false,
          loop: false,
        });
      }

      console.log("Writing chapter-aware srcArray with yellowSequential mapping...");
      await db.collection("lessons").doc(videoFilename).set(
        {
          srcArray,
          autoMapping: {
            method: "yellowSequential",
            lessonId,
            videoPath,
            chapters: chapterCount,
            detections: detectionCount,
            status,
            reason,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

      return {
        success: true,
        status,
        chapters: chapterCount,
        detections: detectionCount,
        reason,
        segments: srcArray.length,
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

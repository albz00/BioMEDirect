/* eslint-disable max-len, require-jsdoc */
/**
 * Isolated OpenAI title-mapping layer (server-side only).
 * Uses the Responses API (POST /v1/responses) with image inputs + structured JSON (json_schema).
 *
 * Env (local: functions/.env loaded via dotenv in index.js; deploy: set in Cloud Functions / Firebase):
 * OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-5.4-mini),
 * OPENAI_TITLE_MAPPING_ENABLED (optional "true")
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const DEFAULT_MODEL = "gpt-5.4-mini";

/** Inner JSON Schema object (used inside Responses API text.format). */
const CHAPTER_MATCH_SCHEMA_BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    bestChapterIndex: {
      type: "integer",
      description: "1-based index into the ordered chapter list provided in the prompt",
    },
    matchedTitle: {type: "string"},
    normalizedTitle: {type: "string"},
    confidence: {type: "number"},
    startAdjustmentSec: {type: "number"},
    endAdjustmentSec: {type: "number"},
    reason: {type: "string"},
    needsManualReview: {type: "boolean"},
  },
  required: [
    "bestChapterIndex",
    "matchedTitle",
    "normalizedTitle",
    "confidence",
    "startAdjustmentSec",
    "endAdjustmentSec",
    "reason",
    "needsManualReview",
  ],
};

/** Exported for tests / tooling; same logical schema as Chat Completions json_schema block. */
const CHAPTER_MATCH_JSON_SCHEMA = {
  name: "chapter_title_match",
  strict: true,
  schema: CHAPTER_MATCH_SCHEMA_BODY,
};

function getOpenAiConfig() {
  const apiKey = process.env.OPENAI_API_KEY || "";
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const enabled =
    process.env.OPENAI_TITLE_MAPPING_ENABLED === "true" ||
    process.env.OPENAI_TITLE_MAPPING_ENABLED === "1";
  return {apiKey, model, enabled};
}

function isAiTitleMappingConfigured() {
  const {apiKey} = getOpenAiConfig();
  return Boolean(apiKey && String(apiKey).trim());
}

/**
 * One-line startup log: enabled flag, model, hasApiKey (boolean only). Never logs the key.
 */
function logOpenAiTitleMappingEnvHealth() {
  const cfg = getOpenAiConfig();
  const hasApiKey = Boolean(cfg.apiKey && String(cfg.apiKey).trim());
  console.log("[openai-title-mapping env]", JSON.stringify({
    aiEnabled: cfg.enabled,
    model: cfg.model,
    hasApiKey,
  }));
}

/**
 * Walk Responses API `output` for the assistant message text (structured JSON string).
 * @param {object} data - Parsed JSON body from POST /v1/responses
 * @return {string|null}
 */
function extractResponsesOutputText(data) {
  const out = data && data.output;
  if (!Array.isArray(out)) return null;
  for (let i = 0; i < out.length; i++) {
    const item = out[i];
    if (!item || item.type !== "message") continue;
    const parts = item.content;
    if (!Array.isArray(parts)) continue;
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      if (part && part.type === "output_text" && part.text) {
        return part.text;
      }
    }
  }
  return null;
}

/**
 * @param {object} params
 * @param {string[]} params.chapterTitles - ordered chapter titles (index 0 = chapter 1)
 * @param {Array<{ label: string, base64Png: string }>} params.images - PNG base64 (no data URL prefix)
 * @param {object} params.eventContext - yellow/content timing and deterministic guess
 * @return {Promise<object>} parsed JSON matching schema
 */
async function callOpenAiChapterMatch({chapterTitles, images, eventContext}) {
  const {apiKey, model} = getOpenAiConfig();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const listText = (chapterTitles || [])
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n");

  const prompt = `You are helping map full-frame yellow TITLE CARD screens in an educational video to the correct chapter.

The ordered chapter list (use 1-based bestChapterIndex):
${listText}

Timing / detection context (seconds, approximate):
${JSON.stringify(eventContext, null, 2)}

Instructions:
- Look at the attached images (frames from around the yellow card / transition). Identify visible title text if any.
- Pick exactly ONE bestChapterIndex that matches the title card text and ordering in the video.
- If text is unreadable or ambiguous, set needsManualReview to true and confidence below 0.6.
- startAdjustmentSec / endAdjustmentSec: optional small corrections (-0.5 to 0.5) to yellow boundaries if clearly justified; otherwise 0.
- Do NOT invent chapters outside the list. bestChapterIndex must be between 1 and ${chapterTitles.length}.`;

  const content = [{type: "input_text", text: prompt}];
  for (const im of images || []) {
    if (!im || !im.base64Png) continue;
    content.push({
      type: "input_image",
      image_url: `data:image/png;base64,${im.base64Png}`,
      detail: "low",
    });
  }

  const body = {
    model,
    instructions:
      "You output only valid JSON matching the schema. You are a visual title-card matcher for educational video chapters.",
    input: [
      {
        role: "user",
        content,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: CHAPTER_MATCH_JSON_SCHEMA.name,
        strict: CHAPTER_MATCH_JSON_SCHEMA.strict,
        schema: CHAPTER_MATCH_JSON_SCHEMA.schema,
      },
    },
    temperature: 0.2,
    max_output_tokens: 500,
  };

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`OpenAI Responses API: invalid JSON (${res.status})`);
  }

  if (!res.ok) {
    const msg =
      (data && data.error && data.error.message) ||
      (typeof data === "string" ? data : res.statusText);
    throw new Error(`OpenAI Responses API error (${res.status}): ${msg}`);
  }

  if (data.error) {
    const em = data.error.message || JSON.stringify(data.error);
    throw new Error(`OpenAI Responses API error: ${em}`);
  }

  if (data.status && data.status !== "completed") {
    const detail = data.incomplete_details ?
      JSON.stringify(data.incomplete_details) :
      "";
    throw new Error(`OpenAI response not completed: ${data.status} ${detail}`.trim());
  }

  const raw = extractResponsesOutputText(data);
  if (!raw) {
    throw new Error("OpenAI Responses API returned no output_text");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`OpenAI JSON parse failed: ${e.message}`);
  }

  const maxCh = Math.max(1, chapterTitles.length);
  if (
    typeof parsed.bestChapterIndex !== "number" ||
    parsed.bestChapterIndex < 1 ||
    parsed.bestChapterIndex > maxCh
  ) {
    parsed.needsManualReview = true;
    parsed.reason = `${parsed.reason || ""} (clamped bestChapterIndex was out of range; needs review)`;
    parsed.bestChapterIndex = Math.min(maxCh, Math.max(1, Math.round(parsed.bestChapterIndex) || 1));
  }

  return parsed;
}

module.exports = {
  getOpenAiConfig,
  isAiTitleMappingConfigured,
  callOpenAiChapterMatch,
  logOpenAiTitleMappingEnvHealth,
  CHAPTER_MATCH_JSON_SCHEMA,
};

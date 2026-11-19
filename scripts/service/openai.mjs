import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { reviewApiKey } from "./project-key.mjs";
import { ruleGuidance, validateSummary } from "./brief.mjs";

const endpoint = "https://api.openai.com/v1/responses";
const defaultModel = "gpt-6.2-sol";
const supportedModels = [defaultModel, "gpt-6.1-sol"];
const maxCalls = 100;
const maxOutputTokens = 1600;
const maxRequestBytes = 12 * 1024;
const maxResponseBytes = 48 * 1024;

function monthlyCap() {
  const value = process.env.API_MIGRATOR_AI_MAX_CALLS ?? "100";
  if (!/^(?:0|[1-9]\d?|100)$/.test(value)) {
    throw new Error("API_MIGRATOR_AI_MAX_CALLS must be an integer from 0 to 100.");
  }
  return Number(value);
}

// Creating each numbered directory is atomic across local CLI processes.
// An interrupted or unsuccessful request keeps its reservation because the
// server may already have processed it. No keys or payloads are written.
async function reserveAttempt(ledgerRoot, cap) {
  if (cap > 0) {
    const monthDirectory = join(ledgerRoot, new Date().toISOString().slice(0, 7));
    await mkdir(monthDirectory, { recursive: true, mode: 0o700 });
    for (let slot = 1; slot <= cap; slot++) {
      try {
        await mkdir(join(monthDirectory, String(slot)), { mode: 0o700 });
        return;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
  }
  throw new Error("Monthly OpenAI review-plan attempt limit reached.");
}

function requestBody(model, recipe, review) {
  const ids = review.map(({ code }) => code);
  return JSON.stringify({
    model,
    service_tier: "default",
    reasoning: { effort: "low" },
    store: false,
    max_output_tokens: maxOutputTokens,
    instructions: "Help an engineer review an SDK migration. Rank the listed manual-review rules by dependency and likely behavioral impact. Return each supplied code exactly once in your preferred order. For each code, ask one short actionable question using the supplied rule guidance. Use plain English, letters, numbers, spaces, commas and a final question mark. Aim for fewer than 120 characters per question. Do not invent project facts, add links or commands, certify correctness, or recommend deployment.",
    input: JSON.stringify({ recipe, review }),
    text: {
      format: {
        type: "json_schema", name: "sdk_review_plan", strict: true,
        schema: {
          type: "object", additionalProperties: false, required: ["questions"],
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["code", "question"],
                properties: { code: { type: "string", enum: ids }, question: { type: "string" } },
              },
            },
          },
        },
      },
    },
  });
}

async function readResponse(response) {
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maxResponseBytes) throw new Error("Oversize response.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function verifiedQuestions(response, ids) {
  if (response.status !== "completed" || !Array.isArray(response.output)) throw new Error();
  const messages = response.output.filter(item => item.type !== "reasoning");
  const message = messages[0];
  if (messages.length !== 1 || message.type !== "message" || message.role !== "assistant" ||
      message.status !== "completed" || message.content?.length !== 1 ||
      message.content[0]?.type !== "output_text") throw new Error();
  const result = JSON.parse(message.content[0].text);
  if (Object.keys(result).length !== 1 || !Array.isArray(result.questions) ||
      result.questions.length !== ids.length) throw new Error();
  const remaining = new Set(ids);
  const questions = [];
  for (const item of result.questions) {
    if (!item || Object.keys(item).length !== 2 || !remaining.delete(item.code) ||
        typeof item.question !== "string" || item.question.length > 240 ||
        !/^[A-Za-z][A-Za-z0-9 .,_()’'–-]*\?$/u.test(item.question) || /[\r\n]|www\./i.test(item.question)) throw new Error();
    questions.push({ code: item.code, question: item.question });
  }
  return { order: questions.map(({ code }) => code), questions };
}

// The CLI opts into this function explicitly. The only account input is the
// local environment. Tests inject a transport and an isolated ledger.
export async function suggestReviewPlan(value, {
  fetchImpl = globalThis.fetch,
  ledgerRoot = join(isAbsolute(process.env.XDG_STATE_HOME ?? "") ? process.env.XDG_STATE_HOME : join(homedir(), ".local", "state"), "api-migrator", "review-plan-attempts"),
} = {}) {
  const summary = validateSummary(value);
  const review = summary.findings.filter(finding => finding.kind === "review")
    .map(({ code, count }) => ({ code, count, guidance: ruleGuidance(summary.recipe, code) }));
  if (review.length === 0) return { order: [], questions: [] };

  const apiKey = reviewApiKey();
  const model = process.env.API_MIGRATOR_AI_MODEL ?? defaultModel;
  if (!supportedModels.includes(model)) throw new Error("Choose gpt-6.2-sol or gpt-6.1-sol for the review plan.");
  const body = requestBody(model, summary.recipe, review);
  if (Buffer.byteLength(body) > maxRequestBytes) throw new Error("Review plan exceeds the request size limit.");
  await reserveAttempt(ledgerRoot, monthlyCap());
  let data;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) data = await readResponse(response);
    else await response.body?.cancel();
  } catch {
    throw new Error("OpenAI review plan request failed, timed out, or returned unreadable data.");
  }
  if (!response.ok) throw new Error(`OpenAI review plan request failed (HTTP ${response.status}).`);
  try {
    return verifiedQuestions(data, review.map(({ code }) => code));
  } catch {
    throw new Error("OpenAI did not return a complete review plan for the reported rules.");
  }
}

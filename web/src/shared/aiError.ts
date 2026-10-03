/**
 * shared/aiError — turn a raw AI-endpoint failure into a friendly, actionable
 * message. The backend degrades gracefully (503 when no backend is available,
 * 422 on unusable model output).
 *
 * ⚠ Only the "no AI backend available" 503 gets REPLACED by the generic BYOK
 * hint — every other 503/422 detail (provider rejected the key, timeout,
 * model can't do vision…) is the caller's own actionable error and MUST
 * surface verbatim; swallowing it made failures undebuggable ("AI is
 * unavailable" for five different root causes).
 */
import { ApiError } from "./api/client";

const NO_SERVER_AI = /no ai backend available|databricks is not configured/i;

/** Provider phrasings for "this model can't read images" (OpenRouter's
 * "No endpoints found that support image input", OpenAI's "does not support
 * image inputs", …). */
const NO_VISION =
  /support(s)? image input|image[_ ]?url is only supported|does not support (image|vision)|multimodal (is )?not (supported|available)/i;

/** Append an actionable hint to raw AI errors we recognize (job rows show the
 * server's message verbatim — this turns "HTTP 404: No endpoints found that
 * support image input" into something the user can act on). */
/** "Your saved key is wrong" phrasings (Google's "Please pass a valid API key",
 * OpenAI's "Incorrect API key", HTTP 401/403 from a provider…). */
const BAD_KEY =
  /pass a valid api key|api key not valid|invalid[_ ]?api[_ ]?key|incorrect api key|invalid x-api-key|authentication(_error)?|HTTP 40[13]\b/i;

export function withAiHints(message: string): string {
  if (BAD_KEY.test(message)) {
    return (
      message +
      " → The API key saved in this browser was rejected by the provider. Open AI settings and fix it — or remove it to use the free shared pool (no key needed)."
    );
  }
  if (NO_VISION.test(message)) {
    return (
      message +
      " → Your configured model can't read images. Open AI settings and switch to a vision-capable model (GPT-4o/5, Claude, Gemini 2.5+…)."
    );
  }
  return message;
}

export function aiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.message || "").trim();
    if (err.status === 503) {
      if (!detail || NO_SERVER_AI.test(detail)) {
        return (
          "AI isn't available yet — add your own API key (BYOK) in AI settings " +
          "and it runs entirely on your key."
        );
      }
      return withAiHints(detail);
    }
    if (err.status === 422) {
      return detail
        ? `The AI couldn't produce a usable result: ${withAiHints(detail)}`
        : "The AI couldn't produce a usable result from this image — try a clearer image or add a description.";
    }
    return withAiHints(err.message);
  }
  return err instanceof Error ? withAiHints(err.message) : String(err);
}

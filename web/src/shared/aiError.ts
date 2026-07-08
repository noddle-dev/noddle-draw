/**
 * shared/aiError — turn a raw AI-endpoint failure into a friendly, actionable
 * message. The backend degrades gracefully (503 when no provider is configured,
 * 402 when a subscription wallet is empty, 422 on unusable model output).
 *
 * ⚠ Only the "server has no AI configured" 503 gets REPLACED by the generic
 * BYOK hint — every other 503/422 detail (provider rejected the key, timeout,
 * profile deleted, model can't do vision…) is the caller's own actionable
 * error and MUST surface verbatim; swallowing it made failures undebuggable
 * ("AI chưa khả dụng" for five different root causes).
 */
import { ApiError } from "./api/client";

const NO_SERVER_AI = /databricks is not configured/i;

/** Provider phrasings for "this model can't read images" (OpenRouter's
 * "No endpoints found that support image input", OpenAI's "does not support
 * image inputs", …). */
const NO_VISION =
  /support(s)? image input|image[_ ]?url is only supported|does not support (image|vision)|multimodal (is )?not (supported|available)/i;

/** Append an actionable hint to raw AI errors we recognize (job rows show the
 * server's message verbatim — this turns "HTTP 404: No endpoints found that
 * support image input" into something the user can act on). */
export function withAiHints(message: string): string {
  if (NO_VISION.test(message)) {
    return (
      message +
      " → Model trong profile của bạn không đọc được ảnh. Vào Settings → AI provider và đổi sang model có vision (GPT-4o/5, Claude, Gemini 2.5+…)."
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
          "AI chưa khả dụng trên máy chủ này. Thêm API key của bạn (BYOK) trong " +
          "Settings → AI provider để tự chạy, hoặc dùng gói trả phí."
        );
      }
      return detail;
    }
    if (err.status === 402) {
      return (
        "Bạn đã hết ✦ credit cho tác vụ AI này. Nâng cấp gói trong Settings, " +
        "hoặc chuyển sang API key của bạn (BYOK)."
      );
    }
    if (err.status === 422) {
      return detail
        ? `AI không tạo được kết quả dùng được: ${withAiHints(detail)}`
        : "AI không tạo được kết quả dùng được từ ảnh này — thử ảnh rõ hơn hoặc mô tả thêm.";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

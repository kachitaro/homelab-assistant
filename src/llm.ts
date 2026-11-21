import type { LanguageModel } from "ai";
import { createGoogle } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOllama } from "ollama-ai-provider-v2";
import type { Config } from "./config.ts";

export type ProviderName = "google" | "anthropic" | "ollama";

export interface ModelEntry {
  /** vd "google:gemini-flash-latest" */
  id: string;
  provider: ProviderName;
  model: LanguageModel;
}

const ALIASES: Record<string, ProviderName> = {
  google: "google",
  gemini: "google",
  anthropic: "anthropic",
  claude: "anthropic",
  ollama: "ollama",
};

/**
 * Đọc MODEL_CHAIN ("google:gemini-flash-latest,anthropic:claude-sonnet-5-5,ollama:qwen2.5:3b")
 * thành danh sách model theo thứ tự ưu tiên. Bỏ qua provider thiếu API key.
 */
export function buildModelChain(cfg: Config): ModelEntry[] {
  const google = cfg.GOOGLE_GENERATIVE_AI_API_KEY
    ? createGoogle({ apiKey: cfg.GOOGLE_GENERATIVE_AI_API_KEY })
    : null;
  const anthropic = cfg.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: cfg.ANTHROPIC_API_KEY }) : null;
  const ollama = createOllama({ baseURL: cfg.OLLAMA_BASE_URL });

  const chain: ModelEntry[] = [];
  for (const raw of cfg.MODEL_CHAIN.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = raw.indexOf(":");
    if (idx === -1) {
      console.warn(`[llm] Bỏ qua "${raw}": thiếu dạng provider:model`);
      continue;
    }
    const provider = ALIASES[raw.slice(0, idx).toLowerCase()];
    const modelId = raw.slice(idx + 1); // giữ nguyên dấu ":" trong tên model ollama (qwen2.5:3b)
    if (!provider) {
      console.warn(`[llm] Provider không hỗ trợ: ${raw}`);
      continue;
    }
    if (provider === "google") {
      if (!google) {
        console.warn("[llm] Bỏ qua Gemini: chưa có GOOGLE_GENERATIVE_AI_API_KEY");
        continue;
      }
      chain.push({ id: `google:${modelId}`, provider, model: google(modelId) });
    } else if (provider === "anthropic") {
      if (!anthropic) {
        console.warn("[llm] Bỏ qua Claude: chưa có ANTHROPIC_API_KEY");
        continue;
      }
      chain.push({ id: `anthropic:${modelId}`, provider, model: anthropic(modelId) });
    } else {
      chain.push({ id: `ollama:${modelId}`, provider, model: ollama(modelId) });
    }
  }
  if (chain.length === 0) throw new Error("MODEL_CHAIN không có model nào dùng được.");
  return chain;
}

/**
 * Sắp lại chuỗi để provider người dùng chọn (/model claude) đứng đầu,
 * các model còn lại vẫn làm dự phòng.
 */
export function orderChain(chain: ModelEntry[], preferred: ProviderName | null): ModelEntry[] {
  if (!preferred) return chain;
  return [...chain.filter((m) => m.provider === preferred), ...chain.filter((m) => m.provider !== preferred)];
}

export function parseProvider(input: string): ProviderName | null {
  return ALIASES[input.trim().toLowerCase()] ?? null;
}

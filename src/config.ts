import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  // ---- Kênh chat ----
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: csv,
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_ALLOWED_USER_IDS: csv,

  // ---- Model ----
  // Chuỗi fallback, thử lần lượt từ trái sang phải. Định dạng provider:modelId
  MODEL_CHAIN: z.string().default("google:gemini-flash-latest,ollama:qwen2.5:3b"),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://127.0.0.1:11434/api"),

  // ---- Notion ----
  NOTION_TOKEN: z.string().optional(),
  NOTION_INBOX_PARENT_PAGE_ID: z.string().optional(),
  NOTION_GYM_PARENT_PAGE_ID: z.string().optional(),

  // ---- Server ----
  SHELL_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  SHELL_CWD: z.string().default(process.env.HOME ?? "/"),
  SHELL_TIMEOUT_MS: z.coerce.number().default(30_000),

  // ---- Chung ----
  TZ_NAME: z.string().default("Asia/Ho_Chi_Minh"),
  DB_PATH: z.string().default("./data/assistant.db"),
  HISTORY_LIMIT: z.coerce.number().default(40),
  MAX_STEPS: z.coerce.number().default(8),
  ASSISTANT_NAME: z.string().default("Homelab"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error("Cấu hình .env không hợp lệ:\n" + parsed.error.message);
  }
  const cfg = parsed.data;
  if (!cfg.TELEGRAM_BOT_TOKEN && !cfg.DISCORD_BOT_TOKEN) {
    throw new Error("Cần ít nhất TELEGRAM_BOT_TOKEN hoặc DISCORD_BOT_TOKEN.");
  }
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_ALLOWED_USER_IDS.length === 0) {
    throw new Error("Đặt TELEGRAM_ALLOWED_USER_IDS để bot không trả lời người lạ.");
  }
  if (cfg.DISCORD_BOT_TOKEN && cfg.DISCORD_ALLOWED_USER_IDS.length === 0) {
    throw new Error("Đặt DISCORD_ALLOWED_USER_IDS để bot không trả lời người lạ.");
  }
  return cfg;
}

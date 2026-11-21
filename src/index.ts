import { Client as NotionClient } from "@notionhq/client";
import { createDiscord, type DiscordChannel } from "./channels/discord.ts";
import { createTelegram, type TelegramChannel } from "./channels/telegram.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { buildModelChain } from "./llm.ts";
import { Router } from "./router.ts";
import { Scheduler } from "./scheduler.ts";
import { ShellRunner } from "./tools/shell.ts";

const cfg = loadConfig();
const store = new Store(cfg.DB_PATH);
const chain = buildModelChain(cfg);
const scheduler = new Scheduler(store, cfg.TZ_NAME);
const shell = new ShellRunner(cfg.SHELL_CWD, cfg.SHELL_TIMEOUT_MS);
const notion = cfg.NOTION_TOKEN ? new NotionClient({ auth: cfg.NOTION_TOKEN }) : null;

const router = new Router({ cfg, store, chain, scheduler, shell, notion });

let telegram: TelegramChannel | null = null;
let discord: DiscordChannel | null = null;
if (cfg.TELEGRAM_BOT_TOKEN) telegram = createTelegram(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_ALLOWED_USER_IDS, router);
if (cfg.DISCORD_BOT_TOKEN) discord = createDiscord(cfg.DISCORD_BOT_TOKEN, cfg.DISCORD_ALLOWED_USER_IDS, router);

scheduler.setSender(async (channel, chatId, text) => {
  if (channel === "telegram" && telegram) return telegram.send(chatId, text);
  if (channel === "discord" && discord) return discord.send(chatId, text);
  console.warn(`[scheduler] Kênh ${channel} không bật, bỏ qua nhắc việc.`);
});

console.log(`[boot] Model: ${chain.map((m) => m.id).join(" → ")}`);
console.log(`[boot] Notion: ${notion ? "bật" : "tắt"} · Shell: ${cfg.SHELL_ENABLED ? "bật" : "tắt"}`);

await Promise.all([telegram?.start(), discord?.start()]);
scheduler.loadAll();

async function shutdown(signal: string) {
  console.log(`[boot] Nhận ${signal}, đang tắt…`);
  scheduler.stopAll();
  await Promise.allSettled([telegram?.stop(), discord?.stop()]);
  store.db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

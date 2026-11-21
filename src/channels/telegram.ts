import { Bot } from "grammy";
import type { Router } from "../router.ts";
import { splitMessage } from "../router.ts";

export interface TelegramChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
}

export function createTelegram(token: string, allowedUserIds: string[], router: Router): TelegramChannel {
  const bot = new Bot(token);
  const allowed = new Set(allowedUserIds);

  async function send(chatId: string, text: string) {
    for (const part of splitMessage(text, 4000)) {
      try {
        await bot.api.sendMessage(chatId, part, { parse_mode: "Markdown" });
      } catch {
        // Markdown của model đôi khi không hợp lệ với Telegram → gửi dạng thuần.
        await bot.api.sendMessage(chatId, part);
      }
    }
  }

  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!allowed.has(userId)) {
      console.warn(`[telegram] Từ chối user ${userId} (@${ctx.from.username ?? "?"})`);
      return;
    }
    const chatId = String(ctx.chat.id);
    await ctx.replyWithChatAction("typing").catch(() => {});
    const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4500);
    try {
      const reply = await router.handle("telegram", chatId, ctx.message.text);
      await send(chatId, reply);
    } finally {
      clearInterval(typing);
    }
  });

  bot.catch((err) => console.error("[telegram]", err.error));

  return {
    async start() {
      await bot.api.setMyCommands([
        { command: "help", description: "Hướng dẫn" },
        { command: "reset", description: "Xoá lịch sử chat" },
        { command: "model", description: "Chọn model ưu tiên" },
        { command: "reminders", description: "Xem nhắc việc" },
      ]);
      // Long polling: không cần mở port hay đi qua Cloudflare Tunnel.
      void bot.start({ onStart: (me) => console.log(`[telegram] Đang chạy với @${me.username}`) });
    },
    async stop() {
      await bot.stop();
    },
    send,
  };
}

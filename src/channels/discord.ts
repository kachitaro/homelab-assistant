import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { Router } from "../router.ts";
import { splitMessage } from "../router.ts";

export interface DiscordChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, text: string): Promise<void>;
}

/**
 * Bot trả lời khi: nhắn riêng (DM), hoặc được @mention trong server.
 * Cần bật "Message Content Intent" trong Discord Developer Portal.
 */
export function createDiscord(token: string, allowedUserIds: string[], router: Router): DiscordChannel {
  const allowed = new Set(allowedUserIds);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  async function send(channelId: string, text: string) {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isSendable()) throw new Error(`Không gửi được vào kênh ${channelId}`);
    for (const part of splitMessage(text, 1900)) await ch.send(part);
  }

  client.on(Events.MessageCreate, async (msg: Message) => {
    if (msg.author.bot) return;
    const isDM = !msg.guild;
    const mentioned = client.user ? msg.mentions.has(client.user) : false;
    if (!isDM && !mentioned) return;
    if (!allowed.has(msg.author.id)) {
      console.warn(`[discord] Từ chối user ${msg.author.id} (${msg.author.tag})`);
      return;
    }
    const text = msg.content.replace(/<@!?\d+>/g, "").trim();
    if (!text) return;

    const ch = msg.channel;
    const typing = () => ("sendTyping" in ch ? ch.sendTyping().catch(() => {}) : undefined);
    void typing();
    const timer = setInterval(typing, 8000);
    try {
      const reply = await router.handle("discord", msg.channelId, text);
      const parts = splitMessage(reply, 1900);
      await msg.reply(parts[0] ?? "…");
      for (const part of parts.slice(1)) if (ch.isSendable()) await ch.send(part);
    } finally {
      clearInterval(timer);
    }
  });

  client.once(Events.ClientReady, (c) => console.log(`[discord] Đang chạy với ${c.user.tag}`));

  return {
    async start() {
      await client.login(token);
    },
    async stop() {
      await client.destroy();
    },
    send,
  };
}

import type { Client as NotionClient } from "@notionhq/client";
import { runAgent, type AgentDeps } from "./agent.ts";
import type { ChannelName } from "./db.ts";
import { parseProvider } from "./llm.ts";
import type { Scheduler } from "./scheduler.ts";
import { buildTools } from "./tools/index.ts";
import { formatResult, type ShellRunner } from "./tools/shell.ts";

export interface RouterDeps extends AgentDeps {
  scheduler: Scheduler;
  shell: ShellRunner;
  notion: NotionClient | null;
}

const HELP = `Lệnh có sẵn:
/help – xem hướng dẫn
/reset – xoá lịch sử hội thoại của chat này
/model [gemini|claude|ollama] – chọn model ưu tiên (bỏ trống để xem)
/reminders – xem các nhắc việc
/ok <id> – chạy lệnh server đang chờ xác nhận
/no <id> – huỷ lệnh đang chờ

Ngoài ra cứ nhắn bình thường: hỏi đáp, "nhắc mình 7h sáng mai đi tập", "kiểm tra disk server", "soạn giáo án gym 4 buổi/tuần", "lưu ghi chú này vào Notion"...`;

/**
 * Bộ xử lý dùng chung cho mọi kênh. Mỗi chat được xử lý tuần tự
 * (hàng đợi theo chatKey) để lịch sử không bị chen ngang.
 */
export class Router {
  private queues = new Map<string, Promise<unknown>>();

  constructor(private deps: RouterDeps) {}

  handle(channel: ChannelName, chatId: string, text: string): Promise<string> {
    const chatKey = `${channel}:${chatId}`;
    const prev = this.queues.get(chatKey) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.process(channel, chatId, chatKey, text.trim()));
    this.queues.set(chatKey, next);
    void next.finally(() => {
      if (this.queues.get(chatKey) === next) this.queues.delete(chatKey);
    });
    return next;
  }

  private async process(channel: ChannelName, chatId: string, chatKey: string, text: string): Promise<string> {
    const { store, shell, chain } = this.deps;
    const [cmd, ...args] = text.split(/\s+/);
    const arg = args.join(" ");

    switch (cmd?.toLowerCase().replace(/@\S+$/, "")) {
      case "/start":
      case "/help":
        return HELP;

      case "/reset":
        store.clearHistory(chatKey);
        return "Đã xoá lịch sử hội thoại. Trí nhớ dài hạn và nhắc việc vẫn giữ nguyên.";

      case "/model": {
        if (!arg) {
          const pref = store.getKV<string>(`model:${chatKey}`);
          return `Chuỗi model: ${chain.map((m) => m.id).join(" → ")}\nƯu tiên hiện tại: ${pref ?? "mặc định (theo MODEL_CHAIN)"}`;
        }
        if (arg === "default") {
          store.setKV(`model:${chatKey}`, null);
          return "Đã về thứ tự mặc định.";
        }
        const p = parseProvider(arg);
        if (!p || !chain.some((m) => m.provider === p)) {
          return `Không có model "${arg}" trong MODEL_CHAIN. Đang có: ${[...new Set(chain.map((m) => m.provider))].join(", ")}`;
        }
        store.setKV(`model:${chatKey}`, p);
        return `Đã ưu tiên ${p}. Các model khác vẫn làm dự phòng khi lỗi.`;
      }

      case "/reminders": {
        const list = store.listReminders(channel, chatId);
        if (!list.length) return "Chưa có nhắc việc nào.";
        return list
          .map((r) => {
            const next = this.deps.scheduler.nextRun(r.id);
            const when = next?.toLocaleString("vi-VN", { timeZone: this.deps.cfg.TZ_NAME }) ?? "—";
            return `#${r.id} ${r.text}\n   ${r.cron ? `lặp: ${r.cron}` : "một lần"} · lần tới: ${when}`;
          })
          .join("\n");
      }

      case "/ok": {
        const command = shell.take(arg, chatKey);
        if (!command) return "Không tìm thấy lệnh chờ với mã này (hoặc đã hết hạn 10 phút).";
        const r = await shell.run(command);
        const out = formatResult(command, r);
        // Ghi vào lịch sử để model biết kết quả ở lượt sau.
        store.appendMessages(chatKey, [
          { role: "user", content: `[Đã xác nhận và chạy lệnh]\n${out}` },
          { role: "assistant", content: "Đã ghi nhận kết quả lệnh." },
        ]);
        return "```\n" + out + "\n```";
      }

      case "/no":
        return shell.cancel(arg, chatKey) ? "Đã huỷ lệnh." : "Không có lệnh chờ với mã này.";
    }

    const tools = buildTools({
      cfg: this.deps.cfg,
      store,
      scheduler: this.deps.scheduler,
      shell,
      notion: this.deps.notion,
      channel,
      chatId,
    });
    try {
      const reply = await runAgent(this.deps, chatKey, text, tools);
      return reply.text;
    } catch (err) {
      console.error("[router]", err);
      return "⚠️ Không gọi được model nào. Kiểm tra API key / Ollama rồi thử lại.\n" + (err as Error).message.slice(0, 500);
    }
  }
}

/** Chia tin dài theo giới hạn ký tự của từng nền tảng, ưu tiên cắt ở dòng trống. */
export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

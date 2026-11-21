import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { orderChain, type ModelEntry, type ProviderName } from "./llm.ts";
import { GYM_GUIDE } from "./tools/gym.ts";

export function buildInstructions(cfg: Config, store: Store, tools: ToolSet): string {
  const now = new Date().toLocaleString("vi-VN", {
    timeZone: cfg.TZ_NAME,
    dateStyle: "full",
    timeStyle: "short",
  });
  const offsetIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.TZ_NAME,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).format(new Date());
  const facts = store.listFacts();
  const has = (name: string) => name in tools;

  return [
    `Bạn là ${cfg.ASSISTANT_NAME}, trợ lí cá nhân chạy 24/7 trên home server của người dùng (Ubuntu Server, laptop HP i5, 8GB RAM).`,
    "Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào việc. Định dạng markdown đơn giản (đậm, list, code block) vì hiển thị trên Telegram/Discord.",
    `Bây giờ là ${now} (${offsetIso}), múi giờ ${cfg.TZ_NAME}. Dùng mốc này khi tính thời gian nhắc việc.`,
    "",
    "Nguyên tắc dùng tool:",
    "- Khi cần dữ liệu thật (trạng thái server, Notion, lịch nhắc) thì gọi tool, không đoán.",
    has("run_shell")
      ? "- run_shell: ưu tiên lệnh chỉ đọc. Nếu tool trả về pending_confirmation, nói rõ lệnh sẽ làm gì và nhắc người dùng gõ /ok <id> hoặc /no <id>. Không tự lách guard."
      : "- Không có quyền chạy lệnh trên server.",
    has("notion_search")
      ? "- Notion: tìm bằng notion_search trước, đọc bằng notion_read_page. Khi hỏi về quy ước/kiến thức của người dùng, tra Resources Database trước."
      : "- Notion chưa được kết nối.",
    "- Nhắc việc: luôn xác nhận lại thời điểm sẽ nhắc sau khi tạo.",
    "- remember: chỉ lưu điều bền vững người dùng nói rõ. Không lưu bí mật.",
    "",
    GYM_GUIDE,
    "",
    facts.length
      ? "Điều đã biết về người dùng:\n" + facts.map((f) => `- [#${f.id}] ${f.fact}`).join("\n")
      : "Chưa ghi nhớ điều gì về người dùng.",
  ].join("\n");
}

export interface AgentDeps {
  cfg: Config;
  store: Store;
  chain: ModelEntry[];
  /** Cho phép test thay generateText bằng mock. */
  generate?: typeof generateText;
}

export interface AgentReply {
  text: string;
  modelId: string;
}

/**
 * Chạy một lượt hội thoại: nạp lịch sử, gọi model (fallback theo chuỗi),
 * lưu message mới (user + assistant + tool) vào SQLite.
 */
export async function runAgent(
  deps: AgentDeps,
  chatKey: string,
  userText: string,
  tools: ToolSet,
): Promise<AgentReply> {
  const { cfg, store } = deps;
  const generate = deps.generate ?? generateText;
  const preferred = store.getKV<ProviderName>(`model:${chatKey}`);
  const chain = orderChain(deps.chain, preferred);

  const userMsg: ModelMessage = { role: "user", content: userText };
  const messages = [...store.history(chatKey, cfg.HISTORY_LIMIT), userMsg];
  const instructions = buildInstructions(cfg, store, tools);

  const errors: string[] = [];
  for (const entry of chain) {
    try {
      const result = await generate({
        model: entry.model,
        instructions,
        messages,
        tools,
        stopWhen: stepCountIs(cfg.MAX_STEPS),
        maxRetries: 1,
      });
      // v7: `responseMessages` gom message của MỌI bước (assistant + tool).
      // `response.messages` đã deprecated và chỉ còn bước cuối.
      store.appendMessages(chatKey, [userMsg, ...(result.responseMessages as ModelMessage[])]);
      const text = result.text.trim() || "(Đã xử lý xong, không có gì thêm để nói.)";
      return { text, modelId: entry.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[agent] ${entry.id} lỗi: ${msg}`);
      errors.push(`${entry.id}: ${msg.slice(0, 200)}`);
    }
  }
  throw new Error("Tất cả model đều lỗi:\n" + errors.join("\n"));
}

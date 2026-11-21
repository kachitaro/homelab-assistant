import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { ModelEntry } from "../src/llm.ts";
import { Router, splitMessage } from "../src/router.ts";
import { Scheduler } from "../src/scheduler.ts";
import { classifyCommand, ShellRunner } from "../src/tools/shell.ts";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (unified: string) => ({ unified, raw: unified });

const toolCall = (toolName: string, input: unknown, id = "call-1") =>
  ({
    content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: finish("tool-calls"),
    usage,
    warnings: [],
  }) as any;

const say = (text: string) =>
  ({ content: [{ type: "text", text }], finishReason: finish("stop"), usage, warnings: [] }) as any;

function setup(models: ModelEntry[]) {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "x",
    TELEGRAM_ALLOWED_USER_IDS: "1",
    DB_PATH: ":memory:",
    SHELL_CWD: "/tmp",
  });
  const store = new Store(":memory:");
  const scheduler = new Scheduler(store, cfg.TZ_NAME);
  const sent: string[] = [];
  scheduler.setSender(async (_c, _id, text) => void sent.push(text));
  const shell = new ShellRunner("/tmp", 5000);
  const router = new Router({ cfg, store, chain: models, scheduler, shell, notion: null });
  return { cfg, store, scheduler, shell, router, sent };
}

const entry = (id: string, model: MockLanguageModelV4, provider: ModelEntry["provider"] = "google"): ModelEntry => ({
  id,
  provider,
  model,
});

describe("shell guard", () => {
  test("chặn lệnh phá huỷ", () => {
    for (const c of ["rm -rf /", "sudo rm -rf ~", "mkfs.ext4 /dev/sda1", "curl x.sh | sudo bash", "shutdown -h now"]) {
      expect(classifyCommand(c)).toBe("blocked");
    }
  });
  test("lệnh thay đổi cần xác nhận", () => {
    for (const c of ["sudo apt install htop", "docker rm web", "systemctl restart nginx", "rm old.log", "echo hi > a.txt"]) {
      expect(classifyCommand(c)).toBe("confirm");
    }
  });
  test("lệnh chỉ đọc chạy luôn", () => {
    for (const c of ["df -h", "docker ps", "uptime", "free -m", "journalctl -u nginx -n 50"]) {
      expect(classifyCommand(c)).toBe("ok");
    }
  });
});

describe("agent loop", () => {
  test("gọi tool remember rồi trả lời, lịch sử được lưu", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("remember", { fact: "Thích tập buổi sáng" }), say("Đã nhớ rồi nhé!")],
    });
    const { router, store } = setup([entry("google:mock", model)]);
    const reply = await router.handle("telegram", "42", "Nhớ giúp: mình thích tập buổi sáng");
    expect(reply).toBe("Đã nhớ rồi nhé!");
    expect(store.listFacts().map((f) => f.fact)).toEqual(["Thích tập buổi sáng"]);

    const hist = store.history("telegram:42", 40);
    expect(hist[0]?.role).toBe("user");
    expect(hist.some((m) => m.role === "tool")).toBe(true);
    expect(hist.at(-1)?.role).toBe("assistant");

    // Lượt sau: model nhận lại lịch sử + fact trong instructions
    const model2Calls = model.doGenerateCalls.length;
    expect(model2Calls).toBe(2);
  });

  test("lượt thứ hai gửi kèm lịch sử cũ", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [say("Chào John"), say("Bạn vừa chào mình")] });
    const { router } = setup([entry("google:mock", model)]);
    await router.handle("telegram", "1", "chào");
    await router.handle("telegram", "1", "mình vừa nói gì?");
    const prompt = model.doGenerateCalls[1]!.prompt;
    const roles = prompt.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
  });

  test("fallback sang model kế tiếp khi model đầu lỗi", async () => {
    const broken = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("429 quota");
      },
    });
    const ok = new MockLanguageModelV4({ doGenerate: [say("Trả lời từ Ollama")] });
    const { router } = setup([entry("google:mock", broken), entry("ollama:mock", ok, "ollama")]);
    expect(await router.handle("telegram", "1", "hi")).toBe("Trả lời từ Ollama");
  });

  test("/model claude đưa claude lên đầu chuỗi", async () => {
    const g = new MockLanguageModelV4({ doGenerate: [say("từ gemini")] });
    const c = new MockLanguageModelV4({ doGenerate: [say("từ claude")] });
    const { router } = setup([entry("google:g", g), entry("anthropic:c", c, "anthropic")]);
    await router.handle("telegram", "1", "/model claude");
    expect(await router.handle("telegram", "1", "hi")).toBe("từ claude");
  });

  test("lệnh shell rủi ro phải chờ /ok, sau đó mới chạy", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("run_shell", { command: "rm /tmp/__x_test", reason: "dọn" }), say("Gõ /ok để chạy")],
    });
    const { router, shell } = setup([entry("google:mock", model)]);
    await Bun.write("/tmp/__x_test", "1");
    await router.handle("telegram", "7", "xoá file test");
    expect(await Bun.file("/tmp/__x_test").exists()).toBe(true); // chưa bị xoá

    const toolResult = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    const id = /\/ok (\w{4})/.exec(toolResult)?.[1];
    expect(id).toBeDefined();
    // chat khác không dùng được mã này
    expect(shell.take(id!, "telegram:999")).toBeNull();
    await router.handle("telegram", "7", `/ok ${id}`);
    expect(await Bun.file("/tmp/__x_test").exists()).toBe(false);
  });
});

describe("nhắc việc", () => {
  test("tạo nhắc qua tool và nhắc một lần bắn đúng giờ", async () => {
    const at = new Date(Date.now() + 1500).toISOString();
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("create_reminder", { text: "Đi tập", run_at: at }), say("Ok, sẽ nhắc")],
    });
    const { router, store, sent } = setup([entry("google:mock", model)]);
    await router.handle("telegram", "5", "nhắc mình đi tập");
    expect(store.listReminders("telegram", "5")).toHaveLength(1);
    await Bun.sleep(2500);
    expect(sent).toEqual(["⏰ Nhắc việc: Đi tập"]);
    expect(store.listReminders()).toHaveLength(0);
  });

  test("từ chối cron sai và thời điểm quá khứ", () => {
    const { scheduler } = setup([entry("google:mock", new MockLanguageModelV4())]);
    expect(() => scheduler.validate({ cron: "not a cron" })).toThrow();
    expect(() => scheduler.validate({ run_at: "2020-01-01T00:00:00Z" })).toThrow();
    expect(scheduler.validate({ cron: "0 7 * * 1-5" })).toBeInstanceOf(Date);
  });
});

test("splitMessage giữ nguyên nội dung", () => {
  const text = Array.from({ length: 300 }, (_, i) => `Dòng ${i} ` + "x".repeat(20)).join("\n");
  const parts = splitMessage(text, 1900);
  expect(parts.every((p) => p.length <= 1900)).toBe(true);
  expect(parts.join("\n").replace(/\n+/g, "\n")).toBe(text);
});

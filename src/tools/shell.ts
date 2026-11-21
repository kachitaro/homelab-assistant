import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolContext } from "./types.ts";

/** Không bao giờ chạy, kể cả khi người dùng xác nhận. */
const BLOCKED: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i, // rm -rf / ~ /*
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  />\s*\/dev\/(sd|nvme|mmcblk)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /\b(shutdown|poweroff|halt)\b/i,
  /\bchmod\s+-R\s+0?777\s+\/(\s|$)/i,
  /\bchown\s+-R\s+\S+\s+\/(\s|$)/i,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, // curl ... | sh
  /\bwget\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
  /\bpasswd\b/i,
  /\/etc\/(shadow|sudoers)/i,
];

/** Chạy được, nhưng phải chờ người dùng gõ /ok <id>. */
const NEEDS_CONFIRM: RegExp[] = [
  /\bsudo\b/i,
  /\brm\b/i,
  /\bmv\b/i,
  /\breboot\b/i,
  /\bkill(all)?\b/i,
  /\bpkill\b/i,
  /\bsystemctl\s+(stop|restart|disable|mask|start|enable)\b/i,
  /\bdocker\s+(rm|rmi|stop|kill|system\s+prune|volume\s+rm|compose\s+down)\b/i,
  /\bapt(-get)?\s+(install|remove|purge|upgrade|autoremove)\b/i,
  /\bgit\s+(push|reset\s+--hard|clean)\b/i,
  /\bufw\b/i,
  /\bcrontab\s+-r\b/i,
  />\s*\S/, // ghi đè file bằng redirect
  /\btee\b/i,
];

export type Verdict = "blocked" | "confirm" | "ok";

export function classifyCommand(cmd: string): Verdict {
  if (BLOCKED.some((r) => r.test(cmd))) return "blocked";
  if (NEEDS_CONFIRM.some((r) => r.test(cmd))) return "confirm";
  return "ok";
}

export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 3500;

export class ShellRunner {
  private pending = new Map<string, { cmd: string; chatKey: string; expires: number }>();

  constructor(
    private cwd: string,
    private timeoutMs: number,
  ) {}

  async run(cmd: string): Promise<ShellResult> {
    const proc = Bun.spawn(["bash", "-lc", cmd], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, this.timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    let output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT / 2) + "\n…(cắt bớt)…\n" + output.slice(-MAX_OUTPUT / 2);
    }
    return { exitCode, output: output || "(không có output)", timedOut };
  }

  /** Lưu lệnh chờ xác nhận, trả về mã 4 ký tự. Hết hạn sau 10 phút. */
  queue(cmd: string, chatKey: string): string {
    const id = Math.random().toString(36).slice(2, 6);
    this.pending.set(id, { cmd, chatKey, expires: Date.now() + 10 * 60_000 });
    return id;
  }

  /** Lấy lệnh đang chờ (chỉ đúng chat đã tạo nó mới lấy được). */
  take(id: string, chatKey: string): string | null {
    const p = this.pending.get(id);
    if (!p || p.chatKey !== chatKey || p.expires < Date.now()) return null;
    this.pending.delete(id);
    return p.cmd;
  }

  cancel(id: string, chatKey: string): boolean {
    return this.take(id, chatKey) !== null;
  }
}

export function formatResult(cmd: string, r: ShellResult): string {
  const head = r.timedOut ? "⏱ Hết thời gian" : `exit ${r.exitCode}`;
  return `$ ${cmd}\n${head}\n${r.output}`;
}

export function shellTools(ctx: ToolContext): ToolSet {
  if (!ctx.cfg.SHELL_ENABLED) return {};
  const chatKey = `${ctx.channel}:${ctx.chatId}`;
  return {
    run_shell: tool({
      description:
        "Chạy một lệnh bash trên homelab (Ubuntu Server). Dùng để xem trạng thái máy, docker, log, disk, file. " +
        "Ưu tiên lệnh chỉ đọc. Lệnh nguy hiểm sẽ bị chặn; lệnh thay đổi hệ thống sẽ cần người dùng xác nhận bằng /ok <id>.",
      inputSchema: z.object({
        command: z.string().describe("Lệnh bash cần chạy"),
        reason: z.string().describe("Giải thích ngắn vì sao cần chạy lệnh này"),
      }),
      execute: async ({ command }) => {
        const verdict = classifyCommand(command);
        if (verdict === "blocked") {
          return { status: "blocked", message: "Lệnh này nằm trong danh sách cấm, không thể chạy qua bot." };
        }
        if (verdict === "confirm") {
          const id = ctx.shell.queue(command, chatKey);
          return {
            status: "pending_confirmation",
            id,
            message: `Lệnh cần xác nhận. Hãy báo người dùng gõ /ok ${id} để chạy hoặc /no ${id} để huỷ.`,
          };
        }
        const r = await ctx.shell.run(command);
        return { status: "done", exitCode: r.exitCode, timedOut: r.timedOut, output: r.output };
      },
    }),
  };
}

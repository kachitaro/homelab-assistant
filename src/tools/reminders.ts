import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./types.ts";

export function reminderTools(ctx: ToolContext) {
  const tz = ctx.cfg.TZ_NAME;
  const fmt = (d: Date | null) =>
    d ? d.toLocaleString("vi-VN", { timeZone: tz, dateStyle: "short", timeStyle: "short" }) : "—";

  return {
    create_reminder: tool({
      description:
        "Tạo nhắc việc. Một lần: truyền run_at (ISO 8601 có offset, vd 2026-11-22T07:00:00+07:00). " +
        "Lặp lại: truyền cron 5 trường theo giờ địa phương (vd '0 7 * * 1-5' = 7h sáng thứ 2–6).",
      inputSchema: z.object({
        text: z.string().describe("Nội dung nhắc"),
        run_at: z.string().optional().describe("Thời điểm nhắc một lần, ISO 8601"),
        cron: z.string().optional().describe("Cron 5 trường cho nhắc lặp lại"),
      }),
      execute: async ({ text, run_at, cron }) => {
        try {
          const next = ctx.scheduler.validate({ run_at, cron });
          const r = ctx.store.addReminder({
            channel: ctx.channel,
            chat_id: ctx.chatId,
            text,
            run_at: cron ? null : (run_at ?? null),
            cron: cron ?? null,
          });
          ctx.scheduler.schedule(r);
          return { ok: true, id: r.id, next_run: fmt(next), repeating: Boolean(cron) };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
    }),

    list_reminders: tool({
      description: "Liệt kê các nhắc việc của cuộc trò chuyện này.",
      inputSchema: z.object({}),
      execute: async () =>
        ctx.store.listReminders(ctx.channel, ctx.chatId).map((r) => ({
          id: r.id,
          text: r.text,
          cron: r.cron,
          next_run: fmt(ctx.scheduler.nextRun(r.id)),
        })),
    }),

    delete_reminder: tool({
      description: "Xoá một nhắc việc theo id.",
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        const r = ctx.store.getReminder(id);
        if (!r || r.channel !== ctx.channel || r.chat_id !== ctx.chatId) {
          return { ok: false, error: "Không tìm thấy nhắc việc này." };
        }
        ctx.scheduler.unschedule(id);
        ctx.store.deleteReminder(id);
        return { ok: true };
      },
    }),
  };
}

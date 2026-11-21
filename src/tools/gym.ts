import { tool } from "ai";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMarkdownPage } from "./notion.ts";
import type { ToolContext } from "./types.ts";

const GYM_PROFILE_KEY = "gym:profile";

export const gymProfileSchema = z.object({
  goal: z.string().describe("Mục tiêu: tăng cơ, giảm mỡ, tăng sức mạnh, sức bền..."),
  level: z.enum(["mới tập", "trung bình", "lâu năm"]),
  days_per_week: z.number().int().min(1).max(7),
  session_minutes: z.number().int().min(15).max(180),
  equipment: z.string().describe("Phòng gym đầy đủ / tạ đơn ở nhà / chỉ bodyweight..."),
  injuries: z.string().describe("Chấn thương hoặc vùng cần tránh; 'không' nếu không có"),
  notes: z.string().optional().describe("Bài thích/ghét, lịch bận, chiều cao cân nặng nếu người dùng muốn chia sẻ"),
});

export type GymProfile = z.infer<typeof gymProfileSchema>;

export const GYM_GUIDE = `
Khi soạn giáo án gym:
- Nếu chưa có hồ sơ (gym_get_profile trả về null), hỏi gọn các mục còn thiếu rồi lưu bằng gym_save_profile trước khi soạn.
- Luôn hỏi về chấn thương. Có chấn thương hoặc đau bất thường thì tránh bài gây tải lên vùng đó và khuyên hỏi bác sĩ/chuyên viên vật lý trị liệu.
- Chọn kiểu chia buổi theo số buổi/tuần: 2–3 buổi → full body; 4 buổi → upper/lower; 5–6 buổi → push/pull/legs.
- Mỗi buổi: khởi động 5–10 phút, bài compound trước, isolation sau, giãn cơ cuối buổi.
- Ghi rõ từng bài: số set × rep, RPE hoặc %1RM gợi ý, thời gian nghỉ, kèm bài thay thế nếu thiếu dụng cụ.
- Có kế hoạch progressive overload 4–6 tuần và một tuần deload.
- Trình bày bằng markdown, bảng theo từng ngày. Hỏi người dùng có muốn lưu (gym_save_plan) và đặt nhắc lịch tập không.
`.trim();

export function gymTools(ctx: ToolContext) {
  return {
    gym_get_profile: tool({
      description: "Lấy hồ sơ tập luyện đã lưu của người dùng (mục tiêu, trình độ, lịch, dụng cụ, chấn thương).",
      inputSchema: z.object({}),
      execute: async () => ctx.store.getKV<GymProfile>(GYM_PROFILE_KEY),
    }),

    gym_save_profile: tool({
      description: "Lưu hoặc cập nhật hồ sơ tập luyện của người dùng.",
      inputSchema: gymProfileSchema,
      execute: async (profile) => {
        ctx.store.setKV(GYM_PROFILE_KEY, profile);
        return { ok: true };
      },
    }),

    gym_save_plan: tool({
      description:
        "Lưu giáo án tập đã soạn. Có Notion thì tạo trang dưới trang Gym, không thì lưu file markdown trên server.",
      inputSchema: z.object({
        title: z.string().describe("vd 'Giáo án Upper/Lower – 6 tuần (11/2026)'"),
        markdown: z.string(),
      }),
      execute: async ({ title, markdown }) => {
        const parent = ctx.cfg.NOTION_GYM_PARENT_PAGE_ID;
        if (ctx.notion && parent) {
          const page = await createMarkdownPage(ctx.notion, parent, title, markdown);
          return { ok: true, saved_to: "notion", ...page };
        }
        const safe = title.replace(/[^\p{L}\p{N}\- ]/gu, "").trim().replace(/\s+/g, "-") || "giao-an";
        const path = join(dirname(ctx.cfg.DB_PATH), "gym-plans", `${Date.now()}-${safe}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `# ${title}\n\n${markdown}\n`);
        return { ok: true, saved_to: "file", path };
      },
    }),
  };
}

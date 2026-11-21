import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Client } from "@notionhq/client";
import type { ToolContext } from "./types.ts";

/** Lấy tiêu đề từ object page/data source trả về bởi search. */
function titleOf(obj: any): string {
  if (Array.isArray(obj?.title)) return obj.title.map((t: any) => t.plain_text).join("") || "(không tên)";
  const props = obj?.properties ?? {};
  for (const p of Object.values<any>(props)) {
    if (p?.type === "title") return p.title.map((t: any) => t.plain_text).join("") || "(không tên)";
  }
  return "(không tên)";
}

export async function createMarkdownPage(
  notion: Client,
  parentPageId: string,
  title: string,
  markdown: string,
) {
  const page: any = await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ text: { content: title } }] } },
    markdown,
  });
  return { id: page.id as string, url: (page.url as string) ?? null };
}

export function notionTools(ctx: ToolContext): ToolSet {
  const notion = ctx.notion;
  if (!notion) return {};

  return {
    notion_search: tool({
      description:
        "Tìm trang hoặc database trong Notion của người dùng theo từ khoá (Resources, Projects, ghi chú...). " +
        "Chỉ thấy những trang đã được share cho integration.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const res: any = await notion.search({ query, page_size: 8 });
        return res.results.map((r: any) => ({
          id: r.id,
          type: r.object,
          title: titleOf(r),
          url: r.url ?? null,
          last_edited: r.last_edited_time ?? null,
        }));
      },
    }),

    notion_read_page: tool({
      description: "Đọc nội dung một trang Notion dưới dạng markdown, theo id lấy từ notion_search.",
      inputSchema: z.object({ page_id: z.string() }),
      execute: async ({ page_id }) => {
        const res = await notion.pages.retrieveMarkdown({ page_id });
        const md = res.markdown.length > 12_000 ? res.markdown.slice(0, 12_000) + "\n…(cắt bớt)" : res.markdown;
        return { markdown: md, truncated: res.truncated || res.markdown.length > 12_000 };
      },
    }),

    notion_create_note: tool({
      description:
        "Tạo trang ghi chú mới trong Notion (mặc định dưới trang Inbox đã cấu hình). " +
        "Dùng khi người dùng bảo 'lưu vào Notion', 'ghi lại'.",
      inputSchema: z.object({
        title: z.string(),
        markdown: z.string().describe("Nội dung markdown"),
        parent_page_id: z.string().optional().describe("Bỏ trống để dùng trang Inbox mặc định"),
      }),
      execute: async ({ title, markdown, parent_page_id }) => {
        const parent = parent_page_id ?? ctx.cfg.NOTION_INBOX_PARENT_PAGE_ID;
        if (!parent) return { ok: false, error: "Chưa cấu hình NOTION_INBOX_PARENT_PAGE_ID." };
        return { ok: true, ...(await createMarkdownPage(notion, parent, title, markdown)) };
      },
    }),
  };
}

import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./types.ts";

export function memoryTools(ctx: ToolContext) {
  return {
    remember: tool({
      description:
        "Ghi nhớ lâu dài một thông tin bền vững về người dùng (sở thích, dự án, quy ước). " +
        "Chỉ dùng khi người dùng nói rõ hoặc thông tin chắc chắn sẽ còn hữu ích về sau. Không lưu mật khẩu/token.",
      inputSchema: z.object({ fact: z.string() }),
      execute: async ({ fact }) => ({ ok: true, id: ctx.store.addFact(fact) }),
    }),
    forget: tool({
      description: "Xoá một thông tin đã ghi nhớ theo id (xem id trong phần 'Điều đã biết' của system prompt).",
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => ({ ok: ctx.store.deleteFact(id) }),
    }),
  };
}

import type { ToolSet } from "ai";
import { gymTools } from "./gym.ts";
import { memoryTools } from "./memory.ts";
import { notionTools } from "./notion.ts";
import { reminderTools } from "./reminders.ts";
import { shellTools } from "./shell.ts";
import type { ToolContext } from "./types.ts";

export function buildTools(ctx: ToolContext): ToolSet {
  return {
    ...memoryTools(ctx),
    ...reminderTools(ctx),
    ...notionTools(ctx),
    ...shellTools(ctx),
    ...gymTools(ctx),
  };
}

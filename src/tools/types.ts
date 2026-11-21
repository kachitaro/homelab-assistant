import type { Client as NotionClient } from "@notionhq/client";
import type { Config } from "../config.ts";
import type { ChannelName, Store } from "../db.ts";
import type { Scheduler } from "../scheduler.ts";
import type { ShellRunner } from "./shell.ts";

/** Ngữ cảnh truyền vào mọi tool cho một lượt chat. */
export interface ToolContext {
  cfg: Config;
  store: Store;
  scheduler: Scheduler;
  shell: ShellRunner;
  notion: NotionClient | null;
  channel: ChannelName;
  chatId: string;
}

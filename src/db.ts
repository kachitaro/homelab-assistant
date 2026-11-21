import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelMessage } from "ai";

export type ChannelName = "telegram" | "discord";

export interface Reminder {
  id: number;
  channel: ChannelName;
  chat_id: string;
  text: string;
  /** ISO datetime cho nhắc một lần */
  run_at: string | null;
  /** cron 5 trường cho nhắc lặp lại */
  cron: string | null;
  created_at: string;
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_key, id);

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        run_at TEXT,
        cron TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ---------- Lịch sử hội thoại ----------

  appendMessages(chatKey: string, messages: ModelMessage[]) {
    const stmt = this.db.prepare("INSERT INTO messages (chat_key, message) VALUES (?, ?)");
    const tx = this.db.transaction((msgs: ModelMessage[]) => {
      for (const m of msgs) stmt.run(chatKey, JSON.stringify(m));
    });
    tx(messages);
  }

  /**
   * Lấy tối đa `limit` message gần nhất, rồi cắt phần đầu cho tới khi
   * gặp message `user` — tránh mở đầu bằng tool-result mồ côi.
   */
  history(chatKey: string, limit: number): ModelMessage[] {
    const rows = this.db
      .prepare("SELECT message FROM messages WHERE chat_key = ? ORDER BY id DESC LIMIT ?")
      .all(chatKey, limit) as { message: string }[];
    const msgs = rows.reverse().map((r) => JSON.parse(r.message) as ModelMessage);
    const firstUser = msgs.findIndex((m) => m.role === "user");
    return firstUser === -1 ? [] : msgs.slice(firstUser);
  }

  clearHistory(chatKey: string) {
    this.db.prepare("DELETE FROM messages WHERE chat_key = ?").run(chatKey);
  }

  // ---------- Trí nhớ dài hạn ----------

  addFact(fact: string): number {
    const r = this.db.prepare("INSERT INTO facts (fact) VALUES (?)").run(fact);
    return Number(r.lastInsertRowid);
  }

  listFacts(): { id: number; fact: string }[] {
    return this.db.prepare("SELECT id, fact FROM facts ORDER BY id").all() as {
      id: number;
      fact: string;
    }[];
  }

  deleteFact(id: number): boolean {
    return this.db.prepare("DELETE FROM facts WHERE id = ?").run(id).changes > 0;
  }

  // ---------- Nhắc việc ----------

  addReminder(r: Omit<Reminder, "id" | "created_at">): Reminder {
    const res = this.db
      .prepare("INSERT INTO reminders (channel, chat_id, text, run_at, cron) VALUES (?, ?, ?, ?, ?)")
      .run(r.channel, r.chat_id, r.text, r.run_at, r.cron);
    return this.getReminder(Number(res.lastInsertRowid))!;
  }

  getReminder(id: number): Reminder | null {
    return (this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Reminder) ?? null;
  }

  listReminders(channel?: ChannelName, chatId?: string): Reminder[] {
    if (channel && chatId) {
      return this.db
        .prepare("SELECT * FROM reminders WHERE channel = ? AND chat_id = ? ORDER BY id")
        .all(channel, chatId) as Reminder[];
    }
    return this.db.prepare("SELECT * FROM reminders ORDER BY id").all() as Reminder[];
  }

  deleteReminder(id: number): boolean {
    return this.db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes > 0;
  }

  // ---------- KV (hồ sơ gym, model đang chọn...) ----------

  getKV<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setKV(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
}

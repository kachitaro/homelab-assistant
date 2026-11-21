import { Cron } from "croner";
import type { ChannelName, Reminder, Store } from "./db.ts";

export type SendFn = (channel: ChannelName, chatId: string, text: string) => Promise<void>;

/** Giữ các job croner trong RAM, đồng bộ với bảng reminders trong SQLite. */
export class Scheduler {
  private jobs = new Map<number, Cron>();
  private send: SendFn = async () => {};

  constructor(
    private store: Store,
    private timezone: string,
  ) {}

  setSender(fn: SendFn) {
    this.send = fn;
  }

  /** Nạp lại toàn bộ nhắc việc khi khởi động. */
  loadAll() {
    for (const r of this.store.listReminders()) this.schedule(r);
  }

  /** Kiểm tra cron/thời điểm hợp lệ trước khi lưu. Trả về lần chạy kế tiếp. */
  validate(input: { run_at?: string | null; cron?: string | null }): Date {
    if (input.cron) {
      const probe = new Cron(input.cron, { timezone: this.timezone, paused: true });
      const next = probe.nextRun();
      probe.stop();
      if (!next) throw new Error("Biểu thức cron không có lần chạy nào trong tương lai.");
      return next;
    }
    if (input.run_at) {
      const d = new Date(input.run_at);
      if (Number.isNaN(d.getTime())) throw new Error("run_at không phải ISO datetime hợp lệ.");
      if (d.getTime() <= Date.now()) throw new Error("run_at đang ở quá khứ.");
      return d;
    }
    throw new Error("Cần run_at hoặc cron.");
  }

  schedule(r: Reminder) {
    this.unschedule(r.id);
    const fire = async () => {
      try {
        await this.send(r.channel, r.chat_id, `⏰ Nhắc việc: ${r.text}`);
      } catch (err) {
        console.error(`[scheduler] Gửi nhắc #${r.id} thất bại`, err);
      }
      if (!r.cron) {
        this.store.deleteReminder(r.id);
        this.jobs.delete(r.id);
      }
    };

    if (r.cron) {
      this.jobs.set(r.id, new Cron(r.cron, { timezone: this.timezone }, fire));
    } else if (r.run_at) {
      const at = new Date(r.run_at);
      if (at.getTime() <= Date.now()) {
        // Bỏ lỡ trong lúc bot tắt → gửi bù ngay.
        void fire();
        return;
      }
      this.jobs.set(r.id, new Cron(at, { timezone: this.timezone }, fire));
    }
  }

  unschedule(id: number) {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  nextRun(id: number): Date | null {
    return this.jobs.get(id)?.nextRun() ?? null;
  }

  stopAll() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }
}

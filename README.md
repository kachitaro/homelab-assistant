# Homelab Assistant

Trợ lí AI cá nhân chạy 24/7 trên homelab, chat qua **Telegram** và **Discord**.

- **Nhiều model, tự fallback:** Gemini → Claude → Ollama (thứ tự tuỳ `MODEL_CHAIN`), đổi nhanh bằng `/model`
- **Nhớ hội thoại** theo từng chat (SQLite) + **trí nhớ dài hạn** (`remember` / `forget`)
- **Nhắc việc** một lần hoặc lặp lại (cron, giờ Việt Nam). Nhắc bị lỡ khi bot tắt sẽ được gửi bù.
- **Notion:** tìm, đọc trang (markdown), tạo ghi chú
- **Thao tác server:** chạy lệnh bash, có guard 3 mức (cấm / cần `/ok` / chạy luôn)
- **Giáo án gym:** lưu hồ sơ tập, soạn giáo án theo số buổi/tuần, lưu vào Notion hoặc file

Stack: Bun + TypeScript, [AI SDK v7](https://ai-sdk.dev), grammY, discord.js, @notionhq/client v5, croner.

---

## Kiến trúc

```
Telegram ─┐                         ┌─ memory   (remember/forget)
          ├─► Router ─► Agent ─► Tools ─ reminders (croner + SQLite)
Discord ──┘   (/lệnh,    (fallback   ├─ notion
              hàng đợi    model)     ├─ run_shell (guard)
              theo chat)             └─ gym
                    │
                 SQLite: messages · facts · reminders · kv
```

- Cả hai kênh đều **kết nối ra ngoài** (Telegram long polling, Discord gateway), nên **không cần mở port** hay route qua Cloudflare Tunnel.
- Mỗi chat được xử lý tuần tự để lịch sử không bị chen ngang.
- `src/router.ts` xử lý lệnh `/…` trực tiếp, không qua model. Riêng `/ok` chạy lệnh mà **không qua LLM**, nên model không thể tự xác nhận thay bạn.

## Cài trên homelab (Ubuntu Server)

### 1. Cài Bun và lấy code

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL
sudo mkdir -p /opt/homelab-assistant && sudo chown $USER: /opt/homelab-assistant
# copy thư mục project vào /opt/homelab-assistant (scp/rsync/git)
cd /opt/homelab-assistant
bun install --production
```

### 2. Tạo bot và lấy key

| Thứ cần lấy | Ở đâu |
|---|---|
| Telegram token | Nhắn `@BotFather` → `/newbot` |
| Telegram user ID của bạn | Nhắn `@userinfobot` |
| Discord token | developers.discord.com/applications → New Application → **Bot** → Reset Token. **Bật Message Content Intent.** |
| Mời bot Discord vào server | Tab **OAuth2 → URL Generator**: scope `bot`, quyền *Send Messages*, *Read Message History* |
| Discord user ID | Settings → Advanced → Developer Mode → chuột phải tên mình → Copy User ID |
| Gemini API key | aistudio.google.com/apikey |
| Claude API key (tuỳ chọn) | console.anthropic.com |
| Notion token | notion.so/profile/integrations → New integration. Sau đó **share từng trang** cho integration (••• → Connections). |

> Gói **Google AI Pro không cộng quota cho Gemini API**. Chưa bật billing thì API key dùng free tier (rate limit chặt, thường đủ cho một người dùng). Khi Gemini báo 429, bot tự chuyển sang model kế tiếp trong chuỗi.

### 3. Cấu hình

```bash
cp .env.example .env
nano .env        # điền token, ID, key
chmod 600 .env
```

### 4. (Tuỳ chọn) Ollama làm dự phòng offline

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:3b
```

Với i5-4210U + 8GB RAM và không có GPU, model 3B chạy được nhưng **chậm** (vài token/giây), và gọi tool kém chính xác hơn model cloud. Nên để Ollama ở **cuối** chuỗi, chỉ dùng khi mất mạng hoặc hết quota.

### 5. Chạy thử, rồi bật systemd

```bash
bun run start               # nhắn thử /help cho bot, Ctrl+C để dừng

# sửa User= và đường dẫn bun trong file service cho khớp máy bạn
sudo cp deploy/homelab-assistant.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now homelab-assistant
journalctl -u homelab-assistant -f    # xem log
```

`Restart=always` giúp bot tự dậy khi crash, và `enable` giúp bot tự chạy lại sau khi laptop reboot.

## Cách dùng

| Bạn nhắn | Bot làm |
|---|---|
| `nhắc mình 6h30 sáng mai đi tập` | `create_reminder` một lần |
| `mỗi thứ 2–6 lúc 7h nhắc mình uống nước` | cron `0 7 * * 1-5` |
| `server còn bao nhiêu disk? docker nào đang chạy?` | `df -h`, `docker ps` (chạy luôn) |
| `restart container web` | trả về mã, bạn gõ `/ok ab12` mới chạy |
| `tìm trong Notion ghi chú về Docker` | `notion_search` → `notion_read_page` |
| `soạn giáo án gym 4 buổi/tuần, tập ở phòng gym` | hỏi hồ sơ còn thiếu → soạn → hỏi có lưu/đặt nhắc không |
| `nhớ là mình dùng Bun, không dùng npm` | `remember` |

Lệnh: `/help` · `/reset` · `/model gemini|claude|ollama|default` · `/reminders` · `/ok <id>` · `/no <id>`

Trên Discord: nhắn riêng (DM) cho bot, hoặc `@bot` trong kênh.

## Bảo mật

- Bot **chỉ trả lời user ID trong whitelist**. Thiếu whitelist thì bot từ chối khởi động.
- `run_shell` chạy bằng **user của service**, không phải root. File service đặt `NoNewPrivileges=true` nên `sudo` sẽ **không chạy được** qua bot. Đây là cố ý. Muốn cho phép thì bỏ dòng đó và cân nhắc kỹ.
- Guard trong `src/tools/shell.ts`:
  - **Cấm hẳn:** `rm -rf /`, `mkfs`, `dd of=/dev/…`, `shutdown`, `curl … | sh`, `passwd`, đụng `/etc/shadow`…
  - **Cần `/ok`:** `sudo`, `rm`, `mv`, `kill`, `systemctl start/stop/restart`, `docker rm/stop/compose down`, `apt install`, `git push`, ghi file bằng `>`…
  - Mã xác nhận chỉ dùng được trong đúng chat đã tạo nó, và hết hạn sau 10 phút.
- Guard dựa trên regex nên **không phải sandbox**. Đừng whitelist ai khác ngoài bạn.
- Lịch sử chat nằm trong `data/assistant.db`. Model cloud (Gemini/Claude) sẽ nhận nội dung bạn nhắn và output của lệnh.

## Phát triển

```bash
bun run dev         # chạy, tự reload khi sửa code
bun test            # 11 test: guard, vòng agent + tool, fallback, /model, /ok, nhắc việc
bun run typecheck
```

Thêm tool mới: tạo `src/tools/<tên>.ts` trả về `ToolSet` (dùng `tool({ description, inputSchema, execute })`), rồi gộp vào `src/tools/index.ts`.

**Lưu ý AI SDK v7:** lấy message của mọi bước bằng `result.responseMessages`. Field `result.response.messages` đã deprecated và chỉ còn bước cuối, dùng nó sẽ làm mất tool call khỏi lịch sử.

## Hướng mở rộng

- **Web dashboard** xem lịch sử, nhắc việc, trí nhớ: dựng API bằng IGNIS, admin bằng ARDOR, public qua Cloudflare Tunnel + Access sẵn có.
- **Tóm tắt buổi sáng** (cron gọi agent thay vì gửi text cố định).
- **Voice message** trên Telegram → speech-to-text → agent.
- Ghi log buổi tập vào Notion/Supabase của app gym.

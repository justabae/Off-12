// Offline Before Midnight 🌙 早睡打卡 LINE Bot
// 晚安打卡 + 早晨回卡驗證、寢具升級系統、23:00 起每小時點名、遲睡累進警告、週報

import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import cron from "node-cron";
import Database from "better-sqlite3";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);
const db = new Database("sleep.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    name TEXT,
    group_id TEXT,
    late_level INTEGER DEFAULT 0   -- 連續遲睡等級,越高警告越兇
  );
  CREATE TABLE IF NOT EXISTS checkins (
    user_id TEXT,
    sleep_date TEXT,
    night_time TEXT,
    before_midnight INTEGER,
    morning_confirmed INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, sleep_date)
  );
`);

// ── 工具 ──
const TZ = "Asia/Taipei";
const nowTW = () => new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
function sleepDateOf(d) {
  const t = new Date(d);
  if (t.getHours() < 4) t.setDate(t.getDate() - 1);
  return t.toISOString().slice(0, 10);
}
const fmtTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function streakOf(userId) {
  const rows = db
    .prepare("SELECT sleep_date, before_midnight FROM checkins WHERE user_id=? AND morning_confirmed=1")
    .all(userId);
  const byDate = Object.fromEntries(rows.map((r) => [r.sleep_date, r.before_midnight]));
  let streak = 0;
  const cur = nowTW();
  if (cur.getHours() < 4) cur.setDate(cur.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const d = new Date(cur);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (byDate[key] === 1) streak++;
    else if (i === 0) continue;
    else break;
  }
  return streak;
}

// ── 寢具升級系統:連續天數解鎖更好的睡眠裝備 ──
const GEAR = [
  [0,  "🛏️ 地板睡袋"],
  [3,  "🛌 單人床墊"],
  [7,  "🧸 加一顆記憶枕"],
  [14, "🪶 羽絨棉被"],
  [21, "🎐 遮光窗簾"],
  [30, "👑 雙人獨立筒名床"],
  [45, "🌫️ 香氛加濕器"],
  [60, "🏨 五星級總統套房"],
];
function gearOf(streak) {
  let g = GEAR[0][1];
  for (const [days, label] of GEAR) if (streak >= days) g = label;
  return g;
}
function nextGear(streak) {
  for (const [days, label] of GEAR) if (streak < days) return `再 ${days - streak} 天解鎖 ${label}`;
  return "已收集全部寢具!";
}

// ── 遲睡累進警告 ──
function lateWarning(name, level) {
  const msgs = [
    `🥱 ${name} 超過午夜才睡,今晚不算連續。明天早點休息!`,
    `⚠️ ${name} 連續 2 天遲睡了,身體在抗議囉`,
    `🚨 ${name} 連續 3 天遲睡!寢具升級進度歸零,大家幫忙盯一下`,
    `🔴 ${name} 已連續 ${level} 天遲睡,長期睡眠不足會影響專注力和免疫力,認真考慮調整作息!`,
  ];
  return msgs[Math.min(level - 1, 3)];
}

// ── Webhook ──
const app = express();
app.post("/webhook", middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message.type !== "text") return;
  const text = ev.message.text.trim();
  const userId = ev.source.userId;
  const groupId = ev.source.groupId || null;
  const now = nowTW();
  const sd = sleepDateOf(now);

  const profile = await client.getProfile(userId).catch(() => ({ displayName: "夥伴" }));
  db.prepare(
    "INSERT INTO users (user_id,name,group_id) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=?, group_id=COALESCE(?,group_id)"
  ).run(userId, profile.displayName, groupId, profile.displayName, groupId);

  // 晚安打卡
  if (/^(晚安|睡覺|打卡|我要睡了)/.test(text)) {
    const before = now.getHours() >= 18 ? 1 : 0;
    db.prepare(
      "INSERT OR REPLACE INTO checkins (user_id, sleep_date, night_time, before_midnight) VALUES (?,?,?,?)"
    ).run(userId, sd, now.toISOString(), before);

    if (before) {
      db.prepare("UPDATE users SET late_level=0 WHERE user_id=?").run(userId);
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `😴 ${profile.displayName} 在 ${fmtTime(now)} 下線!明早回「起床」完成驗證`,
      });
    } else {
      const u = db.prepare("SELECT late_level FROM users WHERE user_id=?").get(userId);
      const level = (u?.late_level || 0) + 1;
      db.prepare("UPDATE users SET late_level=? WHERE user_id=?").run(level, userId);
      return client.replyMessage(ev.replyToken, { type: "text", text: lateWarning(profile.displayName, level) });
    }
  }

  // 早晨回卡
  if (/^(起床|早安|醒了)/.test(text)) {
    const yesterday = sleepDateOf(new Date(now.getTime() - 12 * 3600 * 1000));
    const row = db
      .prepare("SELECT * FROM checkins WHERE user_id=? AND sleep_date=? AND before_midnight=1")
      .get(userId, yesterday);
    if (!row)
      return client.replyMessage(ev.replyToken, { type: "text", text: "☀️ 早安!昨晚沒有午夜前的打卡紀錄喔" });
    db.prepare("UPDATE checkins SET morning_confirmed=1 WHERE user_id=? AND sleep_date=?").run(userId, yesterday);
    const s = streakOf(userId);
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: `☀️ 驗證完成!連續早睡 ${s} 天\n目前寢具:${gearOf(s)}\n${nextGear(s)}`,
    });
  }

  // 排行
  if (/^(排行|排行榜|寢具|裝備)/.test(text)) {
    const users = db.prepare("SELECT * FROM users").all();
    const board = users
      .map((u) => ({ name: u.name, streak: streakOf(u.user_id) }))
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 10);
    const lines = board.map(
      (u, i) => `${["🌕", "🌖", "🌗"][i] || `${i + 1}.`} ${u.name} 🔥${u.streak}天 ${gearOf(u.streak)}`
    );
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: lines.length ? `🌙 Offline Before Midnight 排行\n${lines.join("\n")}` : "還沒有紀錄,今晚開始!",
    });
  }
}

// ── 23:00 / 23:30 / 23:50 點名尚未打卡的人(群組推播,一則搞定)──
async function rollCall(label) {
  const sd = sleepDateOf(nowTW());
  const groups = db.prepare("SELECT DISTINCT group_id FROM users WHERE group_id IS NOT NULL").all();
  for (const g of groups) {
    const users = db.prepare("SELECT * FROM users WHERE group_id=?").all(g.group_id);
    const missing = users.filter(
      (u) => !db.prepare("SELECT 1 FROM checkins WHERE user_id=? AND sleep_date=?").get(u.user_id, sd)
    );
    if (!missing.length) continue;
    await client.pushMessage(g.group_id, {
      type: "text",
      text: `${label}\n尚未下線:${missing.map((u) => u.name).join("、")}\n回「晚安」打卡!`,
    }).catch(() => {});
  }
}
cron.schedule("0 23 * * *",  () => rollCall("🌙 23:00,距離午夜還有 1 小時"), { timezone: TZ });
cron.schedule("30 23 * * *", () => rollCall("⏰ 23:30,最後 30 分鐘!"), { timezone: TZ });
cron.schedule("50 23 * * *", () => rollCall("🚨 23:50,最後 10 分鐘,快躺平!"), { timezone: TZ });

// ── 每週日 21:00 週報 ──
cron.schedule("0 21 * * 0", async () => {
  const groups = db.prepare("SELECT DISTINCT group_id FROM users WHERE group_id IS NOT NULL").all();
  const weekAgo = new Date(nowTW().getTime() - 7 * 86400 * 1000).toISOString().slice(0, 10);
  for (const g of groups) {
    const users = db.prepare("SELECT * FROM users WHERE group_id=?").all(g.group_id);
    const lines = users.map((u) => {
      const n = db
        .prepare("SELECT COUNT(*) c FROM checkins WHERE user_id=? AND sleep_date>=? AND morning_confirmed=1 AND before_midnight=1")
        .get(u.user_id, weekAgo).c;
      return `${u.name}:${n}/7 天`;
    });
    await client.pushMessage(g.group_id, {
      type: "text",
      text: `📊 本週 Offline Before Midnight 週報\n${lines.join("\n")}`,
    }).catch(() => {});
  }
}, { timezone: TZ });

app.listen(process.env.PORT || 3000, () => console.log("🌙 OBM Bot 啟動"));

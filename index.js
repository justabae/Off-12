// Offline Before Midnight 🌙 早睡打卡 LINE Bot(JSON 儲存版,無需編譯原生模組)

import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import cron from "node-cron";
import fs from "fs";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ── JSON 檔案儲存 ──
const DB_PATH = process.env.DB_PATH || "./data.json";
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return { users: {}, checkins: {} }; }
}
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(DB)); }
let DB = loadDB();
// users:    { userId: { name, groupId, lateLevel } }
// checkins: { "userId|sleepDate": { nightTime, beforeMidnight, morningConfirmed } }

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
  const byDate = {};
  for (const [key, c] of Object.entries(DB.checkins)) {
    const [uid, date] = key.split("|");
    if (uid === userId && c.morningConfirmed) byDate[date] = c.beforeMidnight;
  }
  let streak = 0;
  const cur = nowTW();
  if (cur.getHours() < 4) cur.setDate(cur.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const d = new Date(cur);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (byDate[key] === true) streak++;
    else if (i === 0) continue;
    else break;
  }
  return streak;
}

// ── 寢具升級系統 ──
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

// 健康檢查,方便瀏覽器直接打開網址確認伺服器活著
app.get("/", (req, res) => res.send("🌙 OBM Bot is running"));

app.post("/webhook", middleware(config), async (req, res) => {
  res.sendStatus(200); // 先回 200,避免處理過久讓 LINE 判定失敗
  for (const ev of req.body.events) {
    try { await handleEvent(ev); } catch (e) { console.error(e); }
  }
});

async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message.type !== "text") return;
  const text = ev.message.text.trim();
  const userId = ev.source.userId;
  const groupId = ev.source.groupId || null;
  const now = nowTW();
  const sd = sleepDateOf(now);
  const ck = `${userId}|${sd}`;

  const profile = await client.getProfile(userId).catch(() => ({ displayName: "夥伴" }));
  DB.users[userId] = {
    name: profile.displayName,
    groupId: groupId || DB.users[userId]?.groupId || null,
    lateLevel: DB.users[userId]?.lateLevel || 0,
  };
  saveDB();

  // 晚安打卡
  if (/^(晚安|睡覺|打卡|我要睡了)/.test(text)) {
    const before = now.getHours() >= 18;
    DB.checkins[ck] = { nightTime: now.toISOString(), beforeMidnight: before, morningConfirmed: false };
    if (before) {
      DB.users[userId].lateLevel = 0;
      saveDB();
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `😴 ${profile.displayName} 在 ${fmtTime(now)} 下線!明早回「起床」完成驗證`,
      });
    } else {
      DB.users[userId].lateLevel += 1;
      saveDB();
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: lateWarning(profile.displayName, DB.users[userId].lateLevel),
      });
    }
  }

  // 早晨回卡
  if (/^(起床|早安|醒了)/.test(text)) {
    const yesterday = sleepDateOf(new Date(now.getTime() - 12 * 3600 * 1000));
    const yk = `${userId}|${yesterday}`;
    const row = DB.checkins[yk];
    if (!row || !row.beforeMidnight)
      return client.replyMessage(ev.replyToken, { type: "text", text: "☀️ 早安!昨晚沒有午夜前的打卡紀錄喔" });
    row.morningConfirmed = true;
    saveDB();
    const s = streakOf(userId);
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: `☀️ 驗證完成!連續早睡 ${s} 天\n目前寢具:${gearOf(s)}\n${nextGear(s)}`,
    });
  }

  // 排行
  if (/^(排行|排行榜|寢具|裝備)/.test(text)) {
    const board = Object.entries(DB.users)
      .map(([uid, u]) => ({ name: u.name, streak: streakOf(uid) }))
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

// ── 23:00 / 23:30 / 23:50 點名 ──
async function rollCall(label) {
  const sd = sleepDateOf(nowTW());
  const groups = [...new Set(Object.values(DB.users).map((u) => u.groupId).filter(Boolean))];
  for (const gid of groups) {
    const missing = Object.entries(DB.users)
      .filter(([uid, u]) => u.groupId === gid && !DB.checkins[`${uid}|${sd}`])
      .map(([, u]) => u.name);
    if (!missing.length) continue;
    await client.pushMessage(gid, {
      type: "text",
      text: `${label}\n尚未下線:${missing.join("、")}\n回「晚安」打卡!`,
    }).catch(() => {});
  }
}
cron.schedule("0 23 * * *",  () => rollCall("🌙 23:00,距離午夜還有 1 小時"), { timezone: TZ });
cron.schedule("30 23 * * *", () => rollCall("⏰ 23:30,最後 30 分鐘!"), { timezone: TZ });
cron.schedule("50 23 * * *", () => rollCall("🚨 23:50,最後 10 分鐘,快躺平!"), { timezone: TZ });

// ── 每週日 21:00 週報 ──
cron.schedule("0 21 * * 0", async () => {
  const weekAgo = new Date(nowTW().getTime() - 7 * 86400 * 1000).toISOString().slice(0, 10);
  const groups = [...new Set(Object.values(DB.users).map((u) => u.groupId).filter(Boolean))];
  for (const gid of groups) {
    const lines = Object.entries(DB.users)
      .filter(([, u]) => u.groupId === gid)
      .map(([uid, u]) => {
        const n = Object.entries(DB.checkins).filter(([key, c]) => {
          const [id, date] = key.split("|");
          return id === uid && date >= weekAgo && c.morningConfirmed && c.beforeMidnight;
        }).length;
        return `${u.name}:${n}/7 天`;
      });
    await client.pushMessage(gid, {
      type: "text",
      text: `📊 本週 Offline Before Midnight 週報\n${lines.join("\n")}`,
    }).catch(() => {});
  }
}, { timezone: TZ });

app.listen(process.env.PORT || 3000, () => console.log("🌙 OBM Bot 啟動"));

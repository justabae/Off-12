// Offline Before Midnight 🌙 v2
// 改動:移除早晨回卡、群組廣播限 23:00 點名 + 00:00 唱名、
//       群組排行只列同群成員、私訊排行只顯示自己的名次(不揭露他人名字)

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
// checkins: { "userId|sleepDate": { nightTime, beforeMidnight } }

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
    if (uid === userId) byDate[date] = c.beforeMidnight;
  }
  let streak = 0;
  const cur = nowTW();
  if (cur.getHours() < 4) cur.setDate(cur.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const d = new Date(cur);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (byDate[key] === true) streak++;
    else if (i === 0) continue; // 今晚還沒打卡不中斷
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
    `🚨 ${name} 連續 3 天遲睡!寢具升級進度歸零,認真早點睡`,
    `🔴 ${name} 已連續 ${level} 天遲睡,長期睡眠不足會影響專注力和免疫力,調整作息吧!`,
  ];
  return msgs[Math.min(level - 1, 3)];
}

// ── 排行工具 ──
function fullBoard() {
  return Object.entries(DB.users)
    .map(([uid, u]) => ({ uid, name: u.name, groupId: u.groupId, streak: streakOf(uid) }))
    .sort((a, b) => b.streak - a.streak);
}

// ── Webhook ──
const app = express();
app.get("/", (req, res) => res.send("🌙 OBM Bot is running"));

app.post("/webhook", middleware(config), async (req, res) => {
  res.sendStatus(200);
  for (const ev of req.body.events) {
    try { await handleEvent(ev); } catch (e) { console.error(e); }
  }
});

async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message.type !== "text") return;
  const text = ev.message.text.trim();
  const userId = ev.source.userId;
  const groupId = ev.source.groupId || null;
  const inGroup = !!groupId;
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

  // 晚安打卡(建議私訊,但群組打也接受)
  if (/^(晚安|睡覺|打卡|我要睡了)/.test(text)) {
    // 同一晚已打過卡 → 不重複計算,提示原始時間
    const exist = DB.checkins[ck];
    if (exist) {
      const t = new Date(exist.nightTime);
      const tTW = new Date(t.toLocaleString("en-US", { timeZone: TZ }));
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `📌 你今晚(${sd})已在 ${fmtTime(tTW)} 打過卡囉,一晚只算一次\n手機放下,真的去睡!🌙`,
      });
    }
    const before = now.getHours() >= 18;
    DB.checkins[ck] = { nightTime: now.toISOString(), beforeMidnight: before };
    if (before) {
      DB.users[userId].lateLevel = 0;
      saveDB();
      const s = streakOf(userId);
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `😴 ${fmtTime(now)} 下線成功!連續早睡 ${s} 天\n目前寢具:${gearOf(s)}\n${nextGear(s)}\n祝好夢 🌙`,
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

  // 紀錄:查自己最近 7 晚的打卡狀況
  if (/^(紀錄|記錄|打卡紀錄|月曆)/.test(text)) {
    const lines = [];
    const cur = nowTW();
    if (cur.getHours() < 4) cur.setDate(cur.getDate() - 1);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(cur);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const c = DB.checkins[`${userId}|${key}`];
      const mark = !c ? "▫️ 未打卡" : c.beforeMidnight ? "✅ 準時" : "🥱 過午夜";
      lines.push(`${key.slice(5)} ${mark}`);
    }
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: `📅 你最近 7 晚的紀錄\n${lines.join("\n")}`,
    });
  }

  // 排行:群組 → 列同群成員;私訊 → 只顯示自己的名次
  if (/^(排行|排行榜|寢具|裝備)/.test(text)) {
    const board = fullBoard();
    if (inGroup) {
      const groupBoard = board.filter((u) => u.groupId === groupId).slice(0, 10);
      const lines = groupBoard.map(
        (u, i) => `${["🌕", "🌖", "🌗"][i] || `${i + 1}.`} ${u.name} 🔥${u.streak}天 ${gearOf(u.streak)}`
      );
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: lines.length ? `🌙 本群 Offline Before Midnight 排行\n${lines.join("\n")}` : "本群還沒有紀錄,今晚開始!",
      });
    } else {
      const rank = board.findIndex((u) => u.uid === userId) + 1;
      if (!rank)
        return client.replyMessage(ev.replyToken, { type: "text", text: "還沒有你的紀錄,今晚回「晚安」開始!" });
      const me = board[rank - 1];
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `🌙 你目前排名第 ${rank} 名(共 ${board.length} 人)\n連續早睡 ${me.streak} 天\n目前寢具:${gearOf(me.streak)}\n${nextGear(me.streak)}`,
      });
    }
  }
}

// ── 群組廣播:每天最多 2 則 ──

// 23:00 點名尚未打卡的人
cron.schedule("0 23 * * *", async () => {
  const sd = sleepDateOf(nowTW());
  const groups = [...new Set(Object.values(DB.users).map((u) => u.groupId).filter(Boolean))];
  for (const gid of groups) {
    const missing = Object.entries(DB.users)
      .filter(([uid, u]) => u.groupId === gid && !DB.checkins[`${uid}|${sd}`])
      .map(([, u]) => u.name);
    if (!missing.length) continue;
    await client.pushMessage(gid, {
      type: "text",
      text: `🌙 23:00,距離午夜還有 1 小時\n尚未下線:${missing.join("、")}\n私訊我「晚安」打卡!`,
    }).catch(() => {});
  }
}, { timezone: TZ });

// 00:00 唱名沒趕上的人
cron.schedule("0 0 * * *", async () => {
  const now = nowTW();
  const sd = sleepDateOf(now); // 00:00 時 hours<4,自動指向剛結束的那一晚
  const groups = [...new Set(Object.values(DB.users).map((u) => u.groupId).filter(Boolean))];
  for (const gid of groups) {
    const members = Object.entries(DB.users).filter(([, u]) => u.groupId === gid);
    const missed = members
      .filter(([uid]) => {
        const c = DB.checkins[`${uid}|${sd}`];
        return !c || !c.beforeMidnight;
      })
      .map(([, u]) => u.name);
    if (!missed.length) {
      await client.pushMessage(gid, {
        type: "text",
        text: `🎉 午夜到!今晚全員準時下線,太強了!`,
      }).catch(() => {});
      continue;
    }
    await client.pushMessage(gid, {
      type: "text",
      text: `🕛 午夜鐘聲響起\n今晚未準時下線:${missed.join("、")}\n明天早點睡,連續紀錄等著你重新開始 🌙`,
    }).catch(() => {});
  }
}, { timezone: TZ });

// 每週日 21:00 週報(每週 1 則,不佔每日 2 則額度)
cron.schedule("0 21 * * 0", async () => {
  const weekAgo = new Date(nowTW().getTime() - 7 * 86400 * 1000).toISOString().slice(0, 10);
  const groups = [...new Set(Object.values(DB.users).map((u) => u.groupId).filter(Boolean))];
  for (const gid of groups) {
    const lines = Object.entries(DB.users)
      .filter(([, u]) => u.groupId === gid)
      .map(([uid, u]) => {
        const n = Object.entries(DB.checkins).filter(([key, c]) => {
          const [id, date] = key.split("|");
          return id === uid && date >= weekAgo && c.beforeMidnight;
        }).length;
        return `${u.name}:${n}/7 天`;
      });
    await client.pushMessage(gid, {
      type: "text",
      text: `📊 本週 Offline Before Midnight 週報\n${lines.join("\n")}`,
    }).catch(() => {});
  }
}, { timezone: TZ });

app.listen(process.env.PORT || 3000, () => console.log("🌙 OBM Bot v2 啟動"));

import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import Tesseract from "tesseract.js";
import express from "express";
import fs from "fs";

const {
  API_ID,
  API_HASH,
  TG_SESSION,
  BOT_TOKEN,
  CHAT_ID,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN
} = process.env;

const DTEK_CHANNEL = "dtek_ua";
const LAST_KEY = "last_dtek_msg";

const client = new TelegramClient(
  new StringSession(TG_SESSION),
  Number(API_ID),
  API_HASH,
  { connectionRetries: 5 }
);

async function redisGet(key) {
  const r = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
  });
  const j = await r.json();
  return j.result;
}

async function redisSet(key, value) {
  await fetch(`${UPSTASH_REDIS_REST_URL}/set/${key}/${value}`, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
  });
}

async function sendToChannel(text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
}

function extractDate(text) {
  const m = text.match(/на\s+(\d{1,2})\s+([а-яіїє]+)/i);
  if (!m) return "";
  return `📆 ${m[1]} ${m[2]}`;
}

async function ocrImage(path) {
  const { data } = await Tesseract.recognize(path, "ukr");
  return data.text;
}

function parseQueues(text) {
  const lines = text.split("\n").map(l => l.trim());
  const result = {};
  let current = null;

  for (const l of lines) {
    const q = l.match(/([1-6]\.[12])/);
    if (q) {
      current = q[1];
      result[current] = [];
    }
    const t = l.match(/(\d{1,2}:\d{2}).+?(\d{1,2}:\d{2})/);
    if (current && t) {
      result[current].push(`❌з ${t[1]} до ${t[2]}`);
    }
  }
  return result;
}

function buildMessage(date, queues) {
  let msg = `⚡️💡<b>Оновлений графік відключення світла</b>\n${date}\n\n`;
  for (const q of Object.keys(queues)) {
    msg += `💡<b>Черга ${q} відключення:</b>\n`;
    msg += queues[q].join("\n") + "\n\n";
  }
  return msg;
}

async function checkDTEK() {
  const lastId = await redisGet(LAST_KEY);

  const messages = await client.getMessages(DTEK_CHANNEL, { limit: 5 });
  const msg = messages.find(m =>
    m.message &&
    m.message.includes("Київщина: графіки відключень")
  );
  if (!msg || String(msg.id) === lastId) return;

  const photos = msg.media?.photo ? [msg.media.photo] : [];
  if (!photos.length) return;

  const files = [];
  for (let i = 0; i < photos.length; i++) {
    const path = `img_${i}.jpg`;
    await client.downloadMedia(photos[i], { file: path });
    files.push(path);
  }

  let allText = "";
  for (const f of files) {
    allText += await ocrImage(f) + "\n";
    fs.unlinkSync(f);
  }

  const queues = parseQueues(allText);
  const date = extractDate(msg.message);
  const out = buildMessage(date, queues);

  await sendToChannel(out);
  await redisSet(LAST_KEY, String(msg.id));
}

(async () => {
  await client.start();
  setInterval(checkDTEK, 30000);
})();

const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

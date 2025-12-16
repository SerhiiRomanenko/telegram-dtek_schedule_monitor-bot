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

/* ---------------- REDIS ---------------- */

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

/* ---------------- TELEGRAM SEND ---------------- */

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

/* ---------------- HELPERS ---------------- */

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
      result[current].push(`❌ з ${t[1]} до ${t[2]}`);
    }
  }

  return result;
}

function buildMessage(date, queues) {
  let msg = `⚡️💡 <b>Київщина — графік відключень ДТЕК</b>\n${date}\n\n`;

  for (const q of Object.keys(queues)) {
    msg += `💡 <b>Черга ${q}:</b>\n`;
    msg += queues[q].join("\n") + "\n\n";
  }

  return msg;
}

/* ---------------- MAIN LOGIC ---------------- */

async function checkDTEK() {
  const lastId = await redisGet(LAST_KEY);

  const messages = await client.getMessages(DTEK_CHANNEL, { limit: 40 });
  console.log("Fetched messages:", messages.length);

  const captionMsg = messages.find(
    m =>
      m.message &&
      /(^|\n).*київщина[:.]?\s*графіки відключень/i.test(m.message)
  );

  if (!captionMsg) {
    console.log("No Kyiv region schedule found");
    return;
  }

  if (String(captionMsg.id) === lastId) {
    console.log("Already processed:", captionMsg.id);
    return;
  }

  console.log("Found target post:", captionMsg.id);

  let allText = captionMsg.message + "\n";

  if (captionMsg.groupedId) {
    const album = messages.filter(
      m => m.groupedId === captionMsg.groupedId && m.media?.photo
    );

    console.log("Album photos:", album.length);

    for (let i = 0; i < album.length; i++) {
      const path = `img_${i}.jpg`;
      await client.downloadMedia(album[i].media.photo, { file: path });
      allText += await ocrImage(path) + "\n";
      fs.unlinkSync(path);
    }
  }

  const queues = parseQueues(allText);
  if (!Object.keys(queues).length) {
    console.log("No queues detected");
    return;
  }

  const date = extractDate(allText);
  const out = buildMessage(date, queues);

  await sendToChannel(out);
  await redisSet(LAST_KEY, String(captionMsg.id));

  console.log("Message sent");
}

/* ---------------- START ---------------- */

(async () => {
  await client.start();
  console.log("Telegram client started");

  await checkDTEK(); // 🔴 критично важливо

  setInterval(() => {
    console.log("Checking DTEK...");
    checkDTEK();
  }, 30000);
})();

const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);
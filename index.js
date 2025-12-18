import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import Tesseract from "tesseract.js";
import express from "express";

/* ================= ENV ================= */

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

const REDIS_LAST_ALBUM = "last_dtek_album";
const REDIS_LAST_MESSAGE = "last_dtek_message";

/* ================= TELEGRAM CLIENT ================= */

const client = new TelegramClient(
  new StringSession(TG_SESSION),
  Number(API_ID),
  API_HASH,
  { connectionRetries: 5 }
);

/* ================= REDIS ================= */

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

/* ================= TELEGRAM BOT API ================= */

async function sendMessage(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  const j = await r.json();

  if (!j.ok) {
    console.error("[TG ERROR]", j);
    throw new Error("sendMessage failed");
  }

  return j.result.message_id;
}


async function editMessage(messageId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
}

/* ================= OCR ================= */

async function ocrBuffer(buffer) {
  const { data } = await Tesseract.recognize(buffer, "ukr");
  return data.text;
}

/* ================= PARSING ================= */

function extractDate(text) {
  const m = text.match(/на\s+(\d{1,2})\s+([а-яіїє]+)/i);
  return m ? `📆 ${m[1]} ${m[2]}` : "";
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

function buildMessage(date, queues, updated) {
  let msg = `⚡️💡 <b>${updated ? "ОНОВЛЕНИЙ ГРАФІК ВІДКЛЮЧЕНЬ" : "ГРАФІК ВІДКЛЮЧЕНЬ СВІТЛА"}</b>\n`;
  if (date) msg += `${date}\n\n`;

  for (const q of Object.keys(queues)) {
    msg += `💡 <b>Черга ${q}:</b>\n`;
    msg += queues[q].join("\n") + "\n\n";
  }
  return msg.trim();
}

/* ================= MAIN LOGIC ================= */

async function checkDTEK() {
  console.log("[CHECK] checking DTEK channel");

  const messages = await client.getMessages(DTEK_CHANNEL, { limit: 20 });

  messages.forEach(m => {
    console.log(
      "[MSG]",
      m.id,
      "photo:",
      !!m.media?.photo,
      "text:",
      m.message?.slice(0, 45)
    );
  });

  const mainPost = messages.find(m =>
    /Київщина:.*графіки/i.test(m.message || "") &&
    !/оновлен/i.test(m.message || "")
  );

  const updatedPost = messages.find(m =>
    /Київщина:.*оновлен.*графіки/i.test(m.message || "")
  );

  const target = updatedPost || mainPost;

  if (!target) {
    console.log("[SKIP] no valid DTEK post");
    return;
  }

  let photos = [];

  if (target.media?.photo) {
    photos = [target];
  }

  if (!photos.length) {
    console.log("[SKIP] no photos to OCR");
    return;
  }

  let ocrText = "";

  for (const p of photos) {
    const buffer = await client.downloadMedia(p, {});
    ocrText += await ocrBuffer(buffer);
  }

  const queues = parseQueues(ocrText);
  const date = extractDate(target.message);
  const outText = buildMessage(date, queues, !!updatedPost);

  if (!Object.keys(queues).length) {
    console.log("[SKIP] OCR produced no queues");
    return;
  }

  const lastMsgId = await redisGet(REDIS_LAST_MESSAGE);

  if (updatedPost && lastMsgId) {
    console.log("[EDIT] updating existing post");
    await editMessage(Number(lastMsgId), outText);
  } else {
    console.log("[POST] sending new post");
    const newId = await sendMessage(outText);
    await redisSet(REDIS_LAST_MESSAGE, newId);
  }

  await redisSet(
    REDIS_LAST_ALBUM,
    target.mediaGroupId ? String(target.mediaGroupId) : "single"
  );
}

/* ================= START ================= */

(async () => {
  await client.start();
  console.log("[START] bot started");
  setInterval(checkDTEK, 30000);
})();

const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

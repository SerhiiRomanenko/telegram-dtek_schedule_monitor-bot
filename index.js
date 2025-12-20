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

const REDIS_LAST_MESSAGE = "last_dtek_message";
const REDIS_LAST_SOURCE = "last_dtek_source";

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
  return data.text || "";
}

/* ================= PARSING ================= */

function extractDate(text = "") {
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

    const t = l.match(/(\d{1,2}:\d{2}).*?(\d{1,2}:\d{2})/);
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

/* ================= MAIN ================= */

async function checkDTEK() {
  console.log("[CHECK] DTEK");

  const messages = await client.getMessages(DTEK_CHANNEL, { limit: 30 });

  const post = messages.find(m =>
    /Київщина:.*графік/i.test(m.message || "")
  );

  if (!post) {
    console.log("[SKIP] no post");
    return;
  }

  const sourceId = post.mediaGroupId || post.id;
  const lastSource = await redisGet(REDIS_LAST_SOURCE);

  if (String(sourceId) === lastSource) {
    console.log("[SKIP] already processed");
    return;
  }

  let photos = [];

  if (post.mediaGroupId) {
    photos = messages.filter(
      m => m.mediaGroupId === post.mediaGroupId && m.media?.photo
    );
  } else if (post.media?.photo) {
    photos = [post];
  }

  console.log("[INFO] photos:", photos.length);

  let ocrText = "";

  for (const p of photos) {
    const buffer = await client.downloadMedia(p);
    ocrText += await ocrBuffer(buffer);
  }

  let queues = parseQueues(ocrText);

  if (!Object.keys(queues).length) {
    console.log("[FALLBACK] parse from text");
    queues = parseQueues(post.message || "");
  }

  if (!Object.keys(queues).length) {
    console.log("[SKIP] no queues");
    return;
  }

  const date = extractDate(post.message);
  const updated = /оновлен/i.test(post.message || "");
  const outText = buildMessage(date, queues, updated);

  const lastMsgId = await redisGet(REDIS_LAST_MESSAGE);

  if (updated && lastMsgId) {
    console.log("[EDIT]");
    await editMessage(Number(lastMsgId), outText);
  } else {
    console.log("[POST]");
    const id = await sendMessage(outText);
    await redisSet(REDIS_LAST_MESSAGE, id);
  }

  await redisSet(REDIS_LAST_SOURCE, String(sourceId));
}

/* ================= START ================= */

(async () => {
  await client.start();
  console.log("[STARTED]");
  setInterval(checkDTEK, 30000);
})();

const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);
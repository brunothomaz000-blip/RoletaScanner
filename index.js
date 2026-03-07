const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { ethers } = require("ethers");

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CHAIN_ID = Number(process.env.CHAIN_ID || 42161);
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS || "").trim();

const DAYS_BACK = Number(process.env.DAYS_BACK || 90);
const RPC_URL = (process.env.RPC_URL || "").trim();

const HIST_CHUNK_BLOCKS = Number(process.env.HIST_CHUNK_BLOCKS || 6000);
const LIVE_STEP_BLOCKS = Number(process.env.LIVE_STEP_BLOCKS || 3000);
const POLL_MS = Number(process.env.POLL_MS || 1500);
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 30000);
const BLOCKS_PER_DAY = Number(process.env.BLOCKS_PER_DAY || 345600);

// =====================
// HELPERS
// =====================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtMult(h) {
  return (Number(h) / 100).toFixed(2).replace(/\.00$/, "") + "x";
}

function multNum(mult) {
  return Number(String(mult).replace("x", ""));
}

function winChance(mult) {
  return 1 / multNum(mult);
}

function expectedLoss(mult) {
  const p = winChance(mult);
  return (1 / p) - 1;
}

function varianceScore(mult, loss) {
  const exp = expectedLoss(mult);
  return exp > 0 ? loss / exp : 0;
}

function streakProbability(mult, loss) {
  const p = winChance(mult);
  const lose = 1 - p;
  return Math.pow(lose, loss);
}

function allowedChat(chatId) {
  if (!TELEGRAM_ALLOWED_CHAT_IDS.length) return true;
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId));
}

// =====================
// TELEGRAM
// =====================
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Faltou TELEGRAM_BOT_TOKEN");
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

let pollingStarting = false;
let pollingStarted = false;

// evita processar o mesmo comando duas vezes em poucos segundos
const recentCommands = new Map();

function shouldProcessCommand(chatId, text, windowMs = 2500) {
  const now = Date.now();
  const key = `${chatId}:${String(text || "").trim()}`;
  const last = recentCommands.get(key);

  // limpeza simples
  for (const [k, ts] of recentCommands.entries()) {
    if (now - ts > 15000) recentCommands.delete(k);
  }

  if (last && now - last < windowMs) return false;
  recentCommands.set(key, now);
  return true;
}

function send(chatId, text) {
  return bot.sendMessage(chatId, text, {
    disable_web_page_preview: true,
  }).catch((e) => {
    console.log("send error:", e?.message || e);
  });
}

async function startTelegramPolling() {
  if (pollingStarting || pollingStarted) return;

  pollingStarting = true;

  try {
    // limpa webhook antigo, se existir
    await bot.deleteWebHook({ drop_pending_updates: false }).catch(() => {});

    // garante que qualquer polling local desta instância foi parado
    await bot.stopPolling().catch(() => {});

    // dá tempo da instância antiga do Railway morrer
    await sleep(8000);

    await bot.startPolling({
      restart: true,
      polling: {
        interval: 300,
        params: { timeout: 10 },
      },
    });

    pollingStarted = true;
    console.log("🤖 Telegram polling iniciado");
  } catch (e) {
    console.log("Erro ao iniciar polling:", e?.message || e);
  } finally {
    pollingStarting = false;
  }
}

async function restartTelegramPolling(reason = "") {
  if (pollingStarting) return;

  pollingStarted = false;

  try {
    console.log(`⚠️ Reiniciando polling: ${reason}`);
    await bot.stopPolling().catch(() => {});
  } catch {}

  await sleep(5000);
  await startTelegramPolling();
}

bot.on("polling_error", async (err) => {
  const msg = err?.message || String(err || "");
  console.log("⚠️ polling_error:", msg);

  if (/409|terminated by other getUpdates request|conflict/i.test(msg)) {
    await restartTelegramPolling("409 conflict");
  }
});

// =====================
// STATE
// =====================
const stats = new Map();
const startMap = new Map();

function getStat(mult) {
  if (!stats.has(mult)) {
    stats.set(mult, {
      loss: 0,
      wins: 0,
      spins: 0,
      lastWinBlock: null,
      lastWinner: null,
      lastWager: 0n,
      lastPayout: 0n,
      lastJackpot: 0n,
    });
  }
  return stats.get(mult);
}

// =====================
// PROVIDER
// =====================
if (!RPC_URL) throw new Error("Faltou RPC_URL");
if (!CONTRACT_ADDRESS) throw new Error("Faltou CONTRACT_ADDRESS");

const provider = new ethers.JsonRpcProvider(
  RPC_URL,
  CHAIN_ID,
  { staticNetwork: true, timeout: RPC_TIMEOUT_MS }
);

const ABI = [
  "event SpinStarted(uint256 indexed requestId,address indexed player,uint256 wager,uint256 netStake,uint256 multiplierHundredths,uint256 maxPayout,uint256 jackpotContribution,uint32 configIndex,bool participatingInJackpot)",
  "event SpinResolved(uint256 indexed requestId,address indexed player,uint8 outcome,uint256 payout,uint8 spinsConsumed,uint256 jackpotPayout)"
];

const iface = new ethers.Interface(ABI);
const topicStarted = iface.getEvent("SpinStarted").topicHash;
const topicResolved = iface.getEvent("SpinResolved").topicHash;

// =====================
// EVENTS
// =====================
function onSpinStarted(log) {
  const parsed = iface.parseLog(log);

  startMap.set(parsed.args.requestId.toString(), {
    mult: parsed.args.multiplierHundredths,
    wager: parsed.args.wager,
    player: parsed.args.player,
  });
}

function onSpinResolved(log) {
  const parsed = iface.parseLog(log);
  const id = parsed.args.requestId.toString();
  const start = startMap.get(id);

  if (!start) return;

  const mult = fmtMult(start.mult);
  const s = getStat(mult);

  s.spins++;

  if (parsed.args.payout > 0n || parsed.args.jackpotPayout > 0n) {
    s.wins++;
    s.loss = 0;
    s.lastWinBlock = log.blockNumber;
    s.lastWinner = parsed.args.player;
    s.lastWager = start.wager;
    s.lastPayout = parsed.args.payout;
    s.lastJackpot = parsed.args.jackpotPayout;
  } else {
    s.loss++;
  }
}

function varianceRows(n = 10) {
  const arr = [];

  for (const [mult, v] of stats.entries()) {
    if (multNum(mult) < 2) continue;
    if (v.loss < 5) continue;
    if (v.spins < 10) continue;

    const expLoss = expectedLoss(mult);

    arr.push({
      mult,
      ...v,
      expLoss,
      score: varianceScore(mult, v.loss),
    });
  }

  arr.sort((a, b) => b.score - a.score);
  return arr.slice(0, n);
}

// =====================
// TELEGRAM COMMANDS
// =====================
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  send(
    chatId,
    [
      "🤖 COMANDOS",
      "",
      "/best → melhores pela variância",
      "/top → maior sequência de loss",
      "/m 30 → detalhes multiplicador",
      "/lastwin 30 → último ganhador",
      "/stats → resumo",
      "/chatid",
    ].join("\n")
  );
});

bot.onText(/\/chatid/, (msg) => {
  const chatId = msg.chat.id;
  if (!shouldProcessCommand(chatId, msg.text)) return;
  send(chatId, String(chatId));
});

bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  let spins = 0;
  let wins = 0;

  for (const v of stats.values()) {
    spins += v.spins;
    wins += v.wins;
  }

  send(
    chatId,
    `📦 STATS

multiplicadores: ${stats.size}
spins: ${spins}
wins: ${wins}`
  );
});

bot.onText(/\/top/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  const arr = [...stats.entries()]
    .map(([m, v]) => ({ mult: m, ...v }))
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 10);

  if (!arr.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = ["📊 TOP LOSS", ""];
  arr.forEach((r) => lines.push(`${r.mult} → ${r.loss} LOSS`));
  send(chatId, lines.join("\n"));
});

bot.onText(/\/best/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  const rows = varianceRows(10);

  if (!rows.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = ["🔥 MELHORES PELA VARIÂNCIA", ""];
  rows.forEach((r, i) => {
    lines.push(
      `${i + 1}️⃣ ${r.mult}
score: ${r.score.toFixed(2)}
loss: ${r.loss}
esperado: ${r.expLoss.toFixed(1)}`
    );
  });

  send(chatId, lines.join("\n\n"));
});

bot.onText(/\/m (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  let q = String(match[1] || "").replace(",", ".");
  let key = q.includes("x") ? q : q + "x";

  if (!stats.has(key)) {
    send(chatId, "multiplicador não encontrado");
    return;
  }

  const s = stats.get(key);
  const exp = expectedLoss(key);
  const prob = streakProbability(key, s.loss);

  send(
    chatId,
    `🎯 ${key}

LOSS: ${s.loss}
SPINS: ${s.spins}
WINS: ${s.wins}

esperado: ${exp.toFixed(1)}
score: ${(s.loss / exp).toFixed(2)}

chance dessa sequência: ${(prob * 100).toFixed(2)}%

último win: ${s.lastWinBlock || "-"}`
  );
});

bot.onText(/\/lastwin (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  let q = String(match[1] || "").replace(",", ".");
  let key = q.includes("x") ? q : q + "x";

  if (!stats.has(key)) {
    send(chatId, "multiplicador não encontrado");
    return;
  }

  const s = stats.get(key);

  if (!s.lastWinBlock) {
    send(chatId, "nenhum win registrado ainda");
    return;
  }

  send(
    chatId,
    `🏆 Último WIN — ${key}

Carteira:
${s.lastWinner}

Bloco:
${s.lastWinBlock}`
  );
});

// =====================
// RPC
// =====================
async function getLogs(from, to, topic) {
  return provider.getLogs({
    address: CONTRACT_ADDRESS,
    fromBlock: from,
    toBlock: to,
    topics: [topic],
  });
}

// =====================
// HISTORICAL
// =====================
async function scanHistorical() {
  const latest = await provider.getBlockNumber();

  const from = Math.max(
    0,
    latest - (DAYS_BACK * BLOCKS_PER_DAY)
  );

  let cur = from;

  while (cur <= latest) {
    const end = Math.min(latest, cur + HIST_CHUNK_BLOCKS);

    const [a, b] = await Promise.all([
      getLogs(cur, end, topicStarted),
      getLogs(cur, end, topicResolved),
    ]);

    a.forEach(onSpinStarted);
    b.forEach(onSpinResolved);

    cur = end + 1;
    console.log("hist", cur);
  }
}

// =====================
// LIVE
// =====================
async function scanLive() {
  let next = await provider.getBlockNumber();

  while (true) {
    const latest = await provider.getBlockNumber();

    if (next > latest) {
      await sleep(POLL_MS);
      continue;
    }

    const to = Math.min(latest, next + LIVE_STEP_BLOCKS);

    const [a, b] = await Promise.all([
      getLogs(next, to, topicStarted),
      getLogs(next, to, topicResolved),
    ]);

    a.forEach(onSpinStarted);
    b.forEach(onSpinResolved);

    next = to + 1;
  }
}

// =====================
// START
// =====================
(async () => {
  console.log("🚀 scanner start");

  await scanHistorical();

  await startTelegramPolling();

  console.log("📡 live mode");

  await scanLive();
})().catch((e) => {
  console.error("❌ erro fatal:", e?.message || e);
});

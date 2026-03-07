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
.map(s => s.trim())
.filter(Boolean);

const CHAIN_ID = Number(process.env.CHAIN_ID || 42161);
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const DAYS_BACK = Number(process.env.DAYS_BACK || 90);
const RPC_URL = process.env.RPC_URL;

const HIST_CHUNK_BLOCKS = Number(process.env.HIST_CHUNK_BLOCKS || 4000);
const LIVE_STEP_BLOCKS = Number(process.env.LIVE_STEP_BLOCKS || 2500);
const POLL_MS = Number(process.env.POLL_MS || 2000);

const BLOCKS_PER_DAY = Number(process.env.BLOCKS_PER_DAY || 345600);
const TOP_N = Number(process.env.TOP_N || 25);

// =====================
// TELEGRAM
// =====================

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// evita polling duplicado
(async () => {
  try {
    await bot.stopPolling().catch(()=>{});
    await bot.startPolling();
    console.log("🤖 Telegram polling iniciado");
  } catch(e){
    console.log("Erro polling:", e.message);
  }
})();

function allowedChat(chatId){
  if(!TELEGRAM_ALLOWED_CHAT_IDS.length) return true
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId))
}

function send(chatId,text){
  bot.sendMessage(chatId,text).catch(()=>{})
}

// =====================
// HELPERS
// =====================

function sleep(ms){
  return new Promise(r=>setTimeout(r,ms))
}

function fmtMult(h){
  return (Number(h)/100).toFixed(2).replace(/\.00$/,"")+"x"
}

function multNum(mult){
  return Number(mult.replace("x",""))
}

function winChance(mult){
  return 1/multNum(mult)
}

function expectedLoss(mult){
  const p=winChance(mult)
  return (1/p)-1
}

function varianceScore(mult,loss){
  const exp=expectedLoss(mult)
  return loss/exp
}

// =====================
// STATE
// =====================

const stats = new Map()
const startMap = new Map()

function getStat(mult){

  if(!stats.has(mult)){
    stats.set(mult,{
      loss:0,
      wins:0,
      spins:0,
      lastWinBlock:null,
      lastWinner:null
    })
  }

  return stats.get(mult)

}

// =====================
// PROVIDER
// =====================

const provider = new ethers.JsonRpcProvider(RPC_URL,CHAIN_ID)

const ABI = [
"event SpinStarted(uint256 indexed requestId,address indexed player,uint256 wager,uint256 netStake,uint256 multiplierHundredths,uint256 maxPayout,uint256 jackpotContribution,uint32 configIndex,bool participatingInJackpot)",
"event SpinResolved(uint256 indexed requestId,address indexed player,uint8 outcome,uint256 payout,uint8 spinsConsumed,uint256 jackpotPayout)"
]

const iface = new ethers.Interface(ABI)

const topicStarted = iface.getEvent("SpinStarted").topicHash
const topicResolved = iface.getEvent("SpinResolved").topicHash

// =====================
// EVENTS
// =====================

function onSpinStarted(log){

  const parsed=iface.parseLog(log)

  startMap.set(
    parsed.args.requestId.toString(),
    {
      mult:parsed.args.multiplierHundredths,
      player:parsed.args.player
    }
  )

}

function onSpinResolved(log){

  const parsed=iface.parseLog(log)

  const id=parsed.args.requestId.toString()
  const start=startMap.get(id)

  if(!start) return

  const mult=fmtMult(start.mult)
  const s=getStat(mult)

  s.spins++

  if(parsed.args.payout>0n){

    s.wins++
    s.loss=0

    s.lastWinBlock=log.blockNumber
    s.lastWinner=parsed.args.player

  }else{

    s.loss++

  }

}

// =====================
// VARIANCE RANKING
// =====================

function varianceRows(n=10){

  const arr=[]

  for(const [mult,v] of stats.entries()){

    if(multNum(mult)<2) continue
    if(v.loss<5) continue
    if(v.spins<10) continue

    arr.push({
      mult,
      ...v,
      expLoss:expectedLoss(mult),
      score:varianceScore(mult,v.loss)
    })

  }

  arr.sort((a,b)=>b.score-a.score)

  return arr.slice(0,n)

}

// =====================
// TELEGRAM COMMANDS
// =====================

bot.onText(/\/help/,msg=>{

  send(msg.chat.id,
`🤖 COMANDOS

/best → melhores pela variância
/top → maior sequência de loss
/m 30 → detalhes multiplicador
/lastwin 30 → último ganhador
/stats → resumo
/chatid`
)

})

bot.onText(/\/chatid/,msg=>{
  send(msg.chat.id,String(msg.chat.id))
})

bot.onText(/\/stats/,msg=>{

  let spins=0
  let wins=0

  for(const v of stats.values()){
    spins+=v.spins
    wins+=v.wins
  }

  send(msg.chat.id,
`📦 STATS

multiplicadores: ${stats.size}
spins: ${spins}
wins: ${wins}`
)

})

bot.onText(/\/top/,msg=>{

  const arr=[...stats.entries()]
  .map(([m,v])=>({mult:m,...v}))
  .sort((a,b)=>b.loss-a.loss)
  .slice(0,10)

  const lines=["📊 TOP LOSS\n"]

  arr.forEach(r=>{
    lines.push(`${r.mult} → ${r.loss} LOSS`)
  })

  send(msg.chat.id,lines.join("\n"))

})

bot.onText(/\/best/,msg=>{

  const rows=varianceRows(10)

  const lines=["🔥 MELHORES PELA VARIÂNCIA\n"]

  rows.forEach((r,i)=>{

    lines.push(
`${i+1}️⃣ ${r.mult}
score: ${r.score.toFixed(2)}
loss: ${r.loss}
esperado: ${r.expLoss.toFixed(1)}`
)

  })

  send(msg.chat.id,lines.join("\n\n"))

})

bot.onText(/\/m (.+)/,(msg,match)=>{

  let q=match[1].replace(",",".")

  let key=q.includes("x")?q:q+"x"

  if(!stats.has(key)){
    send(msg.chat.id,"multiplicador não encontrado")
    return
  }

  const s=stats.get(key)
  const exp=expectedLoss(key)

  send(msg.chat.id,
`🎯 ${key}

LOSS: ${s.loss}
SPINS: ${s.spins}
WINS: ${s.wins}

esperado: ${exp.toFixed(1)}
score: ${(s.loss/exp).toFixed(2)}

último win: ${s.lastWinBlock || "-"}`)

})

bot.onText(/\/lastwin (.+)/,(msg,match)=>{

  let q=match[1].replace(",",".")

  let key=q.includes("x")?q:q+"x"

  if(!stats.has(key)){
    send(msg.chat.id,"multiplicador não encontrado")
    return
  }

  const s=stats.get(key)

  if(!s.lastWinBlock){
    send(msg.chat.id,"nenhum win registrado ainda")
    return
  }

  send(msg.chat.id,
`🏆 Último WIN — ${key}

Carteira:
${s.lastWinner}

Bloco:
${s.lastWinBlock}`)

})

// =====================
// RPC
// =====================

async function getLogs(from,to,topic){

  return provider.getLogs({
    address:CONTRACT_ADDRESS,
    fromBlock:from,
    toBlock:to,
    topics:[topic]
  })

}

// =====================
// HISTORICAL
// =====================

async function scanHistorical(){

  const latest=await provider.getBlockNumber()

  const from=Math.max(
    0,
    latest-(DAYS_BACK*BLOCKS_PER_DAY)
  )

  let cur=from

  while(cur<=latest){

    const end=Math.min(latest,cur+HIST_CHUNK_BLOCKS)

    const [a,b]=await Promise.all([
      getLogs(cur,end,topicStarted),
      getLogs(cur,end,topicResolved)
    ])

    a.forEach(onSpinStarted)
    b.forEach(onSpinResolved)

    cur=end+1

    console.log("hist",cur)

  }

}

// =====================
// LIVE
// =====================

async function scanLive(){

  let next=await provider.getBlockNumber()

  while(true){

    const latest=await provider.getBlockNumber()

    if(next>latest){
      await sleep(POLL_MS)
      continue
    }

    const to=Math.min(latest,next+LIVE_STEP_BLOCKS)

    const [a,b]=await Promise.all([
      getLogs(next,to,topicStarted),
      getLogs(next,to,topicResolved)
    ])

    a.forEach(onSpinStarted)
    b.forEach(onSpinResolved)

    next=to+1

  }

}

// =====================
// START
// =====================

(async()=>{

  console.log("🚀 scanner start")

  await scanHistorical()

  console.log("📡 live mode")

  await scanLive()

})()

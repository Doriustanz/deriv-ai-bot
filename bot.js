/*
 ═══════════════════════════════════════════════════════════
  DERIV AI CFD AUTOBOT — Node.js Server Edition
  Trades: EUR/USD, GBP/USD, USD/JPY, XAU/USD, USD/CAD,
          AUD/USD, EUR/GBP, USD/CHF via Deriv Multipliers
  Host free on Railway.app
 ═══════════════════════════════════════════════════════════
*/

const WebSocket = require('ws');
const express   = require('express');
const path      = require('path');
const fs        = require('fs');

/* ── Config from environment variables (set in Railway) ── */
const CONFIG = {
  DERIV_TOKEN:    process.env.DERIV_TOKEN    || '',
  STAKE:          parseFloat(process.env.STAKE          || '1.00'),
  MULTIPLIER:     parseInt(  process.env.MULTIPLIER     || '100'),
  SL_PIPS:        parseFloat(process.env.SL_PIPS        || '20'),
  TP_PIPS:        parseFloat(process.env.TP_PIPS        || '40'),
  MAX_DAILY_LOSS: parseFloat(process.env.MAX_DAILY_LOSS || '3.00'),
  MAX_OPEN:       parseInt(  process.env.MAX_OPEN       || '2'),
  SCAN_INTERVAL:  parseInt(  process.env.SCAN_INTERVAL  || '30'),   // seconds
  SYM_COOLDOWN:   parseInt(  process.env.SYM_COOLDOWN   || '180'),  // seconds
  MIN_SCORE:      parseFloat(process.env.MIN_SCORE      || '62'),
  PORT:           parseInt(  process.env.PORT           || '3000'),
};

/* ── Markets ─────────────────────────────────────────── */
const ALL_MARKETS = [
  { sym:'frxEURUSD', label:'EUR/USD', pip:0.0001, digits:5 },
  { sym:'frxGBPUSD', label:'GBP/USD', pip:0.0001, digits:5 },
  { sym:'frxUSDJPY', label:'USD/JPY', pip:0.01,   digits:3 },
  { sym:'frxXAUUSD', label:'XAU/USD', pip:0.01,   digits:2 },
  { sym:'frxUSDCAD', label:'USD/CAD', pip:0.0001, digits:5 },
  { sym:'frxAUDUSD', label:'AUD/USD', pip:0.0001, digits:5 },
  { sym:'frxEURGBP', label:'EUR/GBP', pip:0.0001, digits:5 },
  { sym:'frxUSDCHF', label:'USD/CHF', pip:0.0001, digits:5 },
];

/* ── State ───────────────────────────────────────────── */
let ws             = null;
let running        = false;
let authed         = false;
let accountCurrency= 'USD';
let balance        = 0;
let pnl            = 0;
let wins           = 0;
let losses         = 0;
let dailyLoss      = 0;
let openPositions  = {};
let pendingProposals = {};
let symLastTrade   = {};
let scanTimer      = null;
let reconnectTimer = null;
let reconnectCount = 0;
let markets        = {};
let tradeLogs      = [];   // in-memory ring buffer (last 200)
let startTime      = null;

ALL_MARKETS.forEach(({ sym }) => {
  markets[sym] = { candles:[], price:null, signal:null, score:0, wins:0, losses:0 };
});

/* ── Logging ─────────────────────────────────────────── */
const LOG_FILE = path.join(__dirname, 'logs', 'trades.log');
if (!fs.existsSync(path.join(__dirname, 'logs'))) fs.mkdirSync(path.join(__dirname, 'logs'));

function log(msg, type = 'info') {
  const ts  = new Date().toISOString();
  const line = `[${ts}] [${type.toUpperCase().padEnd(5)}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
  tradeLogs.unshift({ ts, msg, type });
  if (tradeLogs.length > 200) tradeLogs.pop();
}

/* ════════════════════════════════════════════════════════
   STRATEGY ENGINE
   ════════════════════════════════════════════════════════ */

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, lossesR = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else lossesR -= d;
  }
  const ag = gains / period, al = lossesR / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const macdArr = [];
  for (let i = 26; i <= closes.length; i++) {
    macdArr.push(calcEMA(closes.slice(0, i), 12) - calcEMA(closes.slice(0, i), 26));
  }
  const signalLine = calcEMA(macdArr, 9);
  const macdLine   = macdArr[macdArr.length - 1];
  return { macd: macdLine, signal: signalLine, hist: macdLine - signalLine };
}

function calcBB(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, mid: mean, lower: mean - 2 * std, std };
}

function calcStoch(candles, kPeriod = 14) {
  if (candles.length < kPeriod) return { k: 50, d: 50 };
  const slice = candles.slice(-kPeriod);
  const high  = Math.max(...slice.map(c => c.high));
  const low   = Math.min(...slice.map(c => c.low));
  const close = candles[candles.length - 1].close;
  const k = high === low ? 50 : ((close - low) / (high - low)) * 100;
  return { k, d: k };
}

function calcSR(candles) {
  if (candles.length < 10) return { support: 0, resistance: Infinity };
  const recent = candles.slice(-30);
  return {
    resistance: Math.max(...recent.map(c => c.high)),
    support:    Math.min(...recent.map(c => c.low)),
  };
}

function analyzeMarket(sym) {
  const m   = markets[sym];
  const mkt = ALL_MARKETS.find(x => x.sym === sym);
  if (!m || m.candles.length < 20) return { fire:false, score:0, dir:'NONE' };

  const closes = m.candles.map(c => c.close);
  const price  = m.price || closes[closes.length - 1];
  const pip    = mkt.pip;

  const rsi   = calcRSI(closes);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const macdR = calcMACD(closes);
  const bb    = calcBB(closes);
  const stoch = calcStoch(m.candles);
  const sr    = calcSR(m.candles);

  let bull = 0, bear = 0;
  const sigs = {};

  // RSI
  if      (rsi < 30) { bull += 22; sigs.rsi = { dir:'BUY',  label:'RSI OS '  + rsi.toFixed(0) }; }
  else if (rsi > 70) { bear += 22; sigs.rsi = { dir:'SELL', label:'RSI OB '  + rsi.toFixed(0) }; }
  else { rsi > 50 ? bull += 8 : bear += 8; sigs.rsi = { dir: rsi>50?'BUY':'SELL', label:'RSI '+rsi.toFixed(0) }; }

  // MACD
  if      (macdR.hist > 0) { bull += 18; sigs.macd = { dir:'BUY',  label:'MACD↑' }; }
  else if (macdR.hist < 0) { bear += 18; sigs.macd = { dir:'SELL', label:'MACD↓' }; }
  else                     { sigs.macd = { dir:'NEUT', label:'MACD FLAT' }; }

  // EMA trend
  if      (ema20 > ema50 && price > ema20) { bull += 20; sigs.ema = { dir:'BUY',  label:'EMA BULL' }; }
  else if (ema20 < ema50 && price < ema20) { bear += 20; sigs.ema = { dir:'SELL', label:'EMA BEAR' }; }
  else { price > ema20 ? bull += 8 : bear += 8; sigs.ema = { dir:price>ema20?'BUY':'SELL', label:'EMA MID' }; }

  // Bollinger
  if (bb) {
    if      (price <= bb.lower) { bull += 15; sigs.bb = { dir:'BUY',  label:'BB Lower' }; }
    else if (price >= bb.upper) { bear += 15; sigs.bb = { dir:'SELL', label:'BB Upper' }; }
    else { sigs.bb = { dir:'NEUT', label:'BB Mid' }; }
  }

  // Stoch
  if      (stoch.k < 20) { bull += 12; sigs.stoch = { dir:'BUY',  label:'STOCH OS' }; }
  else if (stoch.k > 80) { bear += 12; sigs.stoch = { dir:'SELL', label:'STOCH OB' }; }
  else { stoch.k > 50 ? bull += 5 : bear += 5; sigs.stoch = { dir:stoch.k>50?'BUY':'SELL', label:'STOCH '+stoch.k.toFixed(0) }; }

  // S/R
  const range    = (sr.resistance - sr.support) / pip;
  const distSup  = (price - sr.support) / pip;
  const distRes  = (sr.resistance - price) / pip;
  if      (distSup < range * 0.15) { bull += 13; sigs.sr = { dir:'BUY',  label:'Near Support' }; }
  else if (distRes < range * 0.15) { bear += 13; sigs.sr = { dir:'SELL', label:'Near Resist.'  }; }
  else { sigs.sr = { dir:'NEUT', label:'Mid Range' }; }

  // Momentum
  if (closes.length >= 5) {
    const mom = closes.slice(-5).reduce((a,b,i,arr) => i>0 ? a+(b-arr[i-1]) : 0, 0);
    if      (mom > pip * 3)  { bull += 10; sigs.vol = { dir:'BUY',  label:'MOM UP'   }; }
    else if (mom < -pip * 3) { bear += 10; sigs.vol = { dir:'SELL', label:'MOM DOWN' }; }
    else                     { sigs.vol = { dir:'NEUT', label:'MOM FLAT' }; }
  }

  const total = bull + bear;
  let dir = 'NONE', conf = 0;
  if      (bull > bear) { dir = 'BUY';  conf = total > 0 ? Math.min(95, 40 + (bull/total)*60) : 40; }
  else if (bear > bull) { dir = 'SELL'; conf = total > 0 ? Math.min(95, 40 + (bear/total)*60) : 40; }

  // Require at least 3 indicators agreeing
  const dirCount = { BUY:0, SELL:0, NEUT:0 };
  Object.values(sigs).forEach(s => dirCount[s.dir]++);
  if (Math.max(dirCount.BUY, dirCount.SELL) < 3) conf *= 0.6;

  const fire = conf >= CONFIG.MIN_SCORE && dir !== 'NONE';
  return { fire, dir, score: conf, score100: Math.round(conf), signals: sigs, rsi, ema20, ema50, price };
}

/* ════════════════════════════════════════════════════════
   WEBSOCKET / TRADING
   ════════════════════════════════════════════════════════ */

function connect() {
  if (!CONFIG.DERIV_TOKEN) {
    log('❌ No DERIV_TOKEN set. Add it as an environment variable.', 'error');
    return;
  }
  log('🔌 Connecting to Deriv WebSocket…');
  ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

  ws.on('open', () => {
    reconnectCount = 0;
    log('🔑 Authenticating…');
    ws.send(JSON.stringify({ authorize: CONFIG.DERIV_TOKEN }));
  });

  ws.on('message', (data) => {
    try { handleMessage(JSON.parse(data)); } catch(e) { log('Parse error: ' + e.message, 'error'); }
  });

  ws.on('error', (e) => log('WS error: ' + e.message, 'error'));

  ws.on('close', () => {
    if (!running) return;
    reconnectCount++;
    const delay = Math.min(30, reconnectCount * 5);
    log(`⚡ Disconnected — reconnecting in ${delay}s (attempt ${reconnectCount})`, 'warn');
    reconnectTimer = setTimeout(connect, delay * 1000);
  });
}

function handleMessage(d) {
  if (d.error) {
    const msg  = d.error.message || '';
    const code = d.error.code    || '';
    if (d.echo_req && d.echo_req.symbol) delete pendingProposals[d.echo_req.symbol];
    if (msg.includes('Multiplier') || msg.includes('duration') || code.includes('Validation')) {
      log('⚠ Trade skipped: ' + msg, 'warn');
    } else {
      log(`API Error [${code}]: ${msg}`, 'error');
    }
    return;
  }

  switch (d.msg_type) {

    case 'authorize':
      authed = true;
      balance = parseFloat(d.authorize.balance || 0);
      accountCurrency = d.authorize.currency || 'USD';
      log(`✅ Authorised: ${d.authorize.email} [${d.authorize.loginid}] · Balance: ${balance.toFixed(2)} ${accountCurrency}`);
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      startBot();
      break;

    case 'balance':
      balance = parseFloat(d.balance.balance);
      break;

    case 'history':
      handleHistory(d);
      break;

    case 'tick':
      handleTick(d.tick);
      break;

    case 'proposal':
      handleProposal(d);
      break;

    case 'buy':
      handleBuy(d.buy);
      break;

    case 'proposal_open_contract':
      handleContractUpdate(d.proposal_open_contract);
      break;
  }
}

function startBot() {
  running   = true;
  startTime = new Date();
  log(`🤖 Bot LIVE — scanning ${ALL_MARKETS.length} markets every ${CONFIG.SCAN_INTERVAL}s`);
  log(`📌 Stake:$${CONFIG.STAKE} · x${CONFIG.MULTIPLIER} · SL:${CONFIG.SL_PIPS}pip · TP:${CONFIG.TP_PIPS}pip · MaxLoss:$${CONFIG.MAX_DAILY_LOSS}`);

  // Subscribe ticks + load candle history for all markets
  ALL_MARKETS.forEach(({ sym }) => {
    ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
    ws.send(JSON.stringify({
      ticks_history: sym,
      adjust_start_time: 1,
      count: 100,
      end: 'latest',
      granularity: 60,
      start: 1,
      style: 'candles'
    }));
  });

  scanTimer = setInterval(runScan, CONFIG.SCAN_INTERVAL * 1000);
  setTimeout(runScan, 8000); // first scan after 8s
}

function handleHistory(d) {
  if (!d.echo_req) return;
  const sym = d.echo_req.ticks_history;
  if (!markets[sym]) return;

  // candles response
  if (d.candles) {
    markets[sym].candles = d.candles.map(c => ({
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
      time:  c.epoch
    }));
    log(`📥 ${sym}: ${markets[sym].candles.length} candles loaded`);
    return;
  }
  // tick history fallback
  if (d.history && d.history.prices) {
    markets[sym].candles = d.history.prices.map((p, i) => ({
      open: p, high: p, low: p, close: p, time: d.history.times[i]
    }));
  }
}

function handleTick(tick) {
  const m = markets[tick.symbol];
  if (!m) return;
  m.price = parseFloat(tick.quote);
  if (m.candles.length > 0) {
    const last = m.candles[m.candles.length - 1];
    last.close = m.price;
    if (m.price > last.high) last.high = m.price;
    if (m.price < last.low)  last.low  = m.price;
  }
}

function runScan() {
  if (!running) return;

  const openCount = Object.keys(openPositions).length;
  if (openCount >= CONFIG.MAX_OPEN) {
    log(`⏳ Max positions open (${openCount}/${CONFIG.MAX_OPEN}) — waiting`, 'info');
    return;
  }
  if (dailyLoss >= CONFIG.MAX_DAILY_LOSS) {
    log(`🛑 Daily loss limit $${CONFIG.MAX_DAILY_LOSS} reached — stopping bot`, 'warn');
    stopBot();
    return;
  }

  log(`🔍 Scanning ${ALL_MARKETS.length} markets…`);

  let bestSym = null, bestResult = null, bestScore = 0;
  ALL_MARKETS.forEach(({ sym }) => {
    const result = analyzeMarket(sym);
    markets[sym].signal = result;
    markets[sym].score  = result.score;
    if (result.fire && result.score > bestScore) {
      bestScore  = result.score;
      bestSym    = sym;
      bestResult = result;
    }
  });

  if (bestSym && bestResult) {
    const mkt = ALL_MARKETS.find(x => x.sym === bestSym);
    log(`🤖 BEST: ${mkt.label} · ${bestResult.dir} · Conf: ${bestResult.score100}%`, 'ai');
    placeTrade(bestSym, bestResult);
  } else {
    log(`⏸ No signal above ${CONFIG.MIN_SCORE}% (best: ${Math.round(bestScore)}%) — waiting`, 'info');
  }
}

function placeTrade(sym, result) {
  if (!running || !ws) return;

  const now = Date.now();
  if (symLastTrade[sym] && (now - symLastTrade[sym]) < CONFIG.SYM_COOLDOWN * 1000) {
    const wait = Math.round((CONFIG.SYM_COOLDOWN * 1000 - (now - symLastTrade[sym])) / 1000);
    log(`⏱ ${sym} cooldown — ${wait}s left`, 'info');
    return;
  }

  const mkt          = ALL_MARKETS.find(x => x.sym === sym);
  const pip          = mkt.pip;
  const price        = result.price;
  const contractType = result.dir === 'BUY' ? 'MULTUP' : 'MULTDOWN';
  const slAmt = parseFloat(Math.max(0.50,
    CONFIG.STAKE * CONFIG.MULTIPLIER * (CONFIG.SL_PIPS * pip / price)).toFixed(2));
  const tpAmt = parseFloat(Math.max(0.50,
    CONFIG.STAKE * CONFIG.MULTIPLIER * (CONFIG.TP_PIPS * pip / price)).toFixed(2));

  pendingProposals[sym] = { result, contractType };
  symLastTrade[sym] = now;

  const req = {
    proposal: 1,
    contract_type: contractType,
    symbol: sym,
    amount: CONFIG.STAKE,
    basis: 'stake',
    currency: accountCurrency,
    multiplier: CONFIG.MULTIPLIER,
    limit_order: { stop_loss: slAmt, take_profit: tpAmt }
  };

  log(`📡 Quote: ${contractType} · ${mkt.label} · $${CONFIG.STAKE} x${CONFIG.MULTIPLIER} · SL:$${slAmt} TP:$${tpAmt}`, result.dir === 'BUY' ? 'buy' : 'sell');
  ws.send(JSON.stringify(req));
}

function handleProposal(d) {
  if (!d.proposal || !d.proposal.id) return;
  const sym     = d.echo_req && d.echo_req.symbol;
  const pending = sym ? pendingProposals[sym] : null;
  if (!pending || !running) return;
  log(`📤 Buying at $${d.proposal.ask_price} · ${sym.replace('frx','')}`, pending.result.dir === 'BUY' ? 'buy' : 'sell');
  ws.send(JSON.stringify({ buy: d.proposal.id, price: d.proposal.ask_price }));
  delete pendingProposals[sym];
}

function handleBuy(buy) {
  if (!buy) return;
  const cid = buy.contract_id;
  const sc  = buy.shortcode || '';
  const sym = ALL_MARKETS.find(m => sc.includes(m.sym) || sc.includes(m.sym.replace('frx','')));
  const isUp = sc.includes('MULTUP');
  openPositions[cid] = {
    sym:       sym ? sym.sym : 'unknown',
    label:     sym ? sym.label : '?',
    dir:       isUp ? 'BUY' : 'SELL',
    openPrice: parseFloat(buy.buy_price || 0),
    openTime:  new Date().toISOString(),
    pnl:       0
  };
  log(`✅ Position open · ${isUp?'MULTUP':'MULTDOWN'} · ${sym?sym.label:'?'} · ID:${cid}`, 'buy');
  ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 }));
}

function handleContractUpdate(c) {
  if (!c || !c.is_sold) return;
  const profit = parseFloat(c.profit || 0);
  const pos    = openPositions[c.contract_id];
  pnl       += profit;
  dailyLoss  = Math.min(0, pnl);
  profit > 0 ? wins++ : losses++;
  if (pos) {
    profit > 0 ? markets[pos.sym].wins++ : markets[pos.sym].losses++;
  }
  log(`💰 ${profit >= 0 ? 'WIN' : 'LOSS'} ${(profit>=0?'+':'')}${profit.toFixed(2)} ${accountCurrency} · P&L: ${(pnl>=0?'+':'')}${pnl.toFixed(2)}`, profit >= 0 ? 'win' : 'loss');
  delete openPositions[c.contract_id];
}

function stopBot() {
  running = false;
  if (scanTimer)      clearInterval(scanTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  pendingProposals = {};
  if (ws) ws.close();
  log(`⏹ Bot stopped · P&L: ${(pnl>=0?'+':'')}${pnl.toFixed(2)} · W:${wins} L:${losses}`);
}

/* ════════════════════════════════════════════════════════
   EXPRESS WEB DASHBOARD
   ════════════════════════════════════════════════════════ */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API: status ────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const wr = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '—';
  res.json({
    running,
    balance:   balance.toFixed(2),
    currency:  accountCurrency,
    pnl:       pnl.toFixed(2),
    wins, losses,
    winRate:   wr,
    openCount: Object.keys(openPositions).length,
    uptime:    startTime ? Math.round((Date.now() - startTime) / 1000) : 0,
    config:    { stake: CONFIG.STAKE, multiplier: CONFIG.MULTIPLIER, slPips: CONFIG.SL_PIPS, tpPips: CONFIG.TP_PIPS, minScore: CONFIG.MIN_SCORE },
    markets: ALL_MARKETS.map(({ sym, label }) => ({
      sym, label,
      price:  markets[sym].price,
      score:  Math.round(markets[sym].score || 0),
      dir:    markets[sym].signal ? markets[sym].signal.dir : 'NONE',
      wins:   markets[sym].wins,
      losses: markets[sym].losses,
    })),
    positions: Object.entries(openPositions).map(([cid, p]) => ({ cid, ...p })),
    logs: tradeLogs.slice(0, 50),
  });
});

// ── API: start/stop ────────────────────────────────────
app.post('/api/start', (req, res) => {
  if (running) return res.json({ ok: false, msg: 'Already running' });
  if (req.body.token) CONFIG.DERIV_TOKEN = req.body.token;
  if (req.body.stake)    CONFIG.STAKE    = parseFloat(req.body.stake);
  if (req.body.slPips)   CONFIG.SL_PIPS  = parseFloat(req.body.slPips);
  if (req.body.tpPips)   CONFIG.TP_PIPS  = parseFloat(req.body.tpPips);
  if (req.body.maxLoss)  CONFIG.MAX_DAILY_LOSS = parseFloat(req.body.maxLoss);
  pnl = 0; wins = 0; losses = 0; dailyLoss = 0; openPositions = {};
  connect();
  res.json({ ok: true, msg: 'Bot starting…' });
});

app.post('/api/stop', (req, res) => {
  stopBot();
  res.json({ ok: true, msg: 'Bot stopped' });
});

app.post('/api/close-all', (req, res) => {
  if (!ws) return res.json({ ok: false, msg: 'Not connected' });
  Object.keys(openPositions).forEach(cid => ws.send(JSON.stringify({ sell: cid, price: 0 })));
  res.json({ ok: true, msg: 'Closing all positions' });
});

app.listen(CONFIG.PORT, () => {
  log(`🌐 Dashboard running at http://localhost:${CONFIG.PORT}`);
  // Auto-start if token is set via env var
  if (CONFIG.DERIV_TOKEN) {
    log('🔑 Token found in env — auto-starting bot…');
    setTimeout(connect, 1000);
  } else {
    log('💡 No DERIV_TOKEN env var — use the dashboard to enter your token and start');
  }
});

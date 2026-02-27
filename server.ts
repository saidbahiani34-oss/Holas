import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";

const SETTINGS_FILE = path.join(process.cwd(), "telegram-settings.json");
const STATE_FILE = path.join(process.cwd(), "bot-state.json");

let savedSettings = { token: '', chatId: '' };
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    savedSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  }
} catch (e) {
  console.error("Failed to load settings file", e);
}

interface Signal {
  id: string;
  traderName: string;
  successRate: string;
  time: string;
  pair: { base: string; quote: string };
  action: 'buy' | 'sell';
  entry: string;
  stopLoss: string;
  takeProfits: { t1: string; t2: string; t3: string };
  analysis: string;
}

let botState = {
  signals: [] as Signal[],
  prices: {} as Record<string, number>,
  signalStatus: {} as Record<string, 'active' | 't1' | 't2' | 't3' | 'sl'>,
  traderStats: {
    'RSI Oversold (1h)': { wins: 0, total: 0 },
    'Volume Breakout (1h)': { wins: 0, total: 0 },
    'PlanB': { wins: 10, total: 12 },
    'Michaël van de Poppe': { wins: 8, total: 10 },
    'Crypto Rover': { wins: 15, total: 20 },
    'Ash Crypto': { wins: 9, total: 11 },
    'Doctor Profit': { wins: 18, total: 20 }
  },
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || savedSettings.token || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || savedSettings.chatId || '',
  isLive: true,
};

// Load state from file if it exists
try {
  if (fs.existsSync(STATE_FILE)) {
    const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (savedState.signals) botState.signals = savedState.signals;
    if (savedState.signalStatus) botState.signalStatus = savedState.signalStatus;
    if (savedState.traderStats) {
      botState.traderStats = { ...botState.traderStats, ...savedState.traderStats };
    }
  }
} catch (e) {
  console.error("Failed to load state file", e);
}

const saveState = () => {
  try {
    const stateToSave = {
      signals: botState.signals,
      signalStatus: botState.signalStatus,
      traderStats: botState.traderStats
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateToSave));
  } catch (e) {
    console.error("Failed to save state file", e);
  }
};

const sendToTelegram = async (message: string) => {
  const { telegramToken, telegramChatId } = botState;
  if (!telegramToken || !telegramChatId) {
    console.log("Telegram credentials not set, skipping message:", message);
    return;
  }
  try {
    console.log("Sending message to Telegram...");
    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId, text: message, parse_mode: "HTML" }),
    });
    const data = await response.json() as any;
    if (!response.ok) {
      console.warn(`Telegram API Error (${data.error_code}): ${data.description}`);
    } else {
      console.log("Telegram message sent successfully!");
    }
  } catch (err) {
    console.warn("Telegram send error:", err);
  }
};

const calculateRSI = (closes: number[], period = 14) => {
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const fetchLiveSignals = async () => {
  if (!botState.isLive) return;
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/24hr');
    if (!response.ok) {
        throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as any[];
    
    // Filter top volume pairs
    const excludedCoins = ['USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'EUR', 'USDE', 'AEUR', 'DAI', 'USDD', 'PYUSD', 'SHIB', 'PEPE'];
    const usdtPairs = data.filter((t: any) => {
      const baseCoin = t.symbol.replace('USDT', '');
      return t.symbol.endsWith('USDT') && 
        parseFloat(t.lastPrice) > 0 &&
        parseFloat(t.quoteVolume) > 2000000 && // High volume only
        !t.symbol.includes('UP') && 
        !t.symbol.includes('DOWN') && 
        !t.symbol.includes('BULL') && 
        !t.symbol.includes('BEAR') &&
        !excludedCoins.includes(baseCoin);
    }).sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 150); // Top 150 for deeper analysis

    const newSignals: Signal[] = [];

    for (const ticker of usdtPairs) {
      try {
        // Fetch 1h klines for technical analysis
        const klinesRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${ticker.symbol}&interval=1h&limit=24`);
        if (!klinesRes.ok) continue;
        const klines = await klinesRes.json() as any[];
        
        const closes = klines.map(k => parseFloat(k[4]));
        const volumes = klines.map(k => parseFloat(k[5]));
        
        const currentPrice = closes[closes.length - 1];
        const previousPrice = closes[closes.length - 2];
        const priceChange = ((currentPrice - previousPrice) / previousPrice) * 100;
        const rsi = calculateRSI(closes);
        
        const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
        const currentVolume = volumes[volumes.length - 1];
        const volumeSpike = currentVolume > avgVolume * 2.0;

        let strategyName = '';
        let analysisText = '';
        let action: 'buy' | 'sell' = 'buy';

        if (rsi < 35) {
          strategyName = 'RSI Oversold (1h)';
          analysisText = `مؤشر القوة النسبية (RSI) وصل إلى ${rsi.toFixed(2)} مما يدل على تشبع بيعي قوي وفرصة ارتداد محتملة.`;
          action = 'buy';
        } else if (volumeSpike && rsi < 65 && priceChange > 2.0) {
          strategyName = 'Volume Breakout (1h)';
          analysisText = `تم رصد انفجار في حجم التداول (Volume) أعلى من المتوسط بـ 200% مع صعود بنسبة ${priceChange.toFixed(2)}%.`;
          action = 'buy';
        } else if (priceChange > 4.0 && currentVolume > avgVolume * 2.0) {
          strategyName = 'Momentum Surge (1h)';
          analysisText = `زخم صعودي قوي! السعر ارتفع بنسبة ${priceChange.toFixed(2)}% مع سيولة عالية.`;
          action = 'buy';
        }

        if (strategyName) {
          const entry = currentPrice;
          const sl = currentPrice * 0.985; // 1.5% stop loss
          const t1 = currentPrice * 1.012; // 1.20% target
          const t2 = currentPrice * 1.02; // 2% target
          const t3 = currentPrice * 1.035; // 3.5% target

          const formatPrice = (p: number) => {
            if (p < 0.01) return p.toFixed(6);
            if (p < 1) return p.toFixed(4);
            return p.toFixed(2);
          };

          const now = new Date();
          const timeString = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

          const stats = botState.traderStats[strategyName] || { wins: 0, total: 0 };
          const successRate = stats.total > 0 ? Math.round((stats.wins / stats.total) * 100) + '%' : '0%';

          const baseCoin = ticker.symbol.replace('USDT', '');
          
          // Check if we already have an active signal for this coin
          const activeSignalForCoin = botState.signals.find(s => 
            s.pair.base === baseCoin && 
            ['active', 't1', 't2'].includes(botState.signalStatus[s.id] || 'active')
          );
          
          // Check if we had a signal for this coin recently (1 hour cooldown)
          const lastSignalForCoin = botState.signals.find(s => s.pair.base === baseCoin);
          let isRecent = false;
          if (lastSignalForCoin) {
            const timestamp = parseInt(lastSignalForCoin.id.split('-')[1]);
            if (!isNaN(timestamp) && (Date.now() - timestamp) < 60 * 60 * 1000) {
              isRecent = true;
            }
          }
          
          if (!activeSignalForCoin && !isRecent) {
            const signalId = `${ticker.symbol}-${Date.now()}`;
            newSignals.push({
              id: signalId,
              traderName: strategyName,
              successRate,
              time: timeString,
              pair: { base: baseCoin, quote: 'USDT' },
              action,
              entry: formatPrice(entry),
              stopLoss: formatPrice(sl),
              takeProfits: { t1: formatPrice(t1), t2: formatPrice(t2), t3: formatPrice(t3) },
              analysis: analysisText
            });
          }
        }
      } catch (e) {
        console.error(`Error analyzing ${ticker.symbol}`, e);
      }
    }

    // Send new signals to Telegram
    newSignals.forEach(signal => {
      // Add to bot state
      botState.signals.unshift(signal);
      botState.signalStatus[signal.id] = 'active';
      
      const msg = `🚀 <b>توصية جديدة من ${signal.traderName}</b>\n\n` +
        `الزوج: #${signal.pair.base}_${signal.pair.quote}\n` +
        `النوع: ${signal.action === 'buy' ? 'شراء 🟢' : 'بيع 🔴'}\n` +
        `الدخول: ${signal.entry}\n\n` +
        `الأهداف:\n` +
        `🎯 T1: ${signal.takeProfits.t1}\n` +
        `🎯 T2: ${signal.takeProfits.t2}\n` +
        `🎯 T3: ${signal.takeProfits.t3}\n\n` +
        `🛑 وقف الخسارة: ${signal.stopLoss}\n\n` +
        `📊 التحليل: ${signal.analysis}`;
        
      sendToTelegram(msg);
    });
    
    if (newSignals.length > 0) {
      saveState();
    }

  } catch (error: any) {
    console.error("Failed to fetch live signals:", error.message || error);
  }
};

const checkPrices = async () => {
  if (!botState.isLive || botState.signals.length === 0) return;
  try {
    const symbols = [...new Set(botState.signals.map(s => `"${s.pair.base}${s.pair.quote}"`))].join(',');
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=[${symbols}]`);
    if (!response.ok) {
        throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as any[];
    
    data.forEach((item: any) => {
      botState.prices[item.symbol] = parseFloat(item.price);
    });

    botState.signals.forEach(signal => {
      const symbol = `${signal.pair.base}${signal.pair.quote}`;
      const currentPrice = botState.prices[symbol];
      if (!currentPrice) return;

      const status = botState.signalStatus[signal.id] || 'active';
      if (status === 't3' || status === 'sl') return;

      let newStatus: 'active' | 't1' | 't2' | 't3' | 'sl' = status;
      let message = '';

      const t1 = parseFloat(signal.takeProfits.t1);
      const t2 = parseFloat(signal.takeProfits.t2);
      const t3 = parseFloat(signal.takeProfits.t3);
      const sl = parseFloat(signal.stopLoss);

      if (signal.action === 'buy') {
        if (currentPrice <= sl) {
          newStatus = 'sl';
          message = `🛑 <b>ضرب وقف الخسارة</b>\nالزوج: #${signal.pair.base}\nالسعر الحالي: ${currentPrice}\nالمتداول: ${signal.traderName}`;
        } else if (currentPrice >= t3) {
          newStatus = 't3';
          message = `🎯🎯🎯 <b>تحقق الهدف الثالث!</b>\nالزوج: #${signal.pair.base}\nالسعر الحالي: ${currentPrice}\nالمتداول: ${signal.traderName}`;
        } else if (currentPrice >= t2 && status !== 't2') {
          newStatus = 't2';
          message = `🎯🎯 <b>تحقق الهدف الثاني!</b>\nالزوج: #${signal.pair.base}\nالسعر الحالي: ${currentPrice}\nالمتداول: ${signal.traderName}`;
        } else if (currentPrice >= t1 && status === 'active') {
          newStatus = 't1';
          message = `🎯 <b>تحقق الهدف الأول!</b>\nالزوج: #${signal.pair.base}\nالسعر الحالي: ${currentPrice}\nالمتداول: ${signal.traderName}`;
        }
      }

      if (newStatus !== status) {
        botState.signalStatus[signal.id] = newStatus;
        
        if (message) {
          sendToTelegram(message);
        }
        
        if (newStatus === 't1' || newStatus === 'sl') {
          const isWin = newStatus === 't1';
          const currentStats = botState.traderStats[signal.traderName as keyof typeof botState.traderStats] || { wins: 0, total: 0 };
          botState.traderStats[signal.traderName as keyof typeof botState.traderStats] = {
            wins: currentStats.wins + (isWin ? 1 : 0),
            total: currentStats.total + 1
          };
        }
        
        saveState();
      }
    });
  } catch (error) {
    console.error("Failed to check prices", error);
  }
};

// Start background loops
setInterval(fetchLiveSignals, 1 * 60 * 1000); // Every 1 minute
setInterval(checkPrices, 10 * 1000); // Every 10 seconds
// Initial fetch
setTimeout(fetchLiveSignals, 2000);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // API to get bot state
  app.get("/api/state", (req, res) => {
    console.log("GET /api/state called");
    res.json(botState);
  });

  app.get("/api/test", (req, res) => {
    res.json({ status: "ok", message: "Server is running latest code" });
  });

  // API to update settings
  app.post("/api/settings", (req, res) => {
    const { token, chatId } = req.body;
    if (token !== undefined) botState.telegramToken = token;
    if (chatId !== undefined) botState.telegramChatId = chatId;
    
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ token: botState.telegramToken, chatId: botState.telegramChatId }));
    } catch (e) {
      console.error("Failed to save settings file", e);
    }
    
    res.json({ success: true });
  });

  // Manual telegram send API
  app.post("/api/telegram", async (req, res) => {
    const { message, token: reqToken, chatId: reqChatId } = req.body;
    const token = reqToken || botState.telegramToken;
    const chatId = reqChatId || botState.telegramChatId;

    if (!token || !chatId) {
      return res.status(400).json({ error: "Telegram credentials not configured." });
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      });
      
      const data = await response.json() as any;
      if (!response.ok) {
        throw new Error(data.description || "Failed to send Telegram message");
      }
      
      res.json({ success: true, data });
    } catch (error: any) {
      console.error("Telegram API Error:", error);
      res.status(500).json({ error: error.message || "Failed to send message" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    // Catch-all route to serve index.html for SPA routing
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

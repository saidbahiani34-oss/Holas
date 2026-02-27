import React, { useState, useEffect, useRef } from 'react';
import { User, Zap, ShieldAlert, Target, TrendingUp, Clock, Activity, Send, Loader2, Settings, X } from 'lucide-react';

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

export default function App() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLive, setIsLive] = useState(true);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [signalStatus, setSignalStatus] = useState<Record<string, 'active' | 't1' | 't2' | 't3' | 'sl'>>({});
  const [isSending, setIsSending] = useState<Record<string, boolean>>({});
  
  // Trader Stats State (wins and total trades)
  const [traderStats, setTraderStats] = useState<Record<string, { wins: number, total: number }>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [selectedTrader, setSelectedTrader] = useState<string>('all');
  
  const telegramSettingsRef = useRef({ token: '', chatId: '' });
  const sentSignalsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Load saved settings on mount
    const savedToken = localStorage.getItem('telegramToken');
    const savedChatId = localStorage.getItem('telegramChatId');
    if (savedToken) {
      setTelegramToken(savedToken);
      telegramSettingsRef.current.token = savedToken;
    }
    if (savedChatId) {
      setTelegramChatId(savedChatId);
      telegramSettingsRef.current.chatId = savedChatId;
    }
  }, []);

  const saveSettings = async () => {
    localStorage.setItem('telegramToken', telegramToken);
    localStorage.setItem('telegramChatId', telegramChatId);
    telegramSettingsRef.current = { token: telegramToken, chatId: telegramChatId };
    
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: telegramToken, chatId: telegramChatId })
      });
    } catch (error) {
      console.error('Failed to save settings to server', error);
    }
    
    setShowSettings(false);
  };

  useEffect(() => {
    const fetchState = async () => {
      try {
        const response = await fetch('/api/state');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const text = await response.text();
        
        // Handle case where Vite serves index.html instead of the API response
        if (text.trim().toLowerCase().startsWith('<!doctype') || text.includes('<html')) {
          console.warn("Received HTML instead of JSON from /api/state. Server might be restarting.");
          return;
        }
        
        try {
          const data = JSON.parse(text);
          setSignals(data.signals || []);
          setPrices(data.prices || {});
          setSignalStatus(data.signalStatus || {});
          setTraderStats(data.traderStats || {});
          
          setIsLoading(false);
        } catch (e) {
          console.error("Failed to parse JSON response:", text.substring(0, 100) + "...");
          throw e;
        }
      } catch (error) {
        console.warn("Could not fetch bot state (server might be restarting):", error);
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const sendToTelegram = async (message: string) => {
    const token = telegramSettingsRef.current.token || telegramToken;
    const chatId = telegramSettingsRef.current.chatId || telegramChatId;
    
    if (!token || !chatId) return;
    
    try {
      await fetch('/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message,
          token,
          chatId
        })
      });
    } catch (error) {
      console.error('Failed to send telegram message', error);
    }
  };

  const shareSignal = async (signal: Signal) => {
    setIsSending(prev => ({ ...prev, [signal.id]: true }));
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
      
    await sendToTelegram(msg);
    setIsSending(prev => ({ ...prev, [signal.id]: false }));
  };

  // Binance WebSocket for real-time prices
  useEffect(() => {
    if (signals.length === 0) return;
    
    const streams = signals.map(s => `${s.pair.base.toLowerCase()}${s.pair.quote.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${streams}`);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.s && data.c) {
        setPrices(prev => ({ ...prev, [data.s]: parseFloat(data.c) }));
      }
    };

    return () => ws.close();
  }, [signals]);

  // Check prices against targets is now handled by the server
  // We just need to render the state

  // Simulate live updates (just blinking the live indicator)
  useEffect(() => {
    const interval = setInterval(() => {
      setIsLive(prev => !prev);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const globalStats = (Object.values(traderStats) as { wins: number, total: number }[]).reduce((acc, curr) => {
    return { wins: acc.wins + curr.wins, total: acc.total + curr.total };
  }, { wins: 0, total: 0 });
  const globalSuccessRate = globalStats.total > 0 ? Math.round((globalStats.wins / globalStats.total) * 100) : 0;

  const uniqueTraders = Array.from(new Set(signals.map(s => s.traderName)));
  const filteredSignals = selectedTrader === 'all' 
    ? signals 
    : signals.filter(s => s.traderName === selectedTrader);

  return (
    <div className="min-h-screen bg-[#0B0E14] text-slate-300 font-sans p-4 md:p-6 flex justify-center" dir="rtl">
      <div className="w-full max-w-2xl space-y-6">
        
        {/* Header */}
        <header className="flex flex-col items-center justify-center gap-2 border-b border-slate-800/60 pb-6 pt-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-yellow-500/10 border border-yellow-500/20">
              <Activity className="w-5 h-5 text-yellow-500" />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-white tracking-wide">بث التحليل الفني</h1>
              <p className="text-slate-400 text-sm font-mono tracking-widest uppercase mt-1">ALGORITHMIC SIGNALS</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 mt-2 bg-slate-900/80 px-4 py-1.5 rounded-full border border-slate-800">
            <span className="relative flex h-2.5 w-2.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 ${isLive ? 'block' : 'hidden'}`}></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
            </span>
            <span className="text-xs text-slate-300 font-medium">إيقاف البث</span>
          </div>
          
          <button 
            onClick={() => setShowSettings(true)}
            className="absolute top-4 left-4 p-2 bg-slate-800/50 hover:bg-slate-800 rounded-full border border-slate-700/50 transition-colors"
            title="إعدادات تيليجرام"
          >
            <Settings className="w-5 h-5 text-slate-400" />
          </button>
        </header>

        {/* Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-[#181B22] border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl relative">
              <button 
                onClick={() => setShowSettings(false)}
                className="absolute top-4 left-4 p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
              
              <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                <Send className="w-5 h-5 text-[#2A82DA]" />
                إعدادات تيليجرام
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">
                    توكن البوت (Bot Token)
                  </label>
                  <input 
                    type="text" 
                    value={telegramToken}
                    onChange={(e) => setTelegramToken(e.target.value)}
                    placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                    className="w-full bg-[#0B0E14] border border-slate-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#2A82DA] transition-colors"
                    dir="ltr"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">
                    معرف المحادثة (Chat ID)
                  </label>
                  <input 
                    type="text" 
                    value={telegramChatId}
                    onChange={(e) => setTelegramChatId(e.target.value)}
                    placeholder="-1001234567890"
                    className="w-full bg-[#0B0E14] border border-slate-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#2A82DA] transition-colors"
                    dir="ltr"
                  />
                </div>
                
                <button 
                  onClick={saveSettings}
                  className="w-full bg-[#2A82DA] hover:bg-[#2A82DA]/90 text-white font-medium py-2.5 rounded-xl transition-colors mt-2"
                >
                  حفظ الإعدادات
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Stats & Filter */}
        {!isLoading && (
          <div className="flex flex-col md:flex-row justify-between items-center gap-4 bg-[#181B22] p-5 rounded-2xl border border-slate-800/80 shadow-xl mb-6">
            <div className="flex items-center gap-6 w-full md:w-auto justify-around md:justify-start">
              <div className="text-center">
                <p className="text-xs text-slate-400 mb-1">إجمالي الصفقات</p>
                <p className="text-2xl font-bold text-white font-mono">{globalStats.total}</p>
              </div>
              <div className="w-px h-10 bg-slate-800"></div>
              <div className="text-center">
                <p className="text-xs text-slate-400 mb-1">الصفقات الناجحة</p>
                <p className="text-2xl font-bold text-emerald-400 font-mono">{globalStats.wins}</p>
              </div>
              <div className="w-px h-10 bg-slate-800"></div>
              <div className="text-center">
                <p className="text-xs text-slate-400 mb-1">نسبة النجاح</p>
                <p className="text-2xl font-bold text-[#2A82DA] font-mono">{globalSuccessRate}%</p>
              </div>
            </div>
            
            <div className="w-full md:w-auto">
              <select 
                value={selectedTrader}
                onChange={(e) => setSelectedTrader(e.target.value)}
                className="w-full md:w-56 bg-[#0B0E14] border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#2A82DA] transition-colors appearance-none cursor-pointer"
                style={{ backgroundImage: 'url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%2394a3b8%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'left 1rem center', backgroundSize: '0.65em auto' }}
              >
                <option value="all">جميع الاستراتيجيات</option>
                {uniqueTraders.map(trader => (
                  <option key={trader} value={trader}>{trader}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Signals Feed */}
        <div className="space-y-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
              <p className="text-slate-400">جاري جلب أحدث التوصيات الحية...</p>
            </div>
          ) : filteredSignals.map((signal) => (
            <div key={signal.id} className="bg-[#181B22] border border-slate-800/80 rounded-[24px] p-5 shadow-xl transition-all hover:border-slate-700">
              
              {/* Card Header */}
              <div className="flex justify-between items-start mb-6">
                <div className="flex flex-col gap-3">
                  {/* Pair Badge */}
                  <div className="inline-flex items-center gap-1.5 bg-[#222630] px-3 py-1.5 rounded-full border border-slate-700/50 w-fit">
                    <span className="text-xs text-slate-400 font-mono">{signal.pair.quote}/</span>
                    <span className="text-sm font-bold text-white font-mono">{signal.pair.base}</span>
                  </div>
                  
                  {/* Trader Info */}
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                    <span className="font-bold text-white text-lg">{signal.traderName}</span>
                    <span className="bg-emerald-500/10 text-emerald-400 text-xs px-2 py-0.5 rounded-full border border-emerald-500/20 font-medium">
                      نسبة النجاح: {signal.successRate}
                    </span>
                  </div>
                  
                  {/* Time */}
                  <div className="flex items-center gap-1.5 text-slate-500 text-xs">
                    <Clock className="w-3.5 h-3.5" />
                    <span dir="ltr">{signal.time}</span>
                  </div>
                </div>

                <div className="flex flex-col items-end gap-3">
                  {/* User Avatar */}
                  <div className="w-12 h-12 rounded-full bg-[#222630] border border-slate-700/50 flex items-center justify-center">
                    <User className="w-6 h-6 text-slate-400" />
                  </div>
                  
                  {/* Action Badge */}
                  <div className={`border px-4 py-1.5 rounded-lg flex items-center gap-1.5 font-bold text-sm ${signal.action === 'buy' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
                    <span>{signal.action === 'buy' ? 'شراء' : 'بيع'}</span>
                    <TrendingUp className={`w-4 h-4 ${signal.action === 'sell' && 'rotate-180'}`} />
                  </div>
                  
                  {/* Share to Telegram Button */}
                  <button 
                    onClick={() => shareSignal(signal)}
                    disabled={isSending[signal.id]}
                    className="flex items-center gap-1.5 text-xs bg-[#2A82DA]/10 text-[#2A82DA] border border-[#2A82DA]/30 px-3 py-1.5 rounded-lg hover:bg-[#2A82DA]/20 transition-colors disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{isSending[signal.id] ? 'جاري الإرسال...' : 'إرسال لتيليجرام'}</span>
                  </button>
                </div>
              </div>

              {/* Entry & Stop Loss Grid */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                {/* Stop Loss */}
                <div className={`border rounded-2xl p-4 flex flex-col items-center justify-center gap-2 transition-colors ${signalStatus[signal.id] === 'sl' ? 'bg-red-500/20 border-red-500/50' : 'bg-[#2A1E22] border-[#4A2A2E]'}`}>
                  <div className="flex items-center gap-1.5 text-[#FF6B6B] text-sm font-medium">
                    <ShieldAlert className="w-4 h-4" />
                    <span>وقف الخسارة</span>
                  </div>
                  <div className="text-[#FF6B6B] text-2xl font-bold font-mono tracking-wider">
                    {signal.stopLoss}
                  </div>
                </div>

                {/* Entry */}
                <div className="bg-[#1E222B] border border-slate-700/50 rounded-2xl p-4 flex flex-col items-center justify-center gap-2">
                  <div className="flex items-center gap-1.5 text-slate-300 text-sm font-medium">
                    <Target className="w-4 h-4" />
                    <span>الدخول</span>
                  </div>
                  <div className="text-white text-2xl font-bold font-mono tracking-wider">
                    {signal.entry}
                  </div>
                  {prices[`${signal.pair.base}${signal.pair.quote}`] && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-400">السعر الحالي:</span>
                      <span className={`text-sm font-bold font-mono ${
                        prices[`${signal.pair.base}${signal.pair.quote}`] > parseFloat(signal.entry) 
                          ? 'text-emerald-400' 
                          : prices[`${signal.pair.base}${signal.pair.quote}`] < parseFloat(signal.entry)
                            ? 'text-red-400'
                            : 'text-slate-300'
                      }`}>
                        {prices[`${signal.pair.base}${signal.pair.quote}`].toFixed(
                          parseFloat(signal.entry) < 0.01 ? 6 : parseFloat(signal.entry) < 1 ? 4 : 2
                        )}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Take Profit Section */}
              <div className="bg-[#1E222B] border border-slate-700/50 rounded-2xl p-5 mb-5">
                <div className="flex items-center justify-center gap-2 text-slate-300 text-sm font-medium mb-4">
                  <TrendingUp className="w-4 h-4" />
                  <span>الأهداف (Take Profit)</span>
                </div>
                
                <div className="flex flex-wrap justify-center gap-3">
                  <div className={`border px-4 py-2 rounded-xl flex items-center gap-2 transition-colors ${['t1', 't2', 't3'].includes(signalStatus[signal.id] || '') ? 'bg-emerald-500/20 border-emerald-500/50' : 'bg-[#1A2C26] border-[#2A4A3E]'}`}>
                    <span className="text-emerald-400 font-bold font-mono text-lg">{signal.takeProfits.t1}</span>
                    <span className="text-emerald-500/70 text-xs font-bold">T1</span>
                  </div>
                  <div className={`border px-4 py-2 rounded-xl flex items-center gap-2 transition-colors ${['t2', 't3'].includes(signalStatus[signal.id] || '') ? 'bg-emerald-500/20 border-emerald-500/50' : 'bg-[#1A2C26] border-[#2A4A3E]'}`}>
                    <span className="text-emerald-400 font-bold font-mono text-lg">{signal.takeProfits.t2}</span>
                    <span className="text-emerald-500/70 text-xs font-bold">T2</span>
                  </div>
                  <div className={`border px-4 py-2 rounded-xl flex items-center gap-2 transition-colors ${signalStatus[signal.id] === 't3' ? 'bg-emerald-500/20 border-emerald-500/50' : 'bg-[#1A2C26] border-[#2A4A3E]'}`}>
                    <span className="text-emerald-400 font-bold font-mono text-lg">{signal.takeProfits.t3}</span>
                    <span className="text-emerald-500/70 text-xs font-bold">T3</span>
                  </div>
                </div>
              </div>

              {/* Analysis Text */}
              <div className="text-slate-400 text-sm leading-relaxed border-t border-slate-800/80 pt-4">
                {signal.analysis}
              </div>

            </div>
          ))}
        </div>

      </div>
    </div>
  );
}

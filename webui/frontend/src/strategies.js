// Strategy engine: 12 well-known rule-based trading strategies evaluated
// client-side on the OHLCV bars already fetched for the chart.
//
// Each strategy returns historical entry EVENTS (crossings/breakouts with
// entry/SL/TP computed at that bar) plus a human-readable STATE snapshot.
// analyze() adds freshness, a confluence-based strength score and a quick
// first-touch backtest (TP1 vs SL) over the loaded history.

import {
  smaArr,
  emaArr,
  rsiArr,
  atrArr,
  ichimokuArr,
  supertrendArr,
  donchianArr,
  adxArr,
  technicalRating,
  heikinAshi,
  resampleBars,
} from "./indicators.js";

// ---- shared math helpers ----

const closes = (bars) => bars.map((b) => b.close);

const crossUp = (a, b, i) =>
  a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null &&
  a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDown = (a, b, i) =>
  a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null &&
  a[i - 1] >= b[i - 1] && a[i] < b[i];

function bollArr(bars, period = 20, mult = 2) {
  const c = closes(bars);
  const mid = smaArr(c, period);
  const n = bars.length;
  const upper = new Array(n).fill(null), lower = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

function macdArrs(bars, fast = 12, slow = 26, signalP = 9) {
  const c = closes(bars);
  const f = emaArr(c, fast), s = emaArr(c, slow);
  const macd = c.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const first = macd.findIndex((v) => v != null);
  const sigTail = first >= 0 ? emaArr(macd.slice(first), signalP) : [];
  const signal = macd.map((_, i) =>
    i >= first && first >= 0 && i - first >= signalP - 1 ? sigTail[i - first] : null);
  return { macd, signal };
}

function stochArrs(bars, period = 14, smooth = 3) {
  const n = bars.length;
  const kRaw = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    kRaw[i] = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
  }
  const k = smaArr(kRaw.map((v) => v ?? 0), smooth).map((v, i) => (kRaw[i] == null ? null : v));
  const d = smaArr(k.map((v) => v ?? 0), smooth).map((v, i) => (k[i] == null ? null : v));
  return { k, d };
}

function vwapArr(bars, intraday) {
  const n = bars.length;
  const out = new Array(n).fill(null);
  let pv = 0, vol = 0, day = null;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const d = intraday ? Math.floor(b.time / 86400) : null;
    if (intraday && d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typ = (b.high + b.low + b.close) / 3;
    pv += typ * b.volume;
    vol += b.volume;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}

/** ATR-anchored level block for an event at bar i. */
function atrLevels(dir, entry, a, slM = 1.5, tp1M = 1.5, tp2M = 3) {
  const s = dir === "BUY" ? -1 : 1;
  return {
    entry,
    sl: entry + s * slM * a,
    tp1: entry - s * tp1M * a,
    tp2: entry - s * tp2M * a,
  };
}

const ev = (bars, i, dir, levels) => ({ i, time: bars[i].time, dir, ...levels });

// Bilingual reason line.
const r = (fa, en) => ({ fa, en });

// ---- strategy catalog ----
// category: trend | momentum | reversal | breakout | scalp
// risk: 1 (محافظه‌کار) … 3 (تهاجمی)

export const STRATEGIES = [
  {
    id: "golden-cross",
    icon: "✨",
    category: "trend",
    risk: 1,
    tfs: ["1d", "1wk"],
    defaultTf: "1d",
    minBars: 210,
    meta: {
      fa: {
        name: "تقاطع طلایی (SMA 50/200)",
        tagline: "کلاسیک‌ترین سیگنال روند بلندمدت در تاریخ بازارها",
        desc:
          "وقتی میانگین متحرک ۵۰ روزه از روی ۲۰۰ روزه به بالا عبور کند «تقاطع طلایی» و شروع روند صعودی بزرگ است؛ عبور به پایین «تقاطع مرگ» است. این استراتژی کم‌سیگنال اما بسیار معتبر است و صندوق‌های بزرگ به آن نگاه می‌کنند.",
        rules: [
          "ورود خرید: عبور SMA50 به بالای SMA200",
          "ورود فروش: عبور SMA50 به پایین SMA200 (تقاطع مرگ)",
          "حد ضرر: ۲ برابر ATR از نقطه ورود",
          "هدف‌ها: ۳ و ۵ برابر ATR — روندهای طلایی معمولاً ماه‌ها ادامه دارند",
          "تأیید: قیمت باید همان سمت SMA200 باشد",
        ],
        tips: [
          "فقط تایم روزانه و هفتگی — در تایم‌های پایین پر از سیگنال کاذب است",
          "بعد از تقاطع، اولین پولبک به SMA50 معمولاً بهترین نقطه ورود دوم است",
          "در بازارهای رنج (بدون روند) این استراتژی ضرر می‌دهد — با ADX فیلتر کن",
          "سیگنال دیر می‌آید اما سهم بزرگی از روند را می‌گیرد",
        ],
        best: "سهام، شاخص‌ها و طلا · تایم روزانه/هفتگی · افق چند ماهه",
      },
      en: {
        name: "Golden Cross (SMA 50/200)",
        tagline: "The most classic long-term trend signal in market history",
        desc:
          "When the 50-bar SMA crosses above the 200-bar SMA you get a golden cross — the start of a major uptrend; crossing below is the death cross. Few signals, but institutions watch this level religiously.",
        rules: [
          "Buy: SMA50 crosses above SMA200",
          "Sell: SMA50 crosses below SMA200 (death cross)",
          "Stop loss: 2× ATR from entry",
          "Targets: 3× and 5× ATR — golden trends often run for months",
          "Confirm: price should be on the same side of SMA200",
        ],
        tips: [
          "Daily/weekly only — lower timeframes are full of whipsaws",
          "The first pullback to SMA50 after the cross is often the best second entry",
          "It loses money in ranging markets — filter with ADX",
          "The signal is late but captures the meat of the trend",
        ],
        best: "Stocks, indices, gold · Daily/weekly · Multi-month horizon",
      },
    },
    run(bars) {
      const c = closes(bars);
      const s50 = smaArr(c, 50), s200 = smaArr(c, 200);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null) continue;
        if (crossUp(s50, s200, i))
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 2, 3, 5)));
        else if (crossDown(s50, s200, i))
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 2, 3, 5)));
      }
      const i = bars.length - 1;
      const bull = s50[i] != null && s200[i] != null && s50[i] > s200[i];
      return {
        events,
        state: {
          bias: s50[i] == null || s200[i] == null ? null : bull ? "BUY" : "SELL",
          reasons: [
            s50[i] != null && s200[i] != null
              ? bull
                ? r("SMA50 بالای SMA200 — ساختار صعودی", "SMA50 above SMA200 — bullish structure")
                : r("SMA50 زیر SMA200 — ساختار نزولی", "SMA50 below SMA200 — bearish structure")
              : r("داده کافی برای SMA200 نیست", "Not enough data for SMA200"),
            c[i] > (s200[i] ?? Infinity)
              ? r("قیمت بالای SMA200", "Price above SMA200")
              : r("قیمت زیر SMA200", "Price below SMA200"),
          ],
        },
      };
    },
  },

  {
    id: "ema-cross",
    icon: "⚡",
    category: "momentum",
    risk: 2,
    tfs: ["1m", "5m", "15m", "1h", "1d"],
    defaultTf: "1m",
    minBars: 60,
    meta: {
      fa: {
        name: "تقاطع EMA 9/21",
        tagline: "استراتژی مومنتوم محبوب تریدرهای روزانه",
        desc:
          "دو میانگین نمایی سریع؛ عبور EMA9 از EMA21 تغییر مومنتوم کوتاه‌مدت را زود نشان می‌دهد. سریع، ساده و پایه‌ی نصف استراتژی‌های اسکالپ و دی‌تریدینگ.",
        rules: [
          "ورود خرید: عبور EMA9 به بالای EMA21",
          "ورود فروش: عبور EMA9 به پایین EMA21",
          "حد ضرر: ۱.۵ برابر ATR",
          "هدف‌ها: ۱.۵ و ۳ برابر ATR",
          "خروج زودتر اگر تقاطع معکوس رخ داد",
        ],
        tips: [
          "در جهت روند تایم بالاتر بگیر (EMA200 تایم فعلی یا روند تایم ۴ برابر)",
          "بعد از یک حرکت شارپ، اولین تقاطع معمولاً معتبرتر از تقاطع‌های وسط رنج است",
          "حجم بالا هنگام تقاطع = تأیید قوی",
          "در ساعات کم‌حجم (بین سشن‌ها) سیگنال‌ها ضعیف‌اند",
        ],
        best: "فارکس، کریپتو، سهام پرنوسان · تایم ۱۵ دقیقه تا روزانه",
      },
      en: {
        name: "EMA 9/21 Cross",
        tagline: "The day-trader favorite momentum strategy",
        desc:
          "Two fast exponential averages; EMA9 crossing EMA21 catches short-term momentum shifts early. Fast, simple, and the backbone of half of all scalping systems.",
        rules: [
          "Buy: EMA9 crosses above EMA21",
          "Sell: EMA9 crosses below EMA21",
          "Stop loss: 1.5× ATR",
          "Targets: 1.5× and 3× ATR",
          "Exit early on the opposite cross",
        ],
        tips: [
          "Trade in the direction of the higher-timeframe trend (EMA200)",
          "The first cross after a sharp move beats mid-range crosses",
          "High volume on the cross = strong confirmation",
          "Signals are weak during low-volume hours",
        ],
        best: "Forex, crypto, volatile stocks · 15m to daily",
      },
    },
    run(bars) {
      const c = closes(bars);
      const e9 = emaArr(c, 9), e21 = emaArr(c, 21);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null) continue;
        if (crossUp(e9, e21, i)) events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a)));
        else if (crossDown(e9, e21, i)) events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a)));
      }
      const i = bars.length - 1;
      const bull = e9[i] > e21[i];
      return {
        events,
        state: {
          bias: bull ? "BUY" : "SELL",
          reasons: [
            bull
              ? r("EMA9 بالای EMA21 — مومنتوم مثبت", "EMA9 above EMA21 — positive momentum")
              : r("EMA9 زیر EMA21 — مومنتوم منفی", "EMA9 below EMA21 — negative momentum"),
          ],
        },
      };
    },
  },

  {
    id: "macd-trend",
    icon: "🌊",
    category: "momentum",
    risk: 2,
    tfs: ["1h", "1d", "1wk"],
    defaultTf: "1d",
    minBars: 220,
    meta: {
      fa: {
        name: "MACD با فیلتر روند",
        tagline: "تقاطع MACD فقط در جهت روند اصلی — کیفیت بالای سیگنال",
        desc:
          "تقاطع خط MACD با خط سیگنال، به‌شرط هم‌جهت بودن با EMA200. فیلتر روند نصف سیگنال‌های کاذب MACD خام را حذف می‌کند — همان چیزی که الکساندر الدر «معامله با جزر و مد» می‌نامد.",
        rules: [
          "ورود خرید: MACD از سیگنال به بالا عبور کند و قیمت بالای EMA200 باشد",
          "ورود فروش: MACD از سیگنال به پایین عبور کند و قیمت زیر EMA200 باشد",
          "تقاطع‌های خلاف روند نادیده گرفته می‌شوند",
          "حد ضرر: ۱.۵ برابر ATR · هدف‌ها: ۲ و ۳.۵ برابر ATR",
        ],
        tips: [
          "بهترین سیگنال‌ها وقتی است که تقاطع زیر خط صفر (برای خرید) رخ دهد — سوخت بیشتری دارد",
          "واگرایی MACD با قیمت هشدار برگشت است؛ با این استراتژی ترکیبش کن",
          "هیستوگرام در حال بزرگ‌شدن = مومنتوم سالم",
        ],
        best: "همه بازارها · تایم ۱ ساعته تا هفتگی · معامله‌گر روندی",
      },
      en: {
        name: "MACD with Trend Filter",
        tagline: "MACD crosses only with the major trend — high signal quality",
        desc:
          "MACD/signal-line crosses, but only when aligned with the EMA200 trend. The filter kills half of raw MACD's false signals — Elder's 'trade with the tide'.",
        rules: [
          "Buy: MACD crosses above signal while price is above EMA200",
          "Sell: MACD crosses below signal while price is below EMA200",
          "Counter-trend crosses are ignored",
          "Stop: 1.5× ATR · Targets: 2× and 3.5× ATR",
        ],
        tips: [
          "Best buys happen when the cross fires below the zero line — more fuel",
          "MACD/price divergence warns of reversals; combine it",
          "A growing histogram = healthy momentum",
        ],
        best: "All markets · 1H to weekly · Trend traders",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { macd, signal } = macdArrs(bars);
      const e200 = emaArr(c, 200);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || e200[i] == null) continue;
        if (crossUp(macd, signal, i) && c[i] > e200[i])
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 1.5, 2, 3.5)));
        else if (crossDown(macd, signal, i) && c[i] < e200[i])
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 1.5, 2, 3.5)));
      }
      const i = bars.length - 1;
      const above = e200[i] != null && c[i] > e200[i];
      const bull = macd[i] != null && signal[i] != null && macd[i] > signal[i];
      return {
        events,
        state: {
          bias: above && bull ? "BUY" : !above && !bull ? "SELL" : null,
          reasons: [
            above
              ? r("قیمت بالای EMA200 — فقط خرید مجاز", "Price above EMA200 — longs only")
              : r("قیمت زیر EMA200 — فقط فروش مجاز", "Price below EMA200 — shorts only"),
            bull
              ? r("MACD بالای خط سیگنال", "MACD above its signal line")
              : r("MACD زیر خط سیگنال", "MACD below its signal line"),
          ],
        },
      };
    },
  },

  {
    id: "rsi-reversal",
    icon: "🔄",
    category: "reversal",
    risk: 2,
    tfs: ["1m", "5m", "15m", "1h", "1d"],
    defaultTf: "1d",
    minBars: 50,
    meta: {
      fa: {
        name: "برگشت RSI از اشباع",
        tagline: "خرید ترس، فروش طمع — بازگشت به میانگین",
        desc:
          "وقتی RSI از ناحیه اشباع فروش (زیر ۳۰) به بالا برمی‌گردد، فروشندگان خسته شده‌اند؛ برگشت از اشباع خرید (بالای ۷۰) برعکس. استراتژی کلاسیک بازگشت به میانگین که در بازارهای رنج عالی کار می‌کند.",
        rules: [
          "ورود خرید: RSI(14) از زیر ۳۰ به بالای ۳۰ برگردد",
          "ورود فروش: RSI از بالای ۷۰ به زیر ۷۰ برگردد",
          "حد ضرر: ۱.۵ برابر ATR",
          "هدف‌ها: ۱.۵ و ۲.۵ برابر ATR (تا میانگین)",
        ],
        tips: [
          "در روند قوی معامله نکن — «اشباع» در روند قوی می‌تواند مدت‌ها اشباع بماند",
          "واگرایی (کف پایین‌تر قیمت + کف بالاتر RSI) سیگنال را چند برابر قوی می‌کند",
          "RSI زیر ۲۰ یا بالای ۸۰ = سیگنال نایاب و قوی‌تر",
          "با حمایت/مقاومت افقی ترکیب کن؛ برگشت روی حمایت طلاست",
        ],
        best: "بازارهای رنج، جفت‌ارزهای اصلی، سهام بزرگ · هر تایمی",
      },
      en: {
        name: "RSI Oversold/Overbought Reversal",
        tagline: "Buy fear, sell greed — mean reversion",
        desc:
          "When RSI recovers from oversold (below 30) sellers are exhausted; turning down from overbought (above 70) is the mirror. The classic mean-reversion play — shines in ranging markets.",
        rules: [
          "Buy: RSI(14) crosses back above 30",
          "Sell: RSI crosses back below 70",
          "Stop loss: 1.5× ATR",
          "Targets: 1.5× and 2.5× ATR (back to the mean)",
        ],
        tips: [
          "Don't fight strong trends — 'overbought' can stay overbought for weeks",
          "Divergence (lower price low + higher RSI low) multiplies signal quality",
          "RSI below 20 / above 80 = rarer and stronger",
          "Combine with horizontal S/R; a reversal off support is gold",
        ],
        best: "Ranging markets, major FX pairs, large caps · Any timeframe",
      },
    },
    run(bars) {
      const c = closes(bars);
      const rsi = rsiArr(bars);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || rsi[i] == null || rsi[i - 1] == null) continue;
        if (rsi[i - 1] < 30 && rsi[i] >= 30)
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 1.5, 1.5, 2.5)));
        else if (rsi[i - 1] > 70 && rsi[i] <= 70)
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 1.5, 1.5, 2.5)));
      }
      const i = bars.length - 1;
      const v = rsi[i];
      return {
        events,
        state: {
          bias: v == null ? null : v < 30 ? "BUY" : v > 70 ? "SELL" : null,
          reasons: [
            v == null
              ? r("RSI محاسبه نشد", "RSI unavailable")
              : v < 30
                ? r(`RSI = ${v.toFixed(1)} — اشباع فروش، آماده برگشت`, `RSI = ${v.toFixed(1)} — oversold, watch for a turn`)
                : v > 70
                  ? r(`RSI = ${v.toFixed(1)} — اشباع خرید، آماده اصلاح`, `RSI = ${v.toFixed(1)} — overbought, correction risk`)
                  : r(`RSI = ${v.toFixed(1)} — ناحیه خنثی`, `RSI = ${v.toFixed(1)} — neutral zone`),
          ],
        },
      };
    },
  },

  {
    id: "boll-squeeze",
    icon: "💥",
    category: "breakout",
    risk: 3,
    tfs: ["15m", "1h", "1d"],
    defaultTf: "1d",
    minBars: 120,
    meta: {
      fa: {
        name: "فشردگی بولینگر (Squeeze)",
        tagline: "آرامش قبل از طوفان — شکار حرکت‌های انفجاری",
        desc:
          "وقتی باندهای بولینگر به کم‌عرض‌ترین حالت چند ماه اخیر می‌رسند، نوسان ذخیره شده و یک حرکت انفجاری در راه است. شکست باند بعد از فشردگی، جهت انفجار را نشان می‌دهد. استراتژی محبوب جان بولینگر و TTM Squeeze.",
        rules: [
          "شرط: پهنای باند در پایین‌ترین ۱۵٪ صد کندل اخیر (فشردگی)",
          "ورود خرید: کلوز بالای باند بالایی در حین/بلافاصله بعد از فشردگی",
          "ورود فروش: کلوز زیر باند پایینی",
          "حد ضرر: باند میانی (SMA20)",
          "هدف‌ها: ۲ و ۴ برابر ATR — حرکات بعد از فشردگی بزرگ‌اند",
        ],
        tips: [
          "هرچه فشردگی طولانی‌تر، انفجار بزرگ‌تر",
          "شکست با حجم بالا معتبر است؛ شکست کم‌حجم اغلب فیک است",
          "اولین شکست گاهی فیک است — نصف حجم را بعد از تثبیت اضافه کن",
          "قبل از اخبار مهم (NFP، FOMC) فشردگی طبیعی است؛ مراقب اسپایک دوطرفه باش",
        ],
        best: "کریپتو، طلا، سهام پرنوسان · قبل از حرکات بزرگ",
      },
      en: {
        name: "Bollinger Squeeze",
        tagline: "The calm before the storm — hunting explosive moves",
        desc:
          "When Bollinger bands hit their narrowest width in months, volatility is coiled and an explosive move is loading. The band breakout after a squeeze points the direction. John Bollinger's own favorite; basis of TTM Squeeze.",
        rules: [
          "Setup: band width in the lowest 15% of the last 100 bars (squeeze)",
          "Buy: close above the upper band during/right after the squeeze",
          "Sell: close below the lower band",
          "Stop: the middle band (SMA20)",
          "Targets: 2× and 4× ATR — post-squeeze moves run far",
        ],
        tips: [
          "The longer the squeeze, the bigger the expansion",
          "Volume on the break validates it; low-volume breaks are often fake",
          "First break can be a headfake — add after confirmation",
          "Squeezes are normal before big news (NFP, FOMC); beware two-way spikes",
        ],
        best: "Crypto, gold, volatile stocks · Ahead of big moves",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { mid, upper, lower } = bollArr(bars);
      const atr = atrArr(bars);
      const n = bars.length;
      const width = upper.map((u, i) => (u == null || !mid[i] ? null : (u - lower[i]) / mid[i]));
      const events = [];
      const LOOK = 100;
      const inSqueeze = new Array(n).fill(false);
      for (let i = LOOK; i < n; i++) {
        const win = [];
        for (let j = i - LOOK + 1; j <= i; j++) if (width[j] != null) win.push(width[j]);
        if (!win.length || width[i] == null) continue;
        const sorted = [...win].sort((a, b) => a - b);
        inSqueeze[i] = width[i] <= sorted[Math.floor(sorted.length * 0.15)];
      }
      const recentSqueeze = (i) => inSqueeze.slice(Math.max(0, i - 5), i + 1).some(Boolean);
      for (let i = LOOK; i < n; i++) {
        const a = atr[i];
        if (a == null || upper[i] == null || !recentSqueeze(i)) continue;
        if (c[i - 1] <= upper[i - 1] && c[i] > upper[i])
          events.push({ ...ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 1.5, 2, 4)), sl: mid[i] });
        else if (c[i - 1] >= lower[i - 1] && c[i] < lower[i])
          events.push({ ...ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 1.5, 2, 4)), sl: mid[i] });
      }
      const i = n - 1;
      return {
        events,
        state: {
          bias: null,
          reasons: [
            inSqueeze[i]
              ? r("باندها در فشردگی — انفجار نزدیک است، منتظر شکست بمان", "Bands squeezed — expansion imminent, wait for the break")
              : recentSqueeze(i)
                ? r("فشردگی اخیر — شکست‌ها را جدی بگیر", "Recent squeeze — treat breaks seriously")
                : r("فشردگی فعال نیست — نوسان عادی", "No active squeeze — normal volatility"),
            width[i] != null
              ? r(`پهنای باند: ${(width[i] * 100).toFixed(2)}٪`, `Band width: ${(width[i] * 100).toFixed(2)}%`)
              : r("پهنای باند نامشخص", "Band width unavailable"),
          ],
        },
      };
    },
  },

  {
    id: "boll-revert",
    icon: "🎯",
    category: "reversal",
    risk: 2,
    tfs: ["1m", "5m", "15m", "1h", "1d"],
    defaultTf: "1h",
    minBars: 60,
    meta: {
      fa: {
        name: "بازگشت از باند بولینگر",
        tagline: "لمس باند، برگشت به میانگین — معامله در رنج",
        desc:
          "قیمت بعد از بستن زیر باند پایینی و برگشت به داخل باند، معمولاً تا باند میانی حرکت می‌کند (و برعکس برای باند بالایی). استراتژی بازگشت به میانگین با هدف‌های ساختاری، نه ATRی.",
        rules: [
          "ورود خرید: کندل قبل زیر باند پایینی بسته و کندل فعلی به داخل باند برگردد",
          "ورود فروش: برگشت از بالای باند بالایی به داخل",
          "حد ضرر: کمی آن‌طرف اکسترمم اخیر (۱ ATR)",
          "هدف ۱: باند میانی (SMA20) · هدف ۲: باند مقابل",
        ],
        tips: [
          "فقط در بازار رنج — اگر ADX بالای ۲۵ است، این استراتژی را کنار بگذار",
          "کندل برگشتی (پین‌بار/انگالفینگ) روی باند اعتبار را چند برابر می‌کند",
          "در «Band Walk» (چسبیدن قیمت به باند در روند قوی) هرگز خلاف جهت نگیر",
        ],
        best: "جفت‌ارزهای رنج، ساعات کم‌خبر · تایم ۱۵ دقیقه تا ۱ ساعت",
      },
      en: {
        name: "Bollinger Band Reversion",
        tagline: "Tag the band, snap back to the mean — range trading",
        desc:
          "After closing outside the lower band and re-entering, price usually travels to the middle band (mirror for the upper band). Mean reversion with structural targets instead of ATR multiples.",
        rules: [
          "Buy: previous close below the lower band, current close back inside",
          "Sell: re-entry from above the upper band",
          "Stop: just beyond the recent extreme (1 ATR)",
          "TP1: middle band (SMA20) · TP2: the opposite band",
        ],
        tips: [
          "Range markets only — if ADX > 25, put this strategy away",
          "A reversal candle (pin bar / engulfing) on the band multiplies validity",
          "Never fade a 'band walk' in a strong trend",
        ],
        best: "Ranging FX pairs, quiet sessions · 15m to 1H",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { mid, upper, lower } = bollArr(bars);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || lower[i] == null || lower[i - 1] == null) continue;
        if (c[i - 1] < lower[i - 1] && c[i] > lower[i] && c[i] < mid[i])
          events.push({
            ...ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 1, 1, 2)),
            tp1: mid[i],
            tp2: upper[i],
          });
        else if (c[i - 1] > upper[i - 1] && c[i] < upper[i] && c[i] > mid[i])
          events.push({
            ...ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 1, 1, 2)),
            tp1: mid[i],
            tp2: lower[i],
          });
      }
      const i = bars.length - 1;
      const pos =
        upper[i] == null ? null : c[i] > upper[i] ? "above" : c[i] < lower[i] ? "below" : "inside";
      return {
        events,
        state: {
          bias: pos === "below" ? "BUY" : pos === "above" ? "SELL" : null,
          reasons: [
            pos === "above"
              ? r("قیمت بیرون باند بالایی — منتظر کندل برگشتی", "Price outside the upper band — wait for a reversal close")
              : pos === "below"
                ? r("قیمت بیرون باند پایینی — منتظر کندل برگشتی", "Price outside the lower band — wait for a reversal close")
                : r("قیمت داخل باندها", "Price inside the bands"),
          ],
        },
      };
    },
  },

  {
    id: "turtle",
    icon: "🐢",
    category: "breakout",
    risk: 2,
    tfs: ["1h", "1d", "1wk"],
    defaultTf: "1d",
    minBars: 60,
    meta: {
      fa: {
        name: "لاک‌پشت‌ها (شکست دانکیان ۲۰)",
        tagline: "افسانه‌ای‌ترین آزمایش تاریخ ترید — سیستم لاک‌پشت‌های دنیس",
        desc:
          "ریچارد دنیس در دهه ۸۰ با همین قوانین ساده به گروهی تازه‌کار میلیون‌ها دلار سود داد: شکست سقف ۲۰ کندله بخر، شکست کف ۲۰ کندله بفروش. روند را دنبال کن، ضررها را کوتاه ببُر و بگذار سودها بدوند.",
        rules: [
          "ورود خرید: کلوز بالای سقف ۲۰ کندل قبل",
          "ورود فروش: کلوز زیر کف ۲۰ کندل قبل",
          "حد ضرر: ۲ برابر ATR (قانون اصلی لاک‌پشت‌ها: 2N)",
          "خروج کلاسیک: شکست کانال ۱۰ کندله مخالف · هدف‌ها: ۲ و ۴ برابر ATR",
          "هر معامله حداکثر ۱-۲٪ ریسک",
        ],
        tips: [
          "بیشتر سیگنال‌ها ضرر کوچک‌اند؛ سود از ۲-۳ روند بزرگ سالانه می‌آید — پایبند بمان",
          "بعد از یک شکست ناموفق، سیگنال بعدی را حتماً بگیر (قانون طلایی لاک‌پشت‌ها)",
          "در بازارهای کالایی و کریپتو که روندهای بلند دارند بهترین عملکرد را دارد",
          "روان‌شناسی سخت‌تر از قوانین است: تحمل چند ضرر پشت‌سرهم",
        ],
        best: "کالاها، کریپتو، فارکس روندی · تایم روزانه",
      },
      en: {
        name: "Turtle Trading (Donchian 20 Breakout)",
        tagline: "The most legendary experiment in trading history",
        desc:
          "Richard Dennis taught these exact rules to novices in the '80s and they made millions: buy a 20-bar high breakout, sell a 20-bar low breakdown. Follow the trend, cut losses at 2N, let winners run.",
        rules: [
          "Buy: close above the prior 20-bar high",
          "Sell: close below the prior 20-bar low",
          "Stop loss: 2× ATR (the original turtle 2N rule)",
          "Classic exit: opposite 10-bar channel break · Targets: 2× and 4× ATR",
          "Risk max 1-2% per trade",
        ],
        tips: [
          "Most signals are small losses; the year's profit comes from 2-3 big trends — stay disciplined",
          "Always take the next signal after a failed breakout (the turtles' golden rule)",
          "Works best in commodities and crypto where trends run long",
          "The psychology is harder than the rules: enduring losing streaks",
        ],
        best: "Commodities, crypto, trending FX · Daily",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { upper, lower } = donchianArr(bars, 20);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 21; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || upper[i - 1] == null) continue;
        if (c[i] > upper[i - 1] && c[i - 1] <= upper[i - 2])
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 2, 2, 4)));
        else if (c[i] < lower[i - 1] && c[i - 1] >= lower[i - 2])
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 2, 2, 4)));
      }
      const i = bars.length - 1;
      const distHi = upper[i - 1] != null ? ((upper[i - 1] - c[i]) / c[i]) * 100 : null;
      const distLo = lower[i - 1] != null ? ((c[i] - lower[i - 1]) / c[i]) * 100 : null;
      return {
        events,
        state: {
          bias: null,
          reasons: [
            distHi != null
              ? r(`فاصله تا سقف ۲۰ کندله: ${distHi.toFixed(2)}٪`, `Distance to the 20-bar high: ${distHi.toFixed(2)}%`)
              : r("کانال ناقص", "Channel incomplete"),
            distLo != null
              ? r(`فاصله تا کف ۲۰ کندله: ${distLo.toFixed(2)}٪`, `Distance to the 20-bar low: ${distLo.toFixed(2)}%`)
              : r("کانال ناقص", "Channel incomplete"),
          ],
        },
      };
    },
  },

  {
    id: "supertrend",
    icon: "🚀",
    category: "trend",
    risk: 2,
    tfs: ["1m", "5m", "15m", "1h", "1d"],
    defaultTf: "1h",
    minBars: 40,
    meta: {
      fa: {
        name: "سوپرترند (10, 3)",
        tagline: "حد ضرر متحرک هوشمند — سوار روند بمان",
        desc:
          "سوپرترند یک خط توقف مبتنی بر ATR است که زیر روند صعودی و بالای روند نزولی حرکت می‌کند. تغییر رنگ خط = تغییر روند. سادگی و حد ضرر داخلی‌اش آن را به یکی از محبوب‌ترین اندیکاتورهای دهه اخیر تبدیل کرده.",
        rules: [
          "ورود خرید: قیمت خط سوپرترند را به بالا بشکند (خط سبز شود)",
          "ورود فروش: قیمت زیر خط برود (خط قرمز شود)",
          "حد ضرر: خودِ خط سوپرترند — با روند جابه‌جا می‌شود",
          "هدف‌ها: ۱.۵ و ۳ برابر فاصله ورود تا خط",
        ],
        tips: [
          "با ADX بالای ۲۵ فوق‌العاده است؛ در رنج اره می‌شوی",
          "دو سوپرترند (10,1 سریع و 10,3 آهسته): ورود با سریع، خروج با آهسته",
          "بعد از فلیپ، پولبک به خط معمولاً ورود دوم کم‌ریسک است",
        ],
        best: "کریپتو و طلا · تایم ۱۵ دقیقه تا روزانه · بازار روندی",
      },
      en: {
        name: "SuperTrend (10, 3)",
        tagline: "A smart trailing stop — stay on the trend",
        desc:
          "SuperTrend is an ATR-based stop line riding below uptrends and above downtrends. A color flip = trend change. Built-in stops and dead-simple rules made it one of the most popular indicators of the decade.",
        rules: [
          "Buy: price breaks above the SuperTrend line (line turns green)",
          "Sell: price breaks below (line turns red)",
          "Stop loss: the SuperTrend line itself — it trails the trend",
          "Targets: 1.5× and 3× the entry-to-line distance",
        ],
        tips: [
          "Great with ADX above 25; you get chopped in ranges",
          "Two SuperTrends (fast 10,1 + slow 10,3): enter on fast, exit on slow",
          "The pullback to the line after a flip is a low-risk second entry",
        ],
        best: "Crypto and gold · 15m to daily · Trending markets",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { st, dir } = supertrendArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        if (dir[i] == null || dir[i - 1] == null || st[i] == null) continue;
        if (dir[i] === 1 && dir[i - 1] === -1) {
          const rsk = Math.max(c[i] - st[i], 1e-9);
          events.push({ i, time: bars[i].time, dir: "BUY", entry: c[i], sl: st[i], tp1: c[i] + 1.5 * rsk, tp2: c[i] + 3 * rsk });
        } else if (dir[i] === -1 && dir[i - 1] === 1) {
          const rsk = Math.max(st[i] - c[i], 1e-9);
          events.push({ i, time: bars[i].time, dir: "SELL", entry: c[i], sl: st[i], tp1: c[i] - 1.5 * rsk, tp2: c[i] - 3 * rsk });
        }
      }
      const i = bars.length - 1;
      return {
        events,
        state: {
          bias: dir[i] === 1 ? "BUY" : dir[i] === -1 ? "SELL" : null,
          reasons: [
            dir[i] === 1
              ? r(`روند صعودی — خط توقف: ${st[i]?.toFixed(2)}`, `Uptrend — stop line: ${st[i]?.toFixed(2)}`)
              : r(`روند نزولی — خط توقف: ${st[i]?.toFixed(2)}`, `Downtrend — stop line: ${st[i]?.toFixed(2)}`),
          ],
        },
      };
    },
  },

  {
    id: "ichimoku",
    icon: "☁️",
    category: "trend",
    risk: 2,
    tfs: ["1h", "1d", "1wk"],
    defaultTf: "1d",
    minBars: 120,
    meta: {
      fa: {
        name: "ایچیموکو (شکست ابر کومو)",
        tagline: "سیستم کامل ژاپنی — روند، مومنتوم و حمایت در یک نگاه",
        desc:
          "ایچیموکو «نمودار تعادل در یک نگاه» است: عبور قیمت از ابر کومو به‌همراه تقاطع تنکان/کیجون یکی از قوی‌ترین سیگنال‌های روندی است. ابر جلوتر از قیمت رسم می‌شود و نقشه‌ی حمایت/مقاومت آینده را می‌دهد.",
        rules: [
          "ورود خرید: کلوز بالای ابر + تنکان بالای کیجون",
          "ورود فروش: کلوز زیر ابر + تنکان زیر کیجون",
          "حد ضرر: خط کیجون (خط پایه)",
          "هدف‌ها: ۱.۵ و ۳ برابر ریسک",
          "تأیید بیشتر: چیکو اسپن آزاد باشد (قیمت ۲۶ کندل قبل را قطع نکند)",
        ],
        tips: [
          "ابر ضخیم = حمایت/مقاومت قوی؛ ابر نازک = راحت شکسته می‌شود",
          "معامله داخل ابر ممنوع — ابر یعنی جنگ و بی‌تصمیمی",
          "رنگ ابرِ آینده (سبز/قرمز) جهت‌گیری میان‌مدت را پیش‌گویی می‌کند",
          "در تایم پایین‌تر از ۱ ساعت نویز زیاد دارد",
        ],
        best: "فارکس (خانه ایچیموکو: ین!)، طلا، شاخص‌ها · تایم روزانه",
      },
      en: {
        name: "Ichimoku (Kumo Breakout)",
        tagline: "The complete Japanese system — trend, momentum & support at a glance",
        desc:
          "Ichimoku is the 'one-glance equilibrium chart': price breaking through the Kumo cloud with a Tenkan/Kijun cross is one of the strongest trend signals. The cloud is drawn ahead of price, mapping future support/resistance.",
        rules: [
          "Buy: close above the cloud + Tenkan above Kijun",
          "Sell: close below the cloud + Tenkan below Kijun",
          "Stop: the Kijun (base) line",
          "Targets: 1.5× and 3× the risk",
          "Extra filter: Chikou span clear of price 26 bars back",
        ],
        tips: [
          "Thick cloud = strong S/R; thin cloud breaks easily",
          "Never trade inside the cloud — it means battle and indecision",
          "The future cloud's color forecasts the medium-term bias",
          "Too noisy below the 1H timeframe",
        ],
        best: "Forex (ichimoku's home: JPY pairs), gold, indices · Daily",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { tenkan, kijun, spanA, spanB } = ichimokuArr(bars);
      const atr = atrArr(bars);
      const SH = 26;
      const cloudTop = (i) =>
        i >= SH && spanA[i - SH] != null && spanB[i - SH] != null
          ? Math.max(spanA[i - SH], spanB[i - SH]) : null;
      const cloudBot = (i) =>
        i >= SH && spanA[i - SH] != null && spanB[i - SH] != null
          ? Math.min(spanA[i - SH], spanB[i - SH]) : null;
      const events = [];
      for (let i = SH + 1; i < bars.length; i++) {
        const a = atr[i], top = cloudTop(i), bot = cloudBot(i);
        const pTop = cloudTop(i - 1), pBot = cloudBot(i - 1);
        if (a == null || top == null || pTop == null || tenkan[i] == null || kijun[i] == null) continue;
        if (c[i - 1] <= pTop && c[i] > top && tenkan[i] > kijun[i]) {
          const sl = Math.min(kijun[i], c[i] - 0.5 * a);
          const rsk = Math.max(c[i] - sl, 1e-9);
          events.push({ i, time: bars[i].time, dir: "BUY", entry: c[i], sl, tp1: c[i] + 1.5 * rsk, tp2: c[i] + 3 * rsk });
        } else if (c[i - 1] >= pBot && c[i] < bot && tenkan[i] < kijun[i]) {
          const sl = Math.max(kijun[i], c[i] + 0.5 * a);
          const rsk = Math.max(sl - c[i], 1e-9);
          events.push({ i, time: bars[i].time, dir: "SELL", entry: c[i], sl, tp1: c[i] - 1.5 * rsk, tp2: c[i] - 3 * rsk });
        }
      }
      const i = bars.length - 1;
      const top = cloudTop(i), bot = cloudBot(i);
      const pos = top == null ? null : c[i] > top ? "above" : c[i] < bot ? "below" : "inside";
      const tk = tenkan[i] != null && kijun[i] != null ? tenkan[i] > kijun[i] : null;
      return {
        events,
        state: {
          bias: pos === "above" && tk ? "BUY" : pos === "below" && tk === false ? "SELL" : null,
          reasons: [
            pos === "above"
              ? r("قیمت بالای ابر کومو — فضای صعودی", "Price above the Kumo — bullish territory")
              : pos === "below"
                ? r("قیمت زیر ابر کومو — فضای نزولی", "Price below the Kumo — bearish territory")
                : pos === "inside"
                  ? r("قیمت داخل ابر — بی‌تصمیمی، معامله نکن", "Price inside the cloud — indecision, stand aside")
                  : r("ابر ناقص", "Cloud incomplete"),
            tk == null
              ? r("تنکان/کیجون ناقص", "Tenkan/Kijun incomplete")
              : tk
                ? r("تنکان بالای کیجون", "Tenkan above Kijun")
                : r("تنکان زیر کیجون", "Tenkan below Kijun"),
          ],
        },
      };
    },
  },

  {
    id: "vwap-bounce",
    icon: "🎪",
    category: "scalp",
    risk: 3,
    tfs: ["1m", "5m", "15m"],
    defaultTf: "1m",
    minBars: 60,
    intradayOnly: true,
    meta: {
      fa: {
        name: "پولبک به VWAP",
        tagline: "استراتژی اسکالپ نهادی — خرید همان‌جا که الگوریتم‌ها می‌خرند",
        desc:
          "VWAP خط مرجع معامله‌گران نهادی است. وقتی قیمت در روند بالای VWAP است و به آن پولبک می‌زند، الگوریتم‌های خرید نهادی معمولاً همان‌جا فعال می‌شوند. ورود با کندل برگشتی روی خط.",
        rules: [
          "شرط: قیمت اکثر ۲۰ کندل اخیر بالای VWAP باشد (روند روز صعودی)",
          "ورود خرید: کف کندل، VWAP را لمس کند و کندل سبز بالای VWAP بسته شود",
          "برعکس برای فروش در روز نزولی",
          "حد ضرر: ۱ ATR آن‌طرف VWAP",
          "هدف ۱: سقف ۲۰ کندله · هدف ۲: دو برابر ریسک",
        ],
        tips: [
          "فقط در سشن پرحجم (لندن/نیویورک) — VWAP در بازار کم‌حجم بی‌معنی است",
          "اولین و دومین لمس VWAP بهترین‌اند؛ لمس چهارم به بعد معمولاً می‌شکند",
          "با انحراف معیار VWAP (باندهای ±σ) هدف‌گذاری دقیق‌تر می‌شود",
          "روز بدون روند = VWAP تخت = این استراتژی را کنار بگذار",
        ],
        best: "سهام پرحجم، فیوچرز شاخص، کریپتو · فقط تایم‌های زیر ۱۵ دقیقه",
      },
      en: {
        name: "VWAP Pullback",
        tagline: "The institutional scalp — buy where the algos buy",
        desc:
          "VWAP is the institutional benchmark. When price trends above VWAP and pulls back to it, institutional buy algos typically defend the line. Enter on the reversal candle at the touch.",
        rules: [
          "Setup: most of the last 20 bars above VWAP (bullish session)",
          "Buy: candle low tags VWAP and closes green above it",
          "Mirror for shorts on a bearish session",
          "Stop: 1 ATR beyond VWAP",
          "TP1: the 20-bar high · TP2: 2× the risk",
        ],
        tips: [
          "Liquid sessions only (London/NY) — VWAP is meaningless on thin volume",
          "The 1st and 2nd VWAP touches are best; the 4th+ usually breaks",
          "VWAP ±σ bands sharpen the targets",
          "Flat VWAP = no session trend = skip this strategy",
        ],
        best: "Liquid stocks, index futures, crypto · Sub-15m only",
      },
    },
    run(bars, intraday) {
      const c = closes(bars);
      const vw = vwapArr(bars, intraday);
      const atr = atrArr(bars);
      const { upper, lower } = donchianArr(bars, 20);
      const events = [];
      for (let i = 21; i < bars.length; i++) {
        const a = atr[i], v = vw[i];
        if (a == null || v == null) continue;
        let above = 0, cnt = 0;
        for (let j = i - 20; j < i; j++)
          if (vw[j] != null) {
            cnt++;
            if (c[j] > vw[j]) above++;
          }
        if (!cnt) continue;
        const ratio = above / cnt;
        const b = bars[i];
        if (ratio >= 0.7 && b.low <= v + 0.1 * a && b.close > v && b.close > b.open) {
          const sl = v - a;
          const rsk = Math.max(b.close - sl, 1e-9);
          // TP1: the 20-bar high, but only if it's actually above entry.
          const hi = upper[i - 1];
          const tp1 = hi != null && hi > b.close + 0.3 * rsk ? hi : b.close + 1.2 * rsk;
          events.push({ i, time: b.time, dir: "BUY", entry: b.close, sl, tp1, tp2: Math.max(tp1, b.close + 2 * rsk) });
        } else if (ratio <= 0.3 && b.high >= v - 0.1 * a && b.close < v && b.close < b.open) {
          const sl = v + a;
          const rsk = Math.max(sl - b.close, 1e-9);
          const lo = lower[i - 1];
          const tp1 = lo != null && lo < b.close - 0.3 * rsk ? lo : b.close - 1.2 * rsk;
          events.push({ i, time: b.time, dir: "SELL", entry: b.close, sl, tp1, tp2: Math.min(tp1, b.close - 2 * rsk) });
        }
      }
      const i = bars.length - 1;
      const v = vw[i];
      return {
        events,
        state: {
          bias: v == null ? null : c[i] > v ? "BUY" : "SELL",
          reasons: [
            v == null
              ? r("VWAP در دسترس نیست (تایم‌فریم روزانه؟)", "VWAP unavailable (daily timeframe?)")
              : c[i] > v
                ? r(`قیمت ${(((c[i] - v) / v) * 100).toFixed(2)}٪ بالای VWAP — خریداران مسلط`, `Price ${(((c[i] - v) / v) * 100).toFixed(2)}% above VWAP — buyers in control`)
                : r(`قیمت ${(((v - c[i]) / v) * 100).toFixed(2)}٪ زیر VWAP — فروشندگان مسلط`, `Price ${(((v - c[i]) / v) * 100).toFixed(2)}% below VWAP — sellers in control`),
          ],
        },
      };
    },
  },

  {
    id: "stoch-cross",
    icon: "🎚️",
    category: "momentum",
    risk: 2,
    tfs: ["1m", "5m", "15m", "1h", "1d"],
    defaultTf: "1h",
    minBars: 50,
    meta: {
      fa: {
        name: "تقاطع استوکاستیک در اشباع",
        tagline: "تایمینگ دقیق ورود در نقاط چرخش",
        desc:
          "تقاطع %K و %D فقط وقتی معتبر است که در ناحیه اشباع رخ دهد: تقاطع صعودی زیر ۲۰ و تقاطع نزولی بالای ۸۰. جورج لین این نوسانگر را برای شکار همین چرخش‌ها ساخت.",
        rules: [
          "ورود خرید: %K از %D به بالا عبور کند در حالی که هر دو زیر ۲۰ هستند",
          "ورود فروش: تقاطع نزولی %K/%D بالای ۸۰",
          "حد ضرر: ۱.۵ برابر ATR",
          "هدف‌ها: ۱.۵ و ۳ برابر ATR",
        ],
        tips: [
          "در جهت روند تایم بالاتر بگیر — استوک خلاف روند = پول دور ریختن",
          "واگرایی استوکاستیک با قیمت سیگنال را بسیار قوی می‌کند",
          "در روند قوی از تنظیم (5,3,3) و در رنج از (14,3,3) استفاده کن",
        ],
        best: "فارکس و طلا · بازار رنج یا اصلاح‌های روند",
      },
      en: {
        name: "Stochastic Cross in Extremes",
        tagline: "Precision timing at turning points",
        desc:
          "A %K/%D cross only counts when it fires in the extreme zones: bullish below 20, bearish above 80. George Lane built this oscillator precisely to catch these turns.",
        rules: [
          "Buy: %K crosses above %D while both are below 20",
          "Sell: %K/%D bearish cross above 80",
          "Stop: 1.5× ATR",
          "Targets: 1.5× and 3× ATR",
        ],
        tips: [
          "Trade with the higher-timeframe trend — counter-trend stoch = burning money",
          "Stochastic/price divergence makes the signal much stronger",
          "Use (5,3,3) in strong trends, (14,3,3) in ranges",
        ],
        best: "Forex and gold · Ranges or trend pullbacks",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { k, d } = stochArrs(bars);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || k[i] == null || d[i] == null) continue;
        if (crossUp(k, d, i) && k[i] < 25 && d[i] < 25)
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a)));
        else if (crossDown(k, d, i) && k[i] > 75 && d[i] > 75)
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a)));
      }
      const i = bars.length - 1;
      const kv = k[i];
      return {
        events,
        state: {
          bias: kv == null ? null : kv < 20 ? "BUY" : kv > 80 ? "SELL" : null,
          reasons: [
            kv == null
              ? r("استوکاستیک ناقص", "Stochastic incomplete")
              : kv < 20
                ? r(`%K = ${kv.toFixed(1)} — اشباع فروش`, `%K = ${kv.toFixed(1)} — oversold`)
                : kv > 80
                  ? r(`%K = ${kv.toFixed(1)} — اشباع خرید`, `%K = ${kv.toFixed(1)} — overbought`)
                  : r(`%K = ${kv.toFixed(1)} — ناحیه میانی`, `%K = ${kv.toFixed(1)} — mid zone`),
          ],
        },
      };
    },
  },

  {
    id: "adx-dmi",
    icon: "📡",
    category: "trend",
    risk: 2,
    tfs: ["1h", "1d"],
    defaultTf: "1d",
    minBars: 60,
    meta: {
      fa: {
        name: "ADX + تقاطع DMI",
        tagline: "فقط وقتی روند واقعی است معامله کن",
        desc:
          "سیستم جهت‌دار وایلدر: تقاطع +DI و -DI جهت را می‌دهد و ADX قدرت روند را می‌سنجد. ورود فقط وقتی ADX بالای ۲۵ است — یعنی روندی واقعاً وجود دارد. بهترین فیلتر ضد-رنج بازار.",
        rules: [
          "ورود خرید: +DI از -DI به بالا عبور کند و ADX ≥ ۲۵",
          "ورود فروش: -DI از +DI به بالا عبور کند و ADX ≥ ۲۵",
          "ADX زیر ۲۰ = بدون معامله (بازار رنج)",
          "حد ضرر: ۲ برابر ATR · هدف‌ها: ۲ و ۴ برابر ATR",
        ],
        tips: [
          "ADX صعودی از ۲۰ به بالا = روند تازه در حال تولد — بهترین لحظه",
          "ADX بالای ۴۰ که شروع به افت کند = روند خسته، سود را ذخیره کن",
          "ADX جهت را نمی‌گوید؛ فقط قدرت را — جهت با DIها است",
        ],
        best: "همه بازارها به‌عنوان فیلتر روند · تایم ۱ ساعته و روزانه",
      },
      en: {
        name: "ADX + DMI Cross",
        tagline: "Only trade when the trend is real",
        desc:
          "Wilder's directional system: the +DI/-DI cross gives direction, ADX measures trend strength. Enter only with ADX above 25 — a trend actually exists. The best anti-chop filter there is.",
        rules: [
          "Buy: +DI crosses above -DI with ADX ≥ 25",
          "Sell: -DI crosses above +DI with ADX ≥ 25",
          "ADX below 20 = no trade (ranging market)",
          "Stop: 2× ATR · Targets: 2× and 4× ATR",
        ],
        tips: [
          "ADX rising through 20 = a newborn trend — the best moment",
          "ADX above 40 rolling over = tired trend, protect profits",
          "ADX has no direction; only strength — direction comes from the DIs",
        ],
        best: "Every market as a trend filter · 1H and daily",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { adx, pdi, mdi } = adxArr(bars);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || adx[i] == null || adx[i] < 25) continue;
        if (crossUp(pdi, mdi, i)) events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 2, 2, 4)));
        else if (crossDown(pdi, mdi, i)) events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 2, 2, 4)));
      }
      const i = bars.length - 1;
      const av = adx[i];
      const bull = pdi[i] != null && mdi[i] != null && pdi[i] > mdi[i];
      return {
        events,
        state: {
          bias: av != null && av >= 25 ? (bull ? "BUY" : "SELL") : null,
          reasons: [
            av == null
              ? r("ADX ناقص", "ADX incomplete")
              : av >= 25
                ? r(`ADX = ${av.toFixed(1)} — روند قوی`, `ADX = ${av.toFixed(1)} — strong trend`)
                : r(`ADX = ${av.toFixed(1)} — بازار رنج، معامله نکن`, `ADX = ${av.toFixed(1)} — ranging, stand aside`),
            bull
              ? r("+DI بالای -DI — فشار خرید", "+DI above -DI — buying pressure")
              : r("-DI بالای +DI — فشار فروش", "-DI above +DI — selling pressure"),
          ],
        },
      };
    },
  },

  {
    id: "rsi-divergence",
    icon: "🔍",
    category: "reversal",
    risk: 3,
    tfs: ["1h", "1d"],
    defaultTf: "1d",
    minBars: 80,
    meta: {
      fa: {
        name: "واگرایی RSI",
        tagline: "وقتی قیمت دروغ می‌گوید — قوی‌ترین سیگنال برگشتی",
        desc:
          "قیمت کف پایین‌تر می‌سازد اما RSI کف بالاتر — یعنی فشار فروش در حال تمام شدن است (واگرایی صعودی). بسیاری از سقف‌ها و کف‌های تاریخی بازار با واگرایی همراه بوده‌اند.",
        rules: [
          "واگرایی صعودی: کف قیمتی پایین‌تر + کف RSI بالاتر → خرید",
          "واگرایی نزولی: سقف قیمتی بالاتر + سقف RSI پایین‌تر → فروش",
          "تأیید: RSI خط ۵۰ یا خط روند خودش را بشکند",
          "حد ضرر: زیر/بالای اکسترمم دوم (۱.۲ ATR)",
          "هدف‌ها: ۲ و ۳.۵ برابر ATR",
        ],
        tips: [
          "واگرایی در اشباع (RSI زیر ۳۰ یا بالای ۷۰) چند برابر معتبرتر است",
          "واگرایی سیگنال ورود فوری نیست — منتظر کندل تأیید بمان",
          "واگرایی سه‌قله‌ای (تریپل) نادر اما فوق‌العاده قوی است",
          "در روند خیلی قوی، واگرایی‌ها پشت‌سرهم فیل می‌شوند — با حجم تأیید کن",
        ],
        best: "سقف/کف‌های میان‌مدت طلا، کریپتو و شاخص‌ها · تایم ۱ ساعته و روزانه",
      },
      en: {
        name: "RSI Divergence",
        tagline: "When price is lying — the strongest reversal signal",
        desc:
          "Price prints a lower low but RSI prints a higher low — selling pressure is running dry (bullish divergence). Many historic market tops and bottoms carried a divergence.",
        rules: [
          "Bullish: lower price low + higher RSI low → buy",
          "Bearish: higher price high + lower RSI high → sell",
          "Confirm: RSI breaks 50 or its own trendline",
          "Stop: beyond the second extreme (1.2 ATR)",
          "Targets: 2× and 3.5× ATR",
        ],
        tips: [
          "Divergence inside the extreme zones (RSI <30 / >70) is far more reliable",
          "It is not an instant entry — wait for a confirmation candle",
          "Triple divergence is rare but extremely powerful",
          "In very strong trends divergences fail repeatedly — confirm with volume",
        ],
        best: "Swing tops/bottoms in gold, crypto, indices · 1H and daily",
      },
    },
    run(bars) {
      const c = closes(bars);
      const rsi = rsiArr(bars);
      const atr = atrArr(bars);
      const events = [];
      const PIV = 3, LOOK = 40;
      const isPivLow = (i) => {
        for (let j = i - PIV; j <= i + PIV; j++)
          if (j !== i && (bars[j]?.low ?? Infinity) < bars[i].low) return false;
        return true;
      };
      const isPivHigh = (i) => {
        for (let j = i - PIV; j <= i + PIV; j++)
          if (j !== i && (bars[j]?.high ?? -Infinity) > bars[i].high) return false;
        return true;
      };
      const lows = [], highs = [];
      for (let i = PIV; i < bars.length - PIV; i++) {
        if (rsi[i] == null) continue;
        if (isPivLow(i)) {
          const prev = lows[lows.length - 1];
          if (prev && i - prev.i <= LOOK && bars[i].low < prev.low && rsi[i] > prev.rsi) {
            const a = atr[i + PIV] ?? atr[i];
            if (a != null) {
              const sig = i + PIV; // confirmed once the pivot completes
              const sl = bars[i].low - 0.3 * a;
              const rsk = Math.max(c[sig] - sl, 1e-9);
              events.push({ i: sig, time: bars[sig].time, dir: "BUY", entry: c[sig], sl, tp1: c[sig] + 1.5 * rsk, tp2: c[sig] + 2.5 * rsk });
            }
          }
          lows.push({ i, low: bars[i].low, rsi: rsi[i] });
        }
        if (isPivHigh(i)) {
          const prev = highs[highs.length - 1];
          if (prev && i - prev.i <= LOOK && bars[i].high > prev.high && rsi[i] < prev.rsi) {
            const a = atr[i + PIV] ?? atr[i];
            if (a != null) {
              const sig = i + PIV;
              const sl = bars[i].high + 0.3 * a;
              const rsk = Math.max(sl - c[sig], 1e-9);
              events.push({ i: sig, time: bars[sig].time, dir: "SELL", entry: c[sig], sl, tp1: c[sig] - 1.5 * rsk, tp2: c[sig] - 2.5 * rsk });
            }
          }
          highs.push({ i, high: bars[i].high, rsi: rsi[i] });
        }
      }
      events.sort((a, b) => a.i - b.i);
      const lastEv = events[events.length - 1];
      const fresh = lastEv && bars.length - 1 - lastEv.i <= 10;
      return {
        events,
        state: {
          bias: fresh ? lastEv.dir : null,
          reasons: [
            fresh
              ? lastEv.dir === "BUY"
                ? r("واگرایی صعودی اخیر شناسایی شد", "Recent bullish divergence detected")
                : r("واگرایی نزولی اخیر شناسایی شد", "Recent bearish divergence detected")
              : r("واگرایی تازه‌ای دیده نمی‌شود", "No fresh divergence in sight"),
          ],
        },
      };
    },
  },
  {
    id: "heikin-ashi",
    icon: "🕯️",
    category: "trend",
    risk: 2,
    tfs: ["1m", "5m", "15m", "1h", "1d"],
    defaultTf: "1h",
    minBars: 40,
    meta: {
      fa: {
        name: "چرخش هیکن‌آشی",
        tagline: "کندل‌های صاف‌شده — روند را بدون نویز ببین",
        desc:
          "هیکن‌آشی با میانگین‌گیری، نویز کندل‌ها را حذف می‌کند: بدنه‌های سبز پشت‌سرهم یعنی روند صعودی سالم. چرخش رنگ بعد از یک رشته‌ی مخالف، سیگنال تغییر روند است — محبوب سوئینگ‌تریدرها برای ماندن در روند.",
        rules: [
          "ورود خرید: کندل هیکن‌آشی سبز بعد از حداقل ۲ کندل قرمز",
          "ورود فروش: کندل قرمز بعد از حداقل ۲ کندل سبز",
          "تأیید قوی: کندل جدید بدون سایه‌ی مخالف (Flat bottom/top)",
          "حد ضرر: ۱.۵ برابر ATR · هدف‌ها: ۱.۵ و ۳ برابر ATR",
          "تا وقتی رنگ برنگشته در معامله بمان",
        ],
        tips: [
          "کندل‌های بدون سایه‌ی پایین در روند صعودی = قدرت فوق‌العاده",
          "بدنه‌های کوچک با سایه‌ی دوطرفه = تردید؛ آماده‌ی چرخش باش",
          "قیمتِ ورود واقعی، کلوز کندل عادی است نه هیکن‌آشی — سطح‌ها بر همین اساس محاسبه شده‌اند",
          "با یک فیلتر روند (EMA200) نتیجه بهتر می‌شود",
        ],
        best: "سوئینگ روی کریپتو، طلا و شاخص‌ها · تایم ۱ ساعته و روزانه",
      },
      en: {
        name: "Heikin-Ashi Flip",
        tagline: "Smoothed candles — see the trend without the noise",
        desc:
          "Heikin-Ashi averages away candle noise: consecutive green bodies mean a healthy uptrend. A color flip after an opposite streak signals a trend change — a swing-trader favorite for staying in trends.",
        rules: [
          "Buy: green HA candle after at least 2 red ones",
          "Sell: red HA candle after at least 2 green ones",
          "Strong confirm: the new candle has no opposite wick (flat bottom/top)",
          "Stop: 1.5× ATR · Targets: 1.5× and 3× ATR",
          "Stay in until the color flips back",
        ],
        tips: [
          "No lower wicks in an uptrend = exceptional strength",
          "Small bodies with two-sided wicks = doubt; prepare for a flip",
          "Real fills happen at normal-candle closes — levels use those",
          "An EMA200 trend filter improves results",
        ],
        best: "Swing trading crypto, gold, indices · 1H and daily",
      },
    },
    run(bars) {
      const ha = heikinAshi(bars);
      const atr = atrArr(bars);
      const green = (i) => ha[i].close > ha[i].open;
      const events = [];
      for (let i = 3; i < bars.length; i++) {
        const a = atr[i];
        if (a == null) continue;
        if (green(i) && !green(i - 1) && !green(i - 2))
          events.push(ev(bars, i, "BUY", atrLevels("BUY", bars[i].close, a)));
        else if (!green(i) && green(i - 1) && green(i - 2))
          events.push(ev(bars, i, "SELL", atrLevels("SELL", bars[i].close, a)));
      }
      const i = bars.length - 1;
      let streak = 1;
      while (i - streak >= 0 && green(i - streak) === green(i)) streak++;
      return {
        events,
        state: {
          bias: green(i) ? "BUY" : "SELL",
          reasons: [
            green(i)
              ? r(`${streak} کندل هیکن‌آشی سبز پشت‌سرهم`, `${streak} consecutive green HA candles`)
              : r(`${streak} کندل هیکن‌آشی قرمز پشت‌سرهم`, `${streak} consecutive red HA candles`),
          ],
        },
      };
    },
  },

  {
    id: "engulfing",
    icon: "🫂",
    category: "reversal",
    risk: 2,
    tfs: ["1h", "1d"],
    defaultTf: "1d",
    minBars: 40,
    meta: {
      fa: {
        name: "کندل پوششی (Engulfing) روی حمایت/مقاومت",
        tagline: "پرایس‌اکشن ناب — وقتی خریداران کنترل را می‌قاپند",
        desc:
          "کندل پوششی صعودی یعنی بدنه‌ی سبز کندل، کل بدنه‌ی قرمز قبلی را می‌بلعد — تغییر ناگهانی کنترل. وقتی این الگو نزدیک کف ۲۰ کندله رخ دهد، یکی از قوی‌ترین ستاپ‌های پرایس‌اکشن است.",
        rules: [
          "ورود خرید: کندل سبز که بدنه‌ی کندل قرمز قبلی را کامل بپوشاند، نزدیک کف ۲۰ کندله (حداکثر ۱ ATR فاصله)",
          "ورود فروش: پوششی نزولی نزدیک سقف ۲۰ کندله",
          "حد ضرر: زیر/بالای الگو + ۰.۳ ATR",
          "هدف‌ها: ۱.۵ و ۲.۵ برابر ریسک",
        ],
        tips: [
          "هرچه کندل پوششی بزرگ‌تر و حجمش بالاتر، سیگنال قوی‌تر",
          "پوششی وسط رنج بی‌ارزش است — فقط روی سطوح مهم",
          "اگر کندل بعدی الگو را تأیید نکرد (کلوز مخالف)، سریع خارج شو",
        ],
        best: "طلا و جفت‌ارزها روی سطوح روزانه · تایم ۱ ساعته و روزانه",
      },
      en: {
        name: "Engulfing at Support/Resistance",
        tagline: "Pure price action — the moment buyers seize control",
        desc:
          "A bullish engulfing candle's green body swallows the prior red body — an abrupt change of control. Near a 20-bar low it's one of the strongest price-action setups there is.",
        rules: [
          "Buy: green candle fully engulfing the prior red body, within 1 ATR of the 20-bar low",
          "Sell: bearish engulfing near the 20-bar high",
          "Stop: beyond the pattern ± 0.3 ATR",
          "Targets: 1.5× and 2.5× the risk",
        ],
        tips: [
          "The bigger the engulfing candle and its volume, the stronger the signal",
          "Mid-range engulfings are worthless — only at meaningful levels",
          "If the next candle fails to confirm, exit fast",
        ],
        best: "Gold and FX at daily levels · 1H and daily",
      },
    },
    run(bars) {
      const atr = atrArr(bars);
      const { upper, lower } = donchianArr(bars, 20);
      const events = [];
      for (let i = 21; i < bars.length; i++) {
        const a = atr[i], b = bars[i], p = bars[i - 1];
        if (a == null || lower[i - 1] == null) continue;
        const bullish = b.close > b.open && p.close < p.open &&
          b.close >= p.open && b.open <= p.close && b.low <= lower[i - 1] + a;
        const bearish = b.close < b.open && p.close > p.open &&
          b.close <= p.open && b.open >= p.close && b.high >= upper[i - 1] - a;
        if (bullish) {
          const sl = Math.min(b.low, p.low) - 0.3 * a;
          const rsk = Math.max(b.close - sl, 1e-9);
          events.push({ i, time: b.time, dir: "BUY", entry: b.close, sl, tp1: b.close + 1.5 * rsk, tp2: b.close + 2.5 * rsk });
        } else if (bearish) {
          const sl = Math.max(b.high, p.high) + 0.3 * a;
          const rsk = Math.max(sl - b.close, 1e-9);
          events.push({ i, time: b.time, dir: "SELL", entry: b.close, sl, tp1: b.close - 1.5 * rsk, tp2: b.close - 2.5 * rsk });
        }
      }
      return {
        events,
        state: {
          bias: null,
          reasons: [r("منتظر الگوی پوششی روی سقف/کف ۲۰ کندله", "Waiting for an engulfing at the 20-bar high/low")],
        },
      };
    },
  },

  {
    id: "pinbar",
    icon: "📍",
    category: "reversal",
    risk: 2,
    tfs: ["1h", "1d"],
    defaultTf: "1d",
    minBars: 40,
    meta: {
      fa: {
        name: "پین‌بار روی سطح",
        tagline: "رد قیمت — بازار به تو می‌گوید کجا نمی‌خواهد برود",
        desc:
          "پین‌بار (چکش) کندلی است با سایه‌ی بلند و بدنه‌ی کوچک: قیمت به سطحی حمله کرد و با قدرت پس زده شد. سایه‌ی بلندِ پایین نزدیک کف ۲۰ کندله = ردِ قیمت‌های پایین‌تر توسط خریداران.",
        rules: [
          "ورود خرید: سایه‌ی پایینی ≥ ۲ برابر بدنه، کلوز در یک‌سوم بالایی کندل، نزدیک کف ۲۰ کندله",
          "ورود فروش: برعکس، نزدیک سقف",
          "حد ضرر: آن‌سوی نوک سایه + ۰.۲ ATR",
          "هدف‌ها: ۱.۵ و ۲.۵ برابر ریسک",
        ],
        tips: [
          "پین‌بار تایم روزانه ارزش چند برابر پین‌بار تایم پایین را دارد",
          "ورود محتاطانه: ۵۰٪ اصلاح پین‌بار به‌جای کلوز — ریسک/بازده بهتر",
          "پین‌بار همراه واگرایی RSI = ستاپ رویایی",
        ],
        best: "سطوح مهم طلا، شاخص و جفت‌ارز · تایم روزانه",
      },
      en: {
        name: "Pin Bar at a Level",
        tagline: "Price rejection — the market tells you where it refuses to go",
        desc:
          "A pin bar (hammer) has a long wick and tiny body: price attacked a level and got violently rejected. A long lower wick near the 20-bar low = buyers rejecting lower prices.",
        rules: [
          "Buy: lower wick ≥ 2× body, close in the top third, near the 20-bar low",
          "Sell: the mirror at the 20-bar high",
          "Stop: beyond the wick tip + 0.2 ATR",
          "Targets: 1.5× and 2.5× the risk",
        ],
        tips: [
          "A daily pin bar is worth several intraday ones",
          "Conservative entry: the 50% retrace of the pin instead of the close",
          "Pin bar + RSI divergence = dream setup",
        ],
        best: "Key levels on gold, indices, FX · Daily",
      },
    },
    run(bars) {
      const atr = atrArr(bars);
      const { upper, lower } = donchianArr(bars, 20);
      const events = [];
      for (let i = 21; i < bars.length; i++) {
        const a = atr[i], b = bars[i];
        if (a == null || lower[i - 1] == null) continue;
        const body = Math.abs(b.close - b.open) || 1e-9;
        const upWick = b.high - Math.max(b.open, b.close);
        const dnWick = Math.min(b.open, b.close) - b.low;
        const range = b.high - b.low || 1e-9;
        const bullish = dnWick >= 2 * body && (b.close - b.low) / range >= 0.66 &&
          b.low <= lower[i - 1] + a;
        const bearish = upWick >= 2 * body && (b.high - b.close) / range >= 0.66 &&
          b.high >= upper[i - 1] - a;
        if (bullish) {
          const sl = b.low - 0.2 * a;
          const rsk = Math.max(b.close - sl, 1e-9);
          events.push({ i, time: b.time, dir: "BUY", entry: b.close, sl, tp1: b.close + 1.5 * rsk, tp2: b.close + 2.5 * rsk });
        } else if (bearish) {
          const sl = b.high + 0.2 * a;
          const rsk = Math.max(sl - b.close, 1e-9);
          events.push({ i, time: b.time, dir: "SELL", entry: b.close, sl, tp1: b.close - 1.5 * rsk, tp2: b.close - 2.5 * rsk });
        }
      }
      return {
        events,
        state: {
          bias: null,
          reasons: [r("منتظر پین‌بار روی سقف/کف ۲۰ کندله", "Waiting for a pin bar at the 20-bar high/low")],
        },
      };
    },
  },

  {
    id: "inside-bar",
    icon: "📦",
    category: "breakout",
    risk: 2,
    tfs: ["1h", "1d"],
    defaultTf: "1d",
    minBars: 40,
    meta: {
      fa: {
        name: "شکست اینساید بار",
        tagline: "فشردگی یک‌کندله — انفجار در جهت شکست",
        desc:
          "اینساید بار کندلی است که کاملاً داخل محدوده‌ی کندل قبلی (کندل مادر) جا می‌گیرد: بازار نفسش را حبس کرده. شکست سقف یا کف کندل مادر معمولاً حرکت تند و تمیزی می‌دهد.",
        rules: [
          "ستاپ: کندل کاملاً داخل محدوده‌ی کندل قبلی",
          "ورود خرید: کلوز بالای سقف کندل مادر",
          "ورود فروش: کلوز زیر کف کندل مادر",
          "حد ضرر: طرف مقابل کندل مادر",
          "هدف‌ها: ۱.۵ و ۳ برابر ریسک",
        ],
        tips: [
          "اینساید بار در جهت روند غالب معتبرتر است (ادامه‌دهنده)",
          "چند اینساید بار پشت‌سرهم (فشردگی چندکندله) = انفجار بزرگ‌تر",
          "در تایم پایین‌تر از ۱ ساعت پر از تله است",
        ],
        best: "روندهای تمیز طلا و شاخص · تایم روزانه",
      },
      en: {
        name: "Inside Bar Breakout",
        tagline: "One-candle compression — explode in the break's direction",
        desc:
          "An inside bar sits entirely within the prior (mother) bar's range: the market is holding its breath. Breaking the mother bar's high or low usually delivers a fast, clean move.",
        rules: [
          "Setup: a candle fully inside the previous candle's range",
          "Buy: close above the mother bar's high",
          "Sell: close below the mother bar's low",
          "Stop: the opposite side of the mother bar",
          "Targets: 1.5× and 3× the risk",
        ],
        tips: [
          "Inside bars with the dominant trend are more reliable (continuation)",
          "Multiple stacked inside bars = a bigger explosion",
          "Below 1H it's full of traps",
        ],
        best: "Clean trends in gold and indices · Daily",
      },
    },
    run(bars) {
      const atr = atrArr(bars);
      const events = [];
      for (let i = 2; i < bars.length; i++) {
        const a = atr[i];
        if (a == null) continue;
        const inside = bars[i - 1], mother = bars[i - 2], b = bars[i];
        if (!(inside.high <= mother.high && inside.low >= mother.low)) continue;
        if (b.close > mother.high && b.close > b.open) {
          const sl = mother.low;
          const rsk = Math.max(b.close - sl, 1e-9);
          events.push({ i, time: b.time, dir: "BUY", entry: b.close, sl, tp1: b.close + 1.5 * rsk, tp2: b.close + 3 * rsk });
        } else if (b.close < mother.low && b.close < b.open) {
          const sl = mother.high;
          const rsk = Math.max(sl - b.close, 1e-9);
          events.push({ i, time: b.time, dir: "SELL", entry: b.close, sl, tp1: b.close - 1.5 * rsk, tp2: b.close - 3 * rsk });
        }
      }
      const i = bars.length - 1;
      const isInside = i >= 1 && bars[i].high <= bars[i - 1].high && bars[i].low >= bars[i - 1].low;
      return {
        events,
        state: {
          bias: null,
          reasons: [
            isInside
              ? r("کندل فعلی اینساید بار است — منتظر شکست سقف/کف کندل مادر", "Current candle is an inside bar — watch the mother bar's high/low")
              : r("اینساید بار فعالی نیست", "No active inside bar"),
          ],
        },
      };
    },
  },

  {
    id: "rsi2-connors",
    icon: "🎯",
    category: "reversal",
    risk: 2,
    tfs: ["1h", "1d"],
    defaultTf: "1d",
    minBars: 210,
    meta: {
      fa: {
        name: "RSI-2 لری کانرز",
        tagline: "افت‌های کوتاه در روند صعودی را بخر — آماری‌ترین استراتژی",
        desc:
          "لری کانرز نشان داد RSI دو-دوره‌ای زیر ۱۰، وقتی قیمت بالای SMA200 است، از نظر آماری یکی از پرسودترین ستاپ‌های بازار سهام است: خرید ترسِ کوتاه‌مدت داخل روند بلندمدت صعودی.",
        rules: [
          "شرط روند: قیمت بالای SMA200 (برای خرید)",
          "ورود خرید: RSI(2) زیر ۱۰ (زیر ۵ حتی بهتر)",
          "ورود فروش: قیمت زیر SMA200 و RSI(2) بالای ۹۰",
          "هدف ۱: میانگین SMA5 (خروج کلاسیک کانرز) · هدف ۲: دو برابر ریسک",
          "حد ضرر: ۱.۵ برابر ATR",
        ],
        tips: [
          "کانرز اصلاً حد ضرر نمی‌گذاشت و با زمان خارج می‌شد — نسخه‌ی ما محافظه‌کارتر است",
          "بهترین عملکرد: سهام و شاخص‌ها؛ در کریپتو با احتیاط",
          "چند ورود پله‌ای (RSI2 زیر ۱۰، بعد زیر ۵) میانگین بهتری می‌دهد",
        ],
        best: "شاخص‌ها و سهام بزرگ در روند صعودی · تایم روزانه",
      },
      en: {
        name: "Larry Connors RSI-2",
        tagline: "Buy shallow dips in uptrends — the most statistical strategy",
        desc:
          "Larry Connors showed that a 2-period RSI below 10 while price holds above the SMA200 is statistically one of the most profitable equity setups: buying short-term fear inside a long-term uptrend.",
        rules: [
          "Trend filter: price above SMA200 (for longs)",
          "Buy: RSI(2) below 10 (below 5 even better)",
          "Sell: price below SMA200 and RSI(2) above 90",
          "TP1: the SMA5 (Connors' classic exit) · TP2: 2× risk",
          "Stop: 1.5× ATR",
        ],
        tips: [
          "Connors used no stop and exited on time — our version is more conservative",
          "Best on stocks and indices; use caution on crypto",
          "Scaling in (RSI2 <10, then <5) improves the average",
        ],
        best: "Indices and large caps in uptrends · Daily",
      },
    },
    run(bars) {
      const c = closes(bars);
      const rsi2 = rsiArr(bars, 2);
      const s200 = smaArr(c, 200), s5 = smaArr(c, 5);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || rsi2[i] == null || s200[i] == null) continue;
        const buyCond = c[i] > s200[i] && rsi2[i] < 10;
        const prevBuy = rsi2[i - 1] != null && c[i - 1] > (s200[i - 1] ?? Infinity) && rsi2[i - 1] < 10;
        const sellCond = c[i] < s200[i] && rsi2[i] > 90;
        const prevSell = rsi2[i - 1] != null && c[i - 1] < (s200[i - 1] ?? -Infinity) && rsi2[i - 1] > 90;
        if (buyCond && !prevBuy) {
          const sl = c[i] - 1.5 * a;
          const tp1 = Math.max(s5[i] ?? c[i] + a, c[i] + 0.5 * a);
          events.push({ i, time: bars[i].time, dir: "BUY", entry: c[i], sl, tp1, tp2: c[i] + 3 * a });
        } else if (sellCond && !prevSell) {
          const sl = c[i] + 1.5 * a;
          const tp1 = Math.min(s5[i] ?? c[i] - a, c[i] - 0.5 * a);
          events.push({ i, time: bars[i].time, dir: "SELL", entry: c[i], sl, tp1, tp2: c[i] - 3 * a });
        }
      }
      const i = bars.length - 1;
      const above = s200[i] != null && c[i] > s200[i];
      return {
        events,
        state: {
          bias: null,
          reasons: [
            above
              ? r("قیمت بالای SMA200 — فقط ستاپ خرید معتبر", "Above SMA200 — only long setups are valid")
              : r("قیمت زیر SMA200 — فقط ستاپ فروش معتبر", "Below SMA200 — only short setups are valid"),
            rsi2[i] != null
              ? r(`RSI(2) = ${rsi2[i].toFixed(1)}`, `RSI(2) = ${rsi2[i].toFixed(1)}`)
              : r("RSI(2) ناقص", "RSI(2) incomplete"),
          ],
        },
      };
    },
  },

  {
    id: "ttm-squeeze",
    icon: "🧨",
    category: "breakout",
    risk: 3,
    tfs: ["1m", "5m", "15m", "1h", "1d"],
    defaultTf: "1d",
    minBars: 60,
    meta: {
      fa: {
        name: "TTM Squeeze (بولینگر داخل کلتنر)",
        tagline: "نسخه‌ی حرفه‌ای فشردگی — سیگنال جان کارتر",
        desc:
          "وقتی باند بولینگر کاملاً داخل کانال کلتنر جمع شود، «اسکوییز» روشن است: نوسان به‌شدت فشرده شده. آزاد شدن اسکوییز (خروج بولینگر از کلتنر) همراه با جهت مومنتوم، سیگنال ورود جان کارتر است.",
        rules: [
          "اسکوییز روشن: باند بولینگر (۲۰،۲σ) داخل کانال کلتنر (۲۰، ۱.۵×ATR)",
          "ورود: اولین کندل بعد از آزاد شدن اسکوییز، در جهت مومنتوم (قیمت نسبت به SMA20)",
          "حد ضرر: ۱.۵ برابر ATR · هدف‌ها: ۲ و ۴ برابر ATR",
          "حداقل ۴ کندل اسکوییز قبل از آزاد شدن",
        ],
        tips: [
          "اسکوییزهای طولانی (۱۰+ کندل) قوی‌ترین حرکت‌ها را می‌دهند",
          "هیستوگرام مومنتوم در حال رشد = تأیید جهت",
          "بعد از حرکت اول، پولبک اول معمولاً قابل‌معامله است",
        ],
        best: "سهام پرنوسان، کریپتو، طلا · تایم ۱ ساعته و روزانه",
      },
      en: {
        name: "TTM Squeeze (Bollinger inside Keltner)",
        tagline: "The pro squeeze — John Carter's signal",
        desc:
          "When the Bollinger bands compress fully inside the Keltner channel the squeeze is ON: volatility is coiled hard. The squeeze firing (Bollinger exiting Keltner) with the momentum direction is John Carter's entry.",
        rules: [
          "Squeeze on: Bollinger (20, 2σ) inside Keltner (20, 1.5×ATR)",
          "Enter on the first candle after the squeeze fires, in the momentum direction (price vs SMA20)",
          "Stop: 1.5× ATR · Targets: 2× and 4× ATR",
          "Require at least 4 squeeze candles before the fire",
        ],
        tips: [
          "Long squeezes (10+ bars) produce the strongest moves",
          "A growing momentum histogram confirms the direction",
          "The first pullback after the initial move is usually tradable",
        ],
        best: "Volatile stocks, crypto, gold · 1H and daily",
      },
    },
    run(bars) {
      const c = closes(bars);
      const { upper: bbU, lower: bbL } = bollArr(bars);
      const s20 = smaArr(c, 20);
      const e20 = emaArr(c, 20);
      const atr20 = atrArr(bars, 20);
      const atr = atrArr(bars);
      const n = bars.length;
      const sq = new Array(n).fill(false);
      for (let i = 0; i < n; i++) {
        if (bbU[i] == null || e20[i] == null || atr20[i] == null) continue;
        const kcU = e20[i] + 1.5 * atr20[i], kcL = e20[i] - 1.5 * atr20[i];
        sq[i] = bbU[i] < kcU && bbL[i] > kcL;
      }
      const events = [];
      for (let i = 5; i < n; i++) {
        const a = atr[i];
        if (a == null || s20[i] == null) continue;
        const fired = !sq[i] && sq[i - 1] && sq[i - 2] && sq[i - 3] && sq[i - 4];
        if (!fired) continue;
        if (c[i] > s20[i]) events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 1.5, 2, 4)));
        else events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 1.5, 2, 4)));
      }
      const i = n - 1;
      let len = 0;
      for (let j = i; j >= 0 && sq[j]; j--) len++;
      return {
        events,
        state: {
          bias: null,
          reasons: [
            sq[i]
              ? r(`اسکوییز روشن — ${len} کندل فشردگی؛ منتظر آزاد شدن`, `Squeeze ON — ${len} bars compressed; wait for the fire`)
              : r("اسکوییز خاموش — نوسان عادی", "Squeeze OFF — normal volatility"),
          ],
        },
      };
    },
  },

  {
    id: "orb",
    icon: "🌅",
    category: "scalp",
    risk: 3,
    tfs: ["1m", "5m", "15m"],
    defaultTf: "1m",
    minBars: 40,
    intradayOnly: true,
    meta: {
      fa: {
        name: "شکست محدوده‌ی بازگشایی (ORB)",
        tagline: "اولین حرکت روز، جهت روز را می‌سازد",
        desc:
          "سقف و کف ساعت اول معاملات (Opening Range) مرز نبرد خریداران و فروشندگان روز است. شکست این محدوده معمولاً جهت باقی روز را تعیین می‌کند — استراتژی محبوب دی‌تریدرهای سهام و شاخص.",
        rules: [
          "محدوده: سقف/کف ۶ کندل اول روز (۳۰-۹۰ دقیقه‌ی اول بسته به تایم‌فریم)",
          "ورود خرید: اولین کلوز بالای سقف محدوده",
          "ورود فروش: اولین کلوز زیر کف محدوده",
          "حد ضرر: طرف مقابل محدوده",
          "هدف ۱: به‌اندازه‌ی ارتفاع محدوده · هدف ۲: دو برابر",
          "حداکثر یک سیگنال در هر روز و هر جهت",
        ],
        tips: [
          "محدوده‌های باریک بهترین ریسک/بازده را می‌دهند",
          "شکست در ۳۰ دقیقه‌ی اول بعد از بسته شدن محدوده معتبرتر است",
          "روزهای خبری (NFP/FOMC) محدوده را دیر بشکن — اسپایک دوطرفه می‌زند",
          "مرز روز بر اساس UTC محاسبه می‌شود؛ برای سشن نیویورک حواست به اختلاف باشد",
        ],
        best: "شاخص‌ها، سهام پرحجم، طلا · تایم ۵ و ۱۵ دقیقه",
      },
      en: {
        name: "Opening Range Breakout (ORB)",
        tagline: "The day's first move sets the day's direction",
        desc:
          "The first trading hour's high/low (opening range) is the day's battle line. Breaking it usually sets the direction for the rest of the session — a day-trading staple on stocks and indices.",
        rules: [
          "Range: high/low of the day's first 6 candles (30-90 min by timeframe)",
          "Buy: first close above the range high",
          "Sell: first close below the range low",
          "Stop: the opposite side of the range",
          "TP1: one range-height · TP2: two",
          "Max one signal per day per direction",
        ],
        tips: [
          "Narrow ranges give the best risk/reward",
          "Breaks within 30 min of the range completing are more reliable",
          "On news days (NFP/FOMC) wait out the two-way spike",
          "Day boundaries use UTC; mind the offset for the NY session",
        ],
        best: "Indices, liquid stocks, gold · 5m and 15m",
      },
    },
    run(bars) {
      const events = [];
      const day = (t) => Math.floor(t / 86400);
      const OR = 6;
      let d = null, orHigh = null, orLow = null, count = 0, buyDone = false, sellDone = false;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (day(b.time) !== d) {
          d = day(b.time);
          orHigh = -Infinity;
          orLow = Infinity;
          count = 0;
          buyDone = false;
          sellDone = false;
        }
        if (count < OR) {
          orHigh = Math.max(orHigh, b.high);
          orLow = Math.min(orLow, b.low);
          count++;
          continue;
        }
        const height = orHigh - orLow;
        if (height <= 0) continue;
        if (!buyDone && b.close > orHigh) {
          buyDone = true;
          events.push({ i, time: b.time, dir: "BUY", entry: b.close, sl: orLow, tp1: b.close + height, tp2: b.close + 2 * height });
        } else if (!sellDone && b.close < orLow) {
          sellDone = true;
          events.push({ i, time: b.time, dir: "SELL", entry: b.close, sl: orHigh, tp1: b.close - height, tp2: b.close - 2 * height });
        }
      }
      const last = bars[bars.length - 1];
      const inRange = count < OR;
      return {
        events,
        state: {
          bias: null,
          reasons: [
            inRange
              ? r("محدوده‌ی بازگشایی هنوز در حال شکل‌گیری است", "Opening range still forming")
              : orHigh != null && isFinite(orHigh)
                ? r(`محدوده‌ی امروز: ${orLow.toFixed(2)} تا ${orHigh.toFixed(2)} — قیمت: ${last.close.toFixed(2)}`,
                    `Today's range: ${orLow.toFixed(2)} – ${orHigh.toFixed(2)} — price: ${last.close.toFixed(2)}`)
                : r("داده‌ی روز ناکافی", "Not enough session data"),
          ],
        },
      };
    },
  },

  {
    id: "elder-triple",
    icon: "🖥️",
    category: "trend",
    risk: 1,
    tfs: ["1h", "1d"],
    defaultTf: "1d",
    minBars: 120,
    meta: {
      fa: {
        name: "سه صفحه‌ی الدر (Triple Screen)",
        tagline: "جزر و مد، موج، و امواج کوچک — سیستم کامل دکتر الدر",
        desc:
          "الکساندر الدر: در تایم بالاتر جهت «جزر و مد» را بگیر، در تایم فعلی منتظر «موج» مخالف (پولبک) بمان و همان‌جا سوار شو. اینجا تایم بالاتر با تجمیع ۴ کندل ساخته می‌شود و پولبک با استوکاستیک سنجیده می‌شود.",
        rules: [
          "صفحه ۱: شیب EMA13 تایم بالاتر (×۴) صعودی باشد → فقط خرید",
          "صفحه ۲: استوکاستیک تایم فعلی به اشباع فروش (<۳۰) برود",
          "صفحه ۳ (ورود): استوکاستیک از اشباع برگردد (چرخش به بالا)",
          "حد ضرر: ۱.۵ برابر ATR زیر کف اخیر",
          "هدف‌ها: ۲ و ۴ برابر ATR",
        ],
        tips: [
          "قانون طلایی الدر: هرگز خلاف جزر و مد (تایم بالاتر) معامله نکن",
          "اگر استوکاستیک بدون رسیدن به اشباع برگشت، سیگنال ضعیف است",
          "الدر خودش خرید را با شکست سقف کندل قبل انجام می‌داد (buy-stop)",
        ],
        best: "همه بازارهای روندی · ترکیب روزانه/هفتگی یا ۱ ساعته/۴ ساعته",
      },
      en: {
        name: "Elder's Triple Screen",
        tagline: "Tide, wave, and ripple — Dr. Elder's complete system",
        desc:
          "Alexander Elder: read the tide on the higher timeframe, wait for the opposing wave (pullback) on the current one, and board there. Here the higher TF is built by aggregating 4 candles and the pullback is measured with the stochastic.",
        rules: [
          "Screen 1: higher-TF (×4) EMA13 slope rising → longs only",
          "Screen 2: current-TF stochastic reaches oversold (<30)",
          "Screen 3 (entry): stochastic turns back up from the extreme",
          "Stop: 1.5× ATR below the recent low",
          "Targets: 2× and 4× ATR",
        ],
        tips: [
          "Elder's golden rule: never trade against the tide",
          "A stochastic turn that never reached the extreme is weak",
          "Elder himself entered on a buy-stop above the prior bar's high",
        ],
        best: "Any trending market · daily/weekly or 1H/4H combos",
      },
    },
    run(bars) {
      const higher = resampleBars(bars, 4);
      const hEma = emaArr(higher.map((b) => b.close), 13);
      // Map each bar index → higher-TF EMA slope at that time.
      const slopeAt = (i) => {
        const hi = Math.floor(i / 4);
        if (hi < 1 || hEma[hi] == null || hEma[hi - 1] == null) return null;
        return hEma[hi] - hEma[hi - 1];
      };
      const { k, d } = stochArrs(bars);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 2; i < bars.length; i++) {
        const a = atr[i], sl4 = slopeAt(i);
        if (a == null || sl4 == null || k[i] == null || k[i - 1] == null) continue;
        const turnUp = k[i - 1] < 30 && k[i] > k[i - 1] && crossUp(k, d, i);
        const turnDown = k[i - 1] > 70 && k[i] < k[i - 1] && crossDown(k, d, i);
        if (sl4 > 0 && turnUp)
          events.push(ev(bars, i, "BUY", atrLevels("BUY", bars[i].close, a, 1.5, 2, 4)));
        else if (sl4 < 0 && turnDown)
          events.push(ev(bars, i, "SELL", atrLevels("SELL", bars[i].close, a, 1.5, 2, 4)));
      }
      const i = bars.length - 1;
      const tide = slopeAt(i);
      return {
        events,
        state: {
          bias: tide == null ? null : tide > 0 ? "BUY" : "SELL",
          reasons: [
            tide == null
              ? r("روند تایم بالاتر ناقص", "Higher-TF tide incomplete")
              : tide > 0
                ? r("جزر و مد (تایم ×۴) صعودی — فقط دنبال خرید باش", "Tide (×4 TF) rising — hunt longs only")
                : r("جزر و مد (تایم ×۴) نزولی — فقط دنبال فروش باش", "Tide (×4 TF) falling — hunt shorts only"),
            k[i] != null
              ? r(`استوکاستیک %K = ${k[i].toFixed(1)}`, `Stochastic %K = ${k[i].toFixed(1)}`)
              : r("استوکاستیک ناقص", "Stochastic incomplete"),
          ],
        },
      };
    },
  },

  {
    id: "ema-ribbon",
    icon: "🎀",
    category: "trend",
    risk: 1,
    tfs: ["1h", "1d", "1wk"],
    defaultTf: "1d",
    minBars: 70,
    meta: {
      fa: {
        name: "روبان EMA (8/13/21/34/55)",
        tagline: "وقتی همه‌ی میانگین‌ها به صف می‌شوند، روند واقعی است",
        desc:
          "پنج EMA فیبوناچی روی هم یک «روبان» می‌سازند: وقتی به ترتیب کامل (۸ بالای ۱۳ بالای ۲۱…) مرتب شوند روند تثبیت شده است. لحظه‌ی مرتب‌شدن، سیگنال ورود کم‌ریسک به روند تازه است.",
        rules: [
          "ورود خرید: هر ۵ میانگین به ترتیب صعودی مرتب شوند (تازه)",
          "ورود فروش: ترتیب نزولی کامل",
          "حد ضرر: ۲ برابر ATR یا زیر EMA55",
          "هدف‌ها: ۲ و ۴ برابر ATR",
          "خروج: به‌هم‌خوردن ترتیب روبان",
        ],
        tips: [
          "پولبک به داخل روبان که ترتیب حفظ شود = ورود دوم عالی",
          "روبانِ باز و پهن = روند قوی؛ روبان جمع‌شده = آماده‌ی چرخش",
          "در بازار رنج روبان مدام گره می‌خورد — با ADX فیلتر کن",
        ],
        best: "کریپتو و روندهای بلند طلا · تایم روزانه",
      },
      en: {
        name: "EMA Ribbon (8/13/21/34/55)",
        tagline: "When every average falls in line, the trend is real",
        desc:
          "Five Fibonacci EMAs form a ribbon: full ordering (8 above 13 above 21…) means an established trend. The moment alignment completes is a low-risk entry into a fresh trend.",
        rules: [
          "Buy: all 5 EMAs freshly stacked in ascending order",
          "Sell: full descending order",
          "Stop: 2× ATR or below the EMA55",
          "Targets: 2× and 4× ATR",
          "Exit when the ribbon tangles",
        ],
        tips: [
          "A pullback into the ribbon that keeps the order = great second entry",
          "A wide-open ribbon = strong trend; a compressing one = turn brewing",
          "Ranges tangle the ribbon constantly — filter with ADX",
        ],
        best: "Crypto and long gold trends · Daily",
      },
    },
    run(bars) {
      const c = closes(bars);
      const emas = [8, 13, 21, 34, 55].map((p) => emaArr(c, p));
      const aligned = (i, dirUp) => {
        for (let j = 0; j < emas.length; j++) if (emas[j][i] == null) return false;
        for (let j = 0; j < emas.length - 1; j++) {
          if (dirUp && emas[j][i] <= emas[j + 1][i]) return false;
          if (!dirUp && emas[j][i] >= emas[j + 1][i]) return false;
        }
        return true;
      };
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null) continue;
        if (aligned(i, true) && !aligned(i - 1, true))
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 2, 2, 4)));
        else if (aligned(i, false) && !aligned(i - 1, false))
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 2, 2, 4)));
      }
      const i = bars.length - 1;
      let upCount = 0;
      for (let j = 0; j < emas.length - 1; j++)
        if (emas[j][i] != null && emas[j + 1][i] != null && emas[j][i] > emas[j + 1][i]) upCount++;
      return {
        events,
        state: {
          bias: aligned(i, true) ? "BUY" : aligned(i, false) ? "SELL" : null,
          reasons: [
            aligned(i, true)
              ? r("روبان کاملاً صعودی مرتب است", "Ribbon fully stacked bullish")
              : aligned(i, false)
                ? r("روبان کاملاً نزولی مرتب است", "Ribbon fully stacked bearish")
                : r(`روبان گره خورده (${upCount}/4 جفت صعودی)`, `Ribbon tangled (${upCount}/4 pairs bullish)`),
          ],
        },
      };
    },
  },
  {
    id: "scalp-ema-vwap",
    icon: "🔫",
    category: "scalp",
    risk: 3,
    tfs: ["1m", "5m"],
    defaultTf: "1m",
    minBars: 60,
    intradayOnly: true,
    meta: {
      fa: {
        name: "اسکالپ EMA 9/21 + فیلتر VWAP",
        tagline: "استاندارد طلایی اسکالپ ۱ دقیقه — فقط هم‌جهت با پول هوشمند",
        desc:
          "ترکیب محبوب اسکالپرهای حرفه‌ای روی تایم ۱ دقیقه: تقاطع EMA9/EMA21 سیگنال می‌دهد اما فقط وقتی معتبر است که قیمت همان سمت VWAP باشد — یعنی هم‌جهت با جریان سفارش‌های نهادی. حد ضرر و هدف‌ها عمداً تنگ‌اند چون اسکالپ یعنی سود کوچکِ پرتکرار.",
        rules: [
          "ورود خرید: عبور EMA9 به بالای EMA21 در حالی که قیمت بالای VWAP است",
          "ورود فروش: عبور EMA9 به پایین EMA21 در حالی که قیمت زیر VWAP است",
          "حد ضرر: ۱ برابر ATR (تنگ — اسکالپ است)",
          "هدف ۱: ۱ برابر ATR · هدف ۲: ۲ برابر ATR",
          "تقاطع خلاف سمت VWAP = بدون معامله",
        ],
        tips: [
          "بهترین ساعات: همپوشانی لندن/نیویورک (۱۶:۳۰ تا ۲۰:۳۰ تهران) — اسپرد کم و حرکت زیاد",
          "بعد از ۲ ضرر پشت‌سرهم چند دقیقه دست نگه دار؛ بازار رنج شده",
          "اسپرد بروکر را از سود هر معامله کم کن — روی ۱ دقیقه اسپرد نصف بازی است",
          "اخبار مهم (NFP، FOMC) اسکالپ را متوقف کن؛ اسپایک دوطرفه SL را می‌زند",
        ],
        best: "طلا، شاخص‌ها و جفت‌ارزهای اصلی · تایم ۱ دقیقه · سشن‌های پرحجم",
      },
      en: {
        name: "EMA 9/21 + VWAP Scalp",
        tagline: "The gold standard of 1-minute scalping — only with the smart money",
        desc:
          "The pro scalper's staple on the 1-minute chart: the EMA9/EMA21 cross fires the signal but it only counts when price sits on the same side of VWAP — i.e. aligned with institutional order flow. Stops and targets are deliberately tight; scalping is small profits, many times.",
        rules: [
          "Buy: EMA9 crosses above EMA21 while price is above VWAP",
          "Sell: EMA9 crosses below EMA21 while price is below VWAP",
          "Stop: 1× ATR (tight — it's a scalp)",
          "TP1: 1× ATR · TP2: 2× ATR",
          "Cross against the VWAP side = no trade",
        ],
        tips: [
          "Best hours: the London/NY overlap — tight spreads, real movement",
          "After 2 straight losses stand aside a few minutes; the market went rangy",
          "Subtract the broker spread from every expected win — on 1m it's half the game",
          "Stop scalping around big news (NFP, FOMC); two-way spikes eat stops",
        ],
        best: "Gold, indices, major FX pairs · 1-minute · high-volume sessions",
      },
    },
    run(bars, intraday) {
      const c = closes(bars);
      const e9 = emaArr(c, 9), e21 = emaArr(c, 21);
      const vw = vwapArr(bars, intraday !== false);
      const atr = atrArr(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || vw[i] == null) continue;
        if (crossUp(e9, e21, i) && c[i] > vw[i])
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 1, 1, 2)));
        else if (crossDown(e9, e21, i) && c[i] < vw[i])
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 1, 1, 2)));
      }
      const i = bars.length - 1;
      const aboveV = vw[i] != null && c[i] > vw[i];
      const fastUp = e9[i] != null && e21[i] != null && e9[i] > e21[i];
      return {
        events,
        state: {
          bias: vw[i] == null || e9[i] == null ? null : aboveV && fastUp ? "BUY" : !aboveV && !fastUp ? "SELL" : null,
          reasons: [
            vw[i] == null
              ? r("VWAP هنوز شکل نگرفته", "VWAP not formed yet")
              : aboveV
                ? r("قیمت بالای VWAP — فقط دنبال خرید باش", "Price above VWAP — hunt longs only")
                : r("قیمت زیر VWAP — فقط دنبال فروش باش", "Price below VWAP — hunt shorts only"),
            e9[i] != null && e21[i] != null
              ? fastUp
                ? r("EMA9 بالای EMA21 — مومنتوم صعودی", "EMA9 above EMA21 — bullish momentum")
                : r("EMA9 زیر EMA21 — مومنتوم نزولی", "EMA9 below EMA21 — bearish momentum")
              : r("میانگین‌ها ناقص", "EMAs incomplete"),
          ],
        },
      };
    },
  },

  {
    id: "scalp-rsi-snap",
    icon: "🏹",
    category: "scalp",
    risk: 3,
    tfs: ["1m", "5m"],
    defaultTf: "1m",
    minBars: 40,
    intradayOnly: true,
    meta: {
      fa: {
        name: "اسکالپ برگشت RSI(7)",
        tagline: "شکار برگشت‌های سریع از اشباع — مخصوص ۱ دقیقه",
        desc:
          "روی تایم ۱ دقیقه RSI کلاسیک ۱۴ کند است؛ RSI(7) سریع‌تر واکنش می‌دهد. وقتی RSI7 از زیر ۲۵ به بالا برگردد فنر فشرده‌ی فروش رها شده — و فیلتر VWAP نمی‌گذارد خلاف جریان روز بایستی. ورود دقیقاً روی کندل برگشت است، نه داخل اشباع.",
        rules: [
          "ورود خرید: عبور RSI(7) از پایین به بالای ۲۵، فقط وقتی قیمت بالای VWAP است",
          "ورود فروش: عبور RSI(7) از بالا به پایین ۷۵، فقط وقتی قیمت زیر VWAP است",
          "حد ضرر: ۱ برابر ATR",
          "هدف ۱: ۱ برابر ATR · هدف ۲: ۲ برابر ATR",
          "داخل اشباع ورود نکن — صبر کن RSI برگردد (تیر را وقتی رها کن که کمان کشیده شد)",
        ],
        tips: [
          "در روند قوی یک‌طرفه RSI مدام در اشباع می‌ماند — این ستاپ را در ساعات رنج/چرخشی بزن",
          "اگر کندل برگشت حجم بالاتر از میانگین داشته باشد سیگنال قوی‌تر است",
          "بهترین جفت با «اسکالپ EMA+VWAP»: یکی برگشتی، یکی روندی — هر بازار یکی را می‌پسندد",
        ],
        best: "طلا و کریپتو · تایم ۱ دقیقه · بازارهای پرنوسان ولی بدون روند قوی",
      },
      en: {
        name: "RSI(7) Snap-back Scalp",
        tagline: "Hunting fast snap-backs from exhaustion — built for the 1-minute",
        desc:
          "On the 1-minute chart the classic RSI-14 is slow; RSI(7) reacts faster. When RSI7 snaps back up through 25 the compressed selling spring has released — and the VWAP filter keeps you from fighting the day's flow. Entry is exactly on the turn bar, never inside the extreme.",
        rules: [
          "Buy: RSI(7) crosses back up through 25, only while price is above VWAP",
          "Sell: RSI(7) crosses back down through 75, only while price is below VWAP",
          "Stop: 1× ATR",
          "TP1: 1× ATR · TP2: 2× ATR",
          "Never enter inside the extreme — wait for the snap back",
        ],
        tips: [
          "In a strong one-way trend RSI camps in the extreme — trade this in rotational hours",
          "A turn bar with above-average volume is a stronger signal",
          "Pairs well with the EMA+VWAP scalp: one mean-reversion, one trend — every market suits one",
        ],
        best: "Gold and crypto · 1-minute · volatile but not strongly trending markets",
      },
    },
    run(bars, intraday) {
      const rsi7 = rsiArr(bars, 7);
      const vw = vwapArr(bars, intraday !== false);
      const atr = atrArr(bars);
      const c = closes(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || rsi7[i] == null || rsi7[i - 1] == null || vw[i] == null) continue;
        if (rsi7[i - 1] < 25 && rsi7[i] >= 25 && c[i] > vw[i])
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 1, 1, 2)));
        else if (rsi7[i - 1] > 75 && rsi7[i] <= 75 && c[i] < vw[i])
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 1, 1, 2)));
      }
      const i = bars.length - 1;
      return {
        events,
        state: {
          bias: null,
          reasons: [
            rsi7[i] != null
              ? rsi7[i] < 25
                ? r(`RSI7 = ${rsi7[i].toFixed(1)} — اشباع فروش؛ منتظر کندل برگشت`, `RSI7 = ${rsi7[i].toFixed(1)} — oversold; waiting for the turn bar`)
                : rsi7[i] > 75
                  ? r(`RSI7 = ${rsi7[i].toFixed(1)} — اشباع خرید؛ منتظر کندل برگشت`, `RSI7 = ${rsi7[i].toFixed(1)} — overbought; waiting for the turn bar`)
                  : r(`RSI7 = ${rsi7[i].toFixed(1)} — ناحیه خنثی`, `RSI7 = ${rsi7[i].toFixed(1)} — neutral zone`)
              : r("RSI ناقص", "RSI incomplete"),
            vw[i] != null && c[i] != null
              ? c[i] > vw[i]
                ? r("قیمت بالای VWAP — فقط ستاپ خرید معتبر است", "Price above VWAP — only long setups valid")
                : r("قیمت زیر VWAP — فقط ستاپ فروش معتبر است", "Price below VWAP — only short setups valid")
              : r("VWAP ناقص", "VWAP incomplete"),
          ],
        },
      };
    },
  },

  {
    id: "scalp-micro-break",
    icon: "💥",
    category: "scalp",
    risk: 3,
    tfs: ["1m", "5m"],
    defaultTf: "1m",
    minBars: 45,
    intradayOnly: true,
    meta: {
      fa: {
        name: "شکست میکرو-رنج با تأیید حجم",
        tagline: "فشردگی + انفجار حجم = شروع حرکت ۱ دقیقه‌ای",
        desc:
          "قیمت در تایم ۱ دقیقه مدام رنج‌های کوچک می‌سازد و بعد با یک کندل پرحجم از آن خارج می‌شود. این استراتژی سقف/کف ۱۲ کندل اخیر را می‌پاید و فقط شکستی را معامله می‌کند که حجمش حداقل ۱.۵ برابر میانگین باشد — شکست بدون حجم تله است.",
        rules: [
          "ورود خرید: کلوز بالای سقف ۱۲ کندل قبلی + حجم ≥ ۱.۵ برابر میانگین ۲۰ کندل",
          "ورود فروش: کلوز زیر کف ۱۲ کندل قبلی + همان شرط حجم",
          "حد ضرر: ۱.۲ برابر ATR",
          "هدف ۱: ۱.۲ برابر ATR · هدف ۲: ۲.۵ برابر ATR",
          "شکست بدون حجم = ورود ممنوع",
        ],
        tips: [
          "هرچه رنج قبل از شکست فشرده‌تر و طولانی‌تر، حرکت بعدش تمیزتر",
          "شکست‌های اول سشن (باز شدن لندن/نیویورک) بالاترین کیفیت را دارند",
          "اگر کندل شکست خیلی بزرگ بود (بیش از ۲ برابر ATR) منتظر پولبک کوچک بمان",
          "روی نمادهای کم‌حجم (سهام کوچک) این استراتژی را نزن — حجم قابل اتکا نیست",
        ],
        best: "طلا، شاخص‌ها، بیت‌کوین · تایم ۱ و ۵ دقیقه · ابتدای سشن‌ها",
      },
      en: {
        name: "Micro-range Break + Volume",
        tagline: "Compression + a volume burst = the start of a 1-minute move",
        desc:
          "On the 1-minute chart price keeps building tiny ranges and then leaves them on one high-volume bar. This strategy tracks the last 12-bar high/low and only trades a break whose volume is at least 1.5× average — a break without volume is a trap.",
        rules: [
          "Buy: close above the previous 12-bar high + volume ≥ 1.5× the 20-bar average",
          "Sell: close below the previous 12-bar low + the same volume filter",
          "Stop: 1.2× ATR",
          "TP1: 1.2× ATR · TP2: 2.5× ATR",
          "No volume = no trade",
        ],
        tips: [
          "The tighter and longer the range before the break, the cleaner the move after",
          "Session-open breaks (London/NY) are the highest quality",
          "If the breakout bar is huge (>2× ATR) wait for a small pullback",
          "Skip thin symbols (small caps) — the volume signal isn't reliable there",
        ],
        best: "Gold, indices, Bitcoin · 1m and 5m · session opens",
      },
    },
    run(bars) {
      const { upper, lower } = donchianArr(bars, 12);
      const atr = atrArr(bars);
      const volAvg = smaArr(bars.map((b) => b.volume), 20);
      const c = closes(bars);
      const events = [];
      for (let i = 1; i < bars.length; i++) {
        const a = atr[i];
        if (a == null || upper[i - 1] == null || volAvg[i] == null || !volAvg[i]) continue;
        const volOk = bars[i].volume >= 1.5 * volAvg[i];
        if (c[i] > upper[i - 1] && c[i - 1] <= upper[i - 2 < 0 ? 0 : i - 2] && volOk)
          events.push(ev(bars, i, "BUY", atrLevels("BUY", c[i], a, 1.2, 1.2, 2.5)));
        else if (c[i] < lower[i - 1] && c[i - 1] >= lower[i - 2 < 0 ? 0 : i - 2] && volOk)
          events.push(ev(bars, i, "SELL", atrLevels("SELL", c[i], a, 1.2, 1.2, 2.5)));
      }
      const i = bars.length - 1;
      const width = upper[i] != null && lower[i] != null ? upper[i] - lower[i] : null;
      return {
        events,
        state: {
          bias: null,
          reasons: [
            width != null
              ? r(`رنج ۱۲ کندله: ${lower[i].toFixed(2)} تا ${upper[i].toFixed(2)}`,
                  `12-bar range: ${lower[i].toFixed(2)} – ${upper[i].toFixed(2)}`)
              : r("رنج هنوز شکل نگرفته", "Range not formed yet"),
            volAvg[i] != null && volAvg[i] > 0
              ? bars[i].volume >= 1.5 * volAvg[i]
                ? r("حجم فعلی بالای آستانه (۱.۵×) — شکست معتبر خواهد بود", "Current volume above the 1.5× threshold — a break would be valid")
                : r("حجم فعلی زیر آستانه — شکست بدون حجم را نگیر", "Current volume below threshold — don't take a volumeless break")
              : r("داده حجم ناکافی", "Not enough volume data"),
          ],
        },
      };
    },
  },
];

export const byId = (id) => STRATEGIES.find((s) => s.id === id);

export const CATEGORIES = ["trend", "momentum", "reversal", "breakout", "scalp"];

// ---- quick backtest: first touch of TP1 vs SL after each event ----
// Same-bar ambiguity resolves to SL (conservative). R multiples: win = reward
// distance / risk distance at entry; loss = -1.

export function backtest(bars, events, spread = 0) {
  const results = events.map((e) => {
    const risk = Math.abs(e.entry - e.sl) || 1e-9;
    for (let j = e.i + 1; j < bars.length; j++) {
      const b = bars[j];
      if (e.dir === "BUY") {
        if (b.low <= e.sl) return { ...e, outcome: "sl", exit: b.time, r: -1 };
        if (b.high >= e.tp2) return { ...e, outcome: "tp2", exit: b.time, r: Math.abs(e.tp2 - e.entry) / risk };
        if (b.high >= e.tp1) {
          // ride to TP2 or breakeven after TP1
          for (let k = j + 1; k < bars.length; k++) {
            if (bars[k].low <= e.entry) return { ...e, outcome: "tp1", exit: bars[k].time, r: Math.abs(e.tp1 - e.entry) / risk };
            if (bars[k].high >= e.tp2) return { ...e, outcome: "tp2", exit: bars[k].time, r: Math.abs(e.tp2 - e.entry) / risk };
          }
          return { ...e, outcome: "tp1", exit: null, r: Math.abs(e.tp1 - e.entry) / risk };
        }
      } else {
        if (b.high >= e.sl) return { ...e, outcome: "sl", exit: b.time, r: -1 };
        if (b.low <= e.tp2) return { ...e, outcome: "tp2", exit: b.time, r: Math.abs(e.entry - e.tp2) / risk };
        if (b.low <= e.tp1) {
          for (let k = j + 1; k < bars.length; k++) {
            if (bars[k].high >= e.entry) return { ...e, outcome: "tp1", exit: bars[k].time, r: Math.abs(e.entry - e.tp1) / risk };
            if (bars[k].low <= e.tp2) return { ...e, outcome: "tp2", exit: bars[k].time, r: Math.abs(e.entry - e.tp2) / risk };
          }
          return { ...e, outcome: "tp1", exit: null, r: Math.abs(e.entry - e.tp1) / risk };
        }
      }
    }
    return { ...e, outcome: "open", exit: null, r: null };
  });

  const closed = results.filter((x) => x.outcome !== "open");
  const wins = closed.filter((x) => x.outcome !== "sl");
  const rs = closed.map((x) => x.r);
  const avgR = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null;
  const grossW = rs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossL = -rs.filter((v) => v < 0).reduce((s, v) => s + v, 0);

  // Spread-aware ("net") R: you enter on the far side of the spread and exit on
  // the near side, so a round-trip costs ~one spread. Charged in R units per
  // trade as spread / risk-distance — the honest number, since the on-chart R
  // silently ignores it. Only computed when a live spread is supplied.
  let net = null;
  if (spread > 0) {
    const netRs = closed.map((x) => {
      const risk = Math.abs(x.entry - x.sl) || 1e-9;
      return (x.r ?? 0) - spread / risk;
    });
    const nAvg = netRs.length ? netRs.reduce((s, v) => s + v, 0) / netRs.length : null;
    const nW = netRs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const nL = -netRs.filter((v) => v < 0).reduce((s, v) => s + v, 0);
    net = {
      avgR: nAvg,
      wins: netRs.filter((v) => v > 0).length,
      winRate: netRs.length ? (netRs.filter((v) => v > 0).length / netRs.length) * 100 : null,
      profitFactor: nL > 0 ? nW / nL : nW > 0 ? Infinity : null,
    };
  }
  return {
    results,
    stats: {
      signals: events.length,
      closed: closed.length,
      wins: wins.length,
      losses: closed.length - wins.length,
      open: results.length - closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      avgR,
      profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? Infinity : null,
      net,
    },
  };
}

// ---- top-level analysis for one strategy on one bar series ----

const FRESH_BARS = 3;

export function analyze(stratId, bars, intraday, spread = 0) {
  const strat = byId(stratId);
  if (!strat || !bars?.length) return null;
  if (bars.length < strat.minBars)
    return { strategy: strat, error: "notEnoughBars", need: strat.minBars, have: bars.length };

  const { events, state } = strat.run(bars, intraday);
  const last = events[events.length - 1] || null;
  const barsSince = last ? bars.length - 1 - last.i : null;
  const actionable = last != null && barsSince <= FRESH_BARS;

  const rating = technicalRating(bars, intraday);
  let strength = null;
  if (last) {
    const aligned = rating ? (last.dir === "BUY" ? rating.score : -rating.score) : 0;
    strength = Math.round(
      Math.max(5, Math.min(98, 55 + aligned * 35 - (actionable ? 0 : Math.min(20, barsSince)))),
    );
  }

  const bt = backtest(bars, events, spread);
  return {
    strategy: strat,
    events,
    state,
    last,
    barsSince,
    signal: actionable ? last.dir : "WAIT",
    strength,
    rating,
    bt,
    spread: spread || null,
  };
}

/** Blend the three directional sources — AI signal, the live strategy signal,
 *  and the technical rating — into ONE confidence. Trade only when they agree.
 *  Returns null if there's nothing to combine; otherwise { dir, score 0-100,
 *  agree, total, parts }. */
export function consensus({ aiDir, stratDir, stratStrength, ratingScore }) {
  const norm = (d) => (d === "BUY" ? 1 : d === "SELL" ? -1 : 0);
  const parts = [];
  if (aiDir) parts.push({ key: "ai", v: norm(aiDir), w: 1 });
  if (stratDir && stratDir !== "WAIT") parts.push({ key: "strategy", v: norm(stratDir), w: 1.2 });
  if (ratingScore != null) parts.push({ key: "rating", v: Math.max(-1, Math.min(1, ratingScore)), w: 0.8 });
  if (!parts.length) return null;
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  const raw = parts.reduce((s, p) => s + p.v * p.w, 0) / wsum; // -1..1
  const dir = raw > 0.15 ? "BUY" : raw < -0.15 ? "SELL" : "HOLD";
  let score = Math.round(Math.abs(raw) * 100);
  if (dir !== "HOLD" && stratDir === dir && stratStrength != null)
    score = Math.round(score * 0.7 + stratStrength * 0.3);
  const agree = parts.filter((p) => (dir === "BUY" ? p.v > 0 : dir === "SELL" ? p.v < 0 : false)).length;
  return { dir, score: Math.max(0, Math.min(100, score)), agree, total: parts.length, parts };
}

/** Evaluate every strategy compatible with this timeframe (for the scanner). */
export function scanAll(bars, intraday, tf) {
  return STRATEGIES.filter(
    (s) => (!tf || s.tfs.includes(tf)) && (!s.intradayOnly || intraday),
  ).map((s) => {
    const a = analyze(s.id, bars, intraday);
    return { id: s.id, icon: s.icon, a };
  });
}

/** Chart markers for a strategy's historical events. The latest event is
 *  drawn bigger and labeled with direction + entry price so it pops. */
export function strategyMarkers(bars, stratId, intraday) {
  const strat = byId(stratId);
  if (!strat || !bars?.length || bars.length < strat.minBars) return [];
  const { events } = strat.run(bars, intraday);
  const dpFor = (v) => (Math.abs(v) >= 1000 ? 1 : Math.abs(v) >= 10 ? 2 : 4);
  return events.map((e, idx) => {
    const buy = e.dir === "BUY";
    const isLast = idx === events.length - 1;
    return {
      time: e.time,
      position: buy ? "belowBar" : "aboveBar",
      color: buy ? "#2fd67b" : "#ff5d6c",
      shape: buy ? "arrowUp" : "arrowDown",
      size: isLast ? 2 : 1,
      text: isLast
        ? `${buy ? "BUY" : "SELL"} ${e.entry.toFixed(dpFor(e.entry))}`
        : buy ? "B" : "S",
    };
  });
}

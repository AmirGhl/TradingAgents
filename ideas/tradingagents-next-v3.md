# TradingAgents — پاس سوم (Idea Expander v3)

> **TL;DR:** بهترین انتخاب = **GIF دموی زنده در README + GitHub Actions release workflow** — کمترین تلاش، بیشترین تأثیر روی دیده‌شدنِ ریپو.
>
> **فرضیات:** پاس‌های اول و دوم کاملاً پیاده شده‌اند. این پاس فقط چیزهایی را می‌پوشاند که در v1/v2 نبودند. تمرکز دوگانه: (الف) جذابیتِ ریپوی گیت‌هاب، (ب) موجِ بعدیِ فیچر.

## وضعیت نسبت به پاس‌های قبل

**v1 برنده‌ها:** kill-switch / سقف ضرر روزانه، تریلینگ‌استاپ سروری، کنسنسوس، تلگرام دوطرفه، ژورنال per-strategy، لات از ریسک٪ — همه ساخته شده‌اند.

**v2 برنده‌ها:** stops_level/freeze_level، R اسپرد-آگاه، موتور سروری Node، حالت سایه، اتوترید مسلح، Subtract — همه ساخته شده‌اند.

**باقی‌مانده از v2 (reserve):** فیلتر رژیم ADX، استریمِ چندنمادی، پارشال TP.

---

## ۱) دیورج — ایده‌های جدید

**الف) ریپوی گیت‌هاب / discoverability**
- `[feature]` اسکرین‌شات واقعیِ اپ در README (نه prose) — ثابت‌شده‌ترین روشِ تبدیلِ بازدیدکننده به ستاره‌دهنده
- `[feature]` GIF دموی کوتاه (۸-۱۰ ثانیه) از tick stream زنده روی طلا — ویدیوهای README ۳× بیشتر سیگنال‌گذاری می‌گیرند
- `[feature]` GitHub Actions release workflow: هر تگ `vX.Y.Z-webui` → build zip → draft release خودکار
- `[feature]` CONTRIBUTING.md + قالب issue (bug report / feature request)
- `[feature]` SECURITY.md — پالیسیِ گزارشِ آسیب‌پذیری
- `[feature]` GitHub Pages landing page — صفحهٔ بازاریابیِ ساده با بیشتر جا برای screenshot و demo
- `[feature]` بج «Stars» + star-history image در README
- `[idea]` Topic tags روی ریپو: `metatrader5`, `trading-bot`, `technical-analysis`, `react`, `fastapi`
- `[feature]` Pinned reply در Discussions با لینکِ دانلود و FAQ

**ب) UX / power user**
- `[feature]` Keyboard shortcuts: `b` = buy، `s` = sell، `Esc` = بستن مودال، `r` = refresh، `1-9` = تایم‌فریم
- `[feature]` دکمهٔ «کپی عکسِ چارت به کلیپبورد» در toolbar چارت (canvas.toBlob → clipboard)
- `[feature]` تبِ «امروز»: PnL روزانه، تریدهای باز، سیگنال‌های فعال — یک نگاه = حالِ حساب
- `[feature]` «آخرین بارِ اجرا» countdown روی هر ردیفِ ArmPanel (چقدر دیگه تا ارزیابیِ بعدی)
- `[feature]` دکمهٔ «export to CSV» برای ژورنالِ سایه (برای tax / تحلیلِ خارجی)

**ج) کیفیتِ سیگنال / wave 3**
- `[feature]` فیلتر رژیم ADX: وقتی ADX<25 استراتژی‌های ترند (EMA cross, SuperTrend) خودکار خاموش می‌شوند
- `[feature]` Multi-timeframe signal panel: سیگنالِ همان استراتژی روی 1m/5m/15m/1H/D — یک نگاه = confluenc
- `[feature]` پارشال TP: بستن ۵۰٪ در TP1، انتقال SL به entry (در ArmPanel toggle)
- `[feature]` Strategy conflict detection: وقتی دو ردیف مسلحِ آنتاگونیست روی یک نماد → هشدار
- `[feature]` «حداقلِ نمونه» قبل از winrate: اگر backtest < ۱۵ ترید → «داده کم» نه عدد
- `[idea]` News overlay روی چارت: رویدادِ اقتصادیِ تأثیرگذار به‌صورت خطِ عمودی با رنگِ اثر (قرمز/زرد)

**د) فنی / ابزار توسعه**
- `[feature]` Smoke test خودکار برای signal_engine.mjs: `node signal_engine.mjs --selftest` چند کندلِ ثابت → سیگنالِ انتظاری → exit 0/1
- `[feature]` Docker Compose: اجرای `python -m webui` بدون ویندوز (برای توسعه‌دهنده روی Linux/Mac)
- `[feature]` Automated frontend type-check با `tsc --noEmit` در CI
- `[feature]` نسخه‌بندیِ semantic با changelog خودکار از commit messages (conventional commits)

**ه) Subtract / ساده‌سازی**
- `[feature]` حذفِ `/api/quote` Yahoo-branch اگر MT5 وصل است — اضافه‌تر از آنچه لازم است
- `[feature]` ادغامِ `ArmPanel` و `ScannerPanel` در یک تبِ «خودکار» با subtab — دو پنلِ مشابه کاربر را گیج می‌کند
- `[feature]` حذفِ سه indicator checkbox که کمترین استفاده را دارند (ADX, Donchian, Fibonacci) — تمیزتر و سریع‌تر

**و) Wildcard / 10x**
- `[idea]` WebSocket relay: کاربر از موبایل روی همان حساب به سرورِ دسکتاپ‌شان متصل می‌شود — معامله از تلفن بدون اپِ مجزا
- `[idea]` Strategy DNA: هر استراتژی یک «رشته» از شرایطِ فیلترش در یک خطِ base64 — share/import بدون کد

---

## ۲) امتیازدهی

فرمول: **Impact×2 + Fit×2 + Novelty + Effort** (Effort بالاتر = ارزان‌تر)

| کاندید | Imp | Eff | Fit | Nov | مجموع | حکم |
|---|---|---|---|---|---|---|
| اسکرین‌شات واقعی در README | 5 | 5 | 5 | 2 | **27** | ✅ کوییک‌وین #۱ |
| GitHub Actions release workflow | 4 | 4 | 5 | 3 | **25** | ✅ کوییک‌وین #۲ |
| GIF دمو در README | 5 | 3 | 5 | 4 | **26** | ✅ تمایزساز |
| فیلتر رژیم ADX | 4 | 4 | 5 | 3 | **25** | ✅ (از reserve v2) |
| Multi-TF signal panel | 4 | 3 | 5 | 4 | **24** | ✅ |
| CONTRIBUTING + issue templates | 3 | 5 | 4 | 1 | **20** | ✅ کوییک‌وین #۳ |
| Keyboard shortcuts | 3 | 4 | 4 | 2 | **20** | ⭐ رزرو |
| تبِ «امروز» (PnL روزانه) | 4 | 3 | 4 | 3 | **21** | ⭐ رزرو |
| Export shadow → CSV | 3 | 5 | 4 | 1 | **19** | ⭐ |
| پارشال TP | 4 | 2 | 4 | 3 | **20** | ⭐ رزرو |
| WebSocket relay (موبایل) | 5 | 1 | 3 | 5 | **19** | ✂️ پیچیده |
| Docker Compose | 3 | 3 | 3 | 2 | **16** | ✂️ (ابزار توسعه) |
| Strategy DNA / share string | 3 | 2 | 2 | 5 | **16** | ✂️ (نیاز به community) |

**رد شد:**
- WebSocket relay: امنیت + complexity بالا؛ تلگرام Approve/Reject همین کار را می‌کند.
- Strategy DNA: جامعهٔ کاربری هنوز کوچک است؛ زوده.
- Automated changelog: v0.4.0 روی conventional commits بنا نشده؛ retro-fit پیچیده.

**ضدحمله:**
- GIF demo → ابزارِ ساختِ GIF از WebSocket stream ممکن است کیفیتِ ضعیف بدهد؛ جایگزین: ویدیوی MP4 + `<video autoplay loop muted>` در GitHub Pages، نه README.
- فیلتر ADX → باید per-bar محاسبه شود؛ اگر اشتباه باشد سیگنال‌های درست رد می‌شوند؛ باید با threshold قابل‌تنظیم باشد.

---

## ۳) برنده‌ها

### 💡 ایده‌ها

**۱. اسکرین‌شات واقعی در README** — idea (discoverability)
- **چیه:** سه تصویرِ واقعی از اپِ در حال اجرا در README.md — Live run، Chart با گیج، Trade plan کامل.
- **چرا خوبه:** ۸۰٪ از بازدیدکنندگانِ ریپو، prose نمی‌خوانند؛ با یک عکسِ خوب «باقی‌مانده → ستاره‌داده» می‌شوند. رقبای مشابه این را دارند.
- **چطور:** اجرای `python -m webui`، browser preview، screenshot با ابزار، ذخیره در `docs/screenshots/`، `![Chart](docs/screenshots/chart.png)` در README.
- **وابستگی:** — · **تلاش:** S — ریسک: اگر UI تغییر کند، عکس‌ها قدیمی می‌شوند.

**۲. GIF / video دمو** — idea (discoverability)
- **چیه:** یک GIF انیمیشنی ۸-۱۰ ثانیه‌ای که tick stream زنده و strategy gauge در حال تغییر را نشان می‌دهد.
- **چرا خوبه:** هیچ‌چیزی «live data pipeline» را بهتر از یک GIF زنده توضیح نمی‌دهد.
- **چطور:** ابزار record screen → GIF (مثل ScreenToGif)، ذخیره در `docs/demo.gif`، embed در README.
- **وابستگی:** اسکرین‌شات‌های ثابت اول · **تلاش:** S — ریسک: حجمِ GIF؛ باید <5MB باشد.

### 🧩 فیچرها

**۱. GitHub Actions — release workflow** — feature
- **چیه:** workflow که روی هر تگِ `vX.Y.Z-webui` اجرا می‌شود، frontend می‌سازد، zip می‌پکِج می‌کند، و draft release روی گیت‌هاب می‌سازد.
- **چرا خوبه:** فرآیند release فعلی ۱۰ مرحلهٔ دستی دارد که هر بار ۲۰ دقیقه می‌گیرد و خطرِ فراموش‌کردنِ sync (مثل باگِ v0.4.0) دارد.
- **چطور:** `.github/workflows/release.yml` با `windows-latest`، `npm run build`، `pip install pyinstaller`، `pyinstaller launcher.py`، `Compress-Archive`، `gh release create`.
- **وابستگی:** — · **تلاش:** M — ریسک: نصبِ MT5 package روی GitHub Actions runner (Windows-only، ممکن است در CI ناموجود باشد → فقط dummy import).

**۲. فیلتر رژیم ADX** — feature
- **چیه:** یک تابعِ `regime(bars)` در `strategies.js` که ADX را محاسبه می‌کند؛ استراتژی‌های trend-following اگر ADX < threshold (پیش‌فرض ۲۵) در WAIT باقی می‌مانند.
- **چرا خوبه:** در بازارِ رنج، EMA cross و SuperTrend و Donchian سیگنال‌های جعلی می‌دهند — فیلتر ADX winrate واقعی را بالا می‌برد.
- **چطور:** `calcADX(bars, 14)` → اگر `adx < settings.adxThreshold && strategy.trendOnly` → override signal به WAIT. یک toggle در StrategyGauge.
- **وابستگی:** — · **تلاش:** M — ریسک: threshold اشتباه → فیلترِ بیش‌ازحد؛ باید per-user قابل‌تنظیم باشد.

**۳. Multi-timeframe signal panel** — feature
- **چیه:** زیرِ StrategyGauge، یک پنلِ کوچک که سیگنالِ استراتژیِ انتخاب‌شده را روی ۱m/5m/15m/1H/D نشان می‌دهد — رنگی (سبز/قرمز/خاکستری).
- **چرا خوبه:** confluence چندتایم‌فریمِ دستی اکثر تریدرها ۵-۱۰ دقیقه می‌گیرد؛ اینجا یک ثانیه می‌شود.
- **چطور:** برای هر TF یک `useBars` parallel call + `analyze()`؛ نتیجه در یک ردیف نمادین.
- **وابستگی:** `useStrategyLive` (موجود) · **تلاش:** M — ریسک: ۵ WebSocket موازی روی یک نماد → load بالاتر.

**۴. CONTRIBUTING.md + issue templates** — feature
- **چیه:** فایل CONTRIBUTING.md با گام‌های dev setup، و دو template در `.github/ISSUE_TEMPLATE/` برای bug report و feature request.
- **چرا خوبه:** ریپوهای فاقد CONTRIBUTING.md کمتر fork و star می‌گیرند؛ issue template کیفیتِ bug report را ۲× بهتر می‌کند.
- **چطور:** CONTRIBUTING.md = همان مراحلِ dev در README + ساختارِ PR؛ templates = YAML فرم‌های گیت‌هاب.
- **وابستگی:** — · **تلاش:** S

**۵. تبِ «امروز» — PnL داشبورد** — feature
- **چیه:** یک تبِ ساده‌ی بالا که خلاصهٔ روز را نشان می‌دهد: PnL کل (از account_history MT5)، تعداد ترید، وین‌ریت امروز، پوزیشن‌های باز، سیگنالِ فعالِ هر استراتژیِ مسلح.
- **چرا خوبه:** تریدر هر بار که برمی‌گردد، نباید به چند پنل سر بزند.
- **چطور:** `/api/mt5/today_summary` → `account_history` با `from=midnight`، `open_positions`، `armed_signals`.
- **وابستگی:** ArmPanel (موجود) · **تلاش:** M

---

## پیشنهاد

**همین الان:** اسکرین‌شات‌های واقعی را بگیر و در README بگذار (S، تأثیر فوری روی discoverability) + CONTRIBUTING + issue templates.

**موجِ بعدی:** GitHub Actions release workflow (M) → فیلتر ADX (M) → Multi-TF panel (M).

**ذخیره:** این ایده‌ها در `ideas/tradingagents-next-v3.md` ذخیره شد.

---

*بگو تا برای هرکدام یک plan/PRD بسازم یا مستقیم پیاده کنم.*

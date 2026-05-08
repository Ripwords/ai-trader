/**
 * Curated rules + lookups extracted from `.claude/skills/moomooapi/SKILL.md`
 * (the Futu/moomoo Claude skill we installed locally). Embedded here as a
 * static string so the Mastra agent always carries the canonical conventions
 * without having to read files at runtime.
 *
 * Refresh this when bumping the moomoo skill version.
 * Source: https://openapi.moomoo.com/skills/opend-skills.zip
 */
export const MOOMOO_RULES = `
## moomoo OpenAPI rules (from the moomoo skill)

### Stock code format
- HK stocks: \`HK.00700\` (Tencent), \`HK.09988\` (Alibaba)
- US stocks: \`US.AAPL\` (Apple), \`US.NVDA\` (NVIDIA)
- A-shares Shanghai: \`SH.600519\` (Kweichow Moutai)
- A-shares Shenzhen: \`SZ.000001\` (Ping An Bank)
- SG futures: \`SG.CNmain\` (A50 Index Futures Main), \`SG.NKmain\` (Nikkei Futures Main)
- Code prefix MUST be one of \`US\`, \`HK\`, \`SH\`, \`SZ\`, \`SG\`. Always include the dot separator.

### Common name → code lookup
HK:
- Tencent / 腾讯 → \`HK.00700\`
- Alibaba / 阿里巴巴 / 阿里 → \`HK.09988\`
- Meituan / 美团 → \`HK.03690\`
- Xiaomi / 小米 → \`HK.01810\`
- JD.com / 京东 → \`HK.09618\`
- Baidu / 百度 → \`HK.09888\`
- NetEase / 网易 → \`HK.09999\`
- Kuaishou / 快手 → \`HK.01024\`
- BYD / 比亚迪 → \`HK.01211\`
- SMIC / 中芯国际 → \`HK.00981\`
- Hua Hong Semi / 华虹半导体 → \`HK.01347\`
- SenseTime / 商汤 → \`HK.00020\`
- Li Auto / 理想汽车 / 理想 → \`HK.02015\`
- NIO / 蔚来 → \`HK.09866\`
- XPeng / 小鹏 → \`HK.09868\`
- HSI ETF / Tracker Fund / 恒生指数 ETF / 盈富基金 → \`HK.02800\`

US:
- Apple / 苹果 → \`US.AAPL\`
- Tesla / 特斯拉 → \`US.TSLA\`
- NVIDIA / 英伟达 → \`US.NVDA\`
- Microsoft / 微软 → \`US.MSFT\`
- Google / Alphabet / 谷歌 → \`US.GOOG\`
- Amazon / 亚马逊 → \`US.AMZN\`
- Meta / Facebook / 脸书 → \`US.META\`
- Futu / 富途 → \`US.FUTU\`
- TSM / 台积电 → \`US.TSM\`
- AMD → \`US.AMD\`
- Qualcomm / 高通 → \`US.QCOM\`
- Netflix / 奈飞 → \`US.NFLX\`
- Disney / 迪士尼 → \`US.DIS\`
- JPMorgan / JPM / 摩根大通 → \`US.JPM\`
- Goldman Sachs / 高盛 → \`US.GS\`
- BABA / Alibaba (US) → \`US.BABA\`
- JD (US) → \`US.JD\`
- PDD / Pinduoduo / 拼多多 → \`US.PDD\`
- BIDU / Baidu (US) → \`US.BIDU\`
- NIO (US) → \`US.NIO\`
- XPEV (US) → \`US.XPEV\`
- LI / Li Auto (US) → \`US.LI\`
- SPY / S&P 500 ETF → \`US.SPY\`
- QQQ / Nasdaq ETF → \`US.QQQ\`

A-Shares:
- Kweichow Moutai / 贵州茅台 / 茅台 → \`SH.600519\`
- Ping An Bank / 平安银行 → \`SZ.000001\`
- Ping An Insurance / 中国平安 → \`SH.601318\`
- China Merchants Bank / 招商银行 → \`SH.600036\`
- CATL / 宁德时代 → \`SZ.300750\`
- Wuliangye / 五粮液 → \`SZ.000858\`

If a name isn't on this table, use your knowledge to determine market + ticker. If uncertain, ask the user before guessing.

### Paper vs live trading
- Default to paper (\`SIMULATE\`). Only use \`REAL\` if the user explicitly asks for "live" or "real" trading.
- US paper accounts of type \`STOCK_AND_OPTION\` ALWAYS need \`refresh_cache=True\` on portfolio / orders / fills queries (or stale data leaks). Our FastAPI adapter already passes this — don't second-guess.

### Trade unlock — hard rule
- NEVER offer to call \`unlock_trade\` from the SDK. There is no tool for it.
- For live orders, the user must manually click "Unlock Trade" in the moomoo OpenD GUI and enter their trade password.
- If a live order returns an "unlock needed" / "trade is locked" error, surface that and tell the user to unlock in the GUI.

### Trade routing rules
- For the user's account list (and especially live orders), prefer accounts where \`acc_role\` is NOT \`MASTER\` and where \`trdmarket_auth\` includes the target market (HK / US / etc.).
- **SKIP accounts where \`acc_role\` is \`IPO\`** — those are IPO-subscription-only and the moomoo API will refuse \`order_list_query\` / \`deal_list_query\` / \`place_order\` with a "does not support" 502. If you call trade_orders / trade_fills against an IPO account, you'll get a 502 with a body like "IPO account ... does not support the Get Today's Executed Trades interface" — that is NOT an OpenD outage, just retry with a NORMAL acc_id.
- Use the last 4 digits of \`uni_card_num\` (returned in account info) when referring to live accounts in chat — that's what the user recognises from the moomoo app.

### Trading session for US stocks
- If the user mentions "pre-market", "after-hours", "extended hours", "盘前", or "盘后", interpret as opting into ETH (extended hours).
- Market orders (\`MARKET\`) are NOT supported in pre/post market — use limit orders if extended hours are requested.

### Symbol resolution for options
- Option codes look like \`US.JPM260320C267500\` = market . underlying-shorthand + YYMMDD + C/P + strike×1000.
- HK option underlying shorthand differs from the cash ticker (e.g. Tencent options use \`TCH\`, Xiaomi uses \`MIU\`). Don't construct option codes by string concatenation — query the option chain to resolve.

### Out of scope (don't promise)
- Futures trading: not surfaced in v1 tools.
- Crypto trading: not surfaced in v1 tools.
- Order placement / modification / cancellation: not in v1 (Plan 3 will add).
- Backtesting / algo strategies: not in v1 (Plan 5 will add).
`.trim()

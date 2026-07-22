// ============================================================
// config.js — 静态配置层
// 职责：所有常量声明，不含副作用逻辑
// ============================================================

// ════════════════════════════════════════════════════════════
// §1 数据源配置
// ════════════════════════════════════════════════════════════

// 数据源模式开关（详见 docs/DECISIONS.md D-013）
//   "gateway" → Cloudflare 网关（API_BASE），主备在网关内，带 KV last-known-good
//   "direct"  → 浏览器直连行情源。净值主东财/备腾讯；指数单源腾讯（新浪备源因 CORS 不可用，见 D-020）。
//   切换逻辑只在 data.js 的两个分支内，禁止在第三处另开数据源。
const DATA_MODE = "direct";

// 市场数据网关（gateway 模式用）。浏览器只请求这一个域名。
const API_BASE = "https://fund-api.bailuzun.com";

// 官方净值夜间采集器（详见 D-023）。**官方净值的唯一来源**，不受 DATA_MODE 影响——
// 那个开关从此只管盘中数据（估算、指数）。浏览器侧本就凑不出第二个官方源：
// 东财 FundMNFInfo 前端直连被 ErrCode:61136 拦（需 APP 签名，仅服务端调得通），
// 只剩腾讯一路；且没人开着看板时浏览器压根不会去取。采集器每分钟两源并行抢，
// 把结果连同「谁先抢到 + 何时抢到」存进 KV，前端读一次即可。
// 盘中 / 周末 / 节假日没有当日记录时，读端点回退 nav:latest（上一交易日）。
// **域名与网关同一个**：bailuzun.com 的权威 DNS 在腾讯（dnspod）不是 Cloudflare zone，
// 而 Worker 的 Custom Domain / Routes 都要求 zone 在 CF，只剩 *.workers.dev——它在大陆
// 常年不可达，前端读不到就等于白采。故采集 Worker 只写 KV，读端点挂在已有可达域名的
// 网关（Pages Functions）上。这也是 gateway 与 direct 唯一的交汇点：即便 DATA_MODE
// 是 "direct"，这一个端点仍走网关域名——它读的是 KV，不触发网关的任何上游主备逻辑。
const NAV_BASE = API_BASE;

// 腾讯行情直连基地址（direct 模式用，盘中估算与指数）。返回 GBK，前端 TextDecoder("gbk") 解码。
const TX_BASE = "https://qt.gtimg.cn";

// EM_BASE 已删（D-023 修订）：官方净值统一走采集器 KV 后，前端不再直连东财——
// 那条链在浏览器里本来就是死的（ErrCode:61136），删掉的是一个从未成功过的主源。
// 服务端那份仍在 workers/fund-nav-collector/src/index.js 的 fetchEastmoney 里，活得好好的。

// 指数 → 行情代码映射（direct 模式用）
const TX_INDEX_QQ = {
  "000300": "sh000300",
  "000510": "sh000510",
  "000905": "sh000905",
  "000832": "sh000832",
  "000012": "sh000012",
  HSI: "hkHSI",
};

// ════════════════════════════════════════════════════════════
// §2 收益数据源开关（详见 docs/DECISIONS.md D-020）
// ════════════════════════════════════════════════════════════

// "estimate"  → 走外部估算接口（天天基金/腾讯/东财；当前全源已死，保留结构备恢复）
// "benchmark" → 走业绩基准代理（BENCHMARK_PROXY 表 × 实时指数涨跌）
const DATA_SOURCE_SWITCH = "benchmark";

// ════════════════════════════════════════════════════════════
// §3 指数配置
// ════════════════════════════════════════════════════════════

const INDICES = [
  { id: "000300", lbl: "沪深300" },
  { id: "000510", lbl: "中证A500" },
  { id: "000905", lbl: "中证500" },
  { id: "000832", lbl: "中证转债" },
  { id: "000012", lbl: "国债指数" },
  { id: "HSI", lbl: "恒生指数" },
];

// PE 锚定路径开关（详见 docs/DECISIONS.md D-017）
//   "mcap"  → 1.0 总市值路。D-006 实测平均误差 0.41pp / 最大 0.86pp
//   "price" → 2.0 点位路。平均 1.31pp / 最大 3.69pp，成分调整日更可靠
// 新增 PE 调用点一律走 getAnchorPE，禁止直接调 getEnginePE / getEnginePE1
const PE_ANCHOR = "mcap";

// ════════════════════════════════════════════════════════════
// §4 产品与持仓配置
// ════════════════════════════════════════════════════════════

const CODE_XQ = "003949";        // 兴全稳泰债券A — 资金活塞
const CODE_A500 = "022435";      // 南方中证A500ETF联接C — 增权优先品种
const IDX_PE = "000300";         // 实时PE锚定指数：沪深300
const LIMIT_A500C = 0.2;         // A500C单品持仓上限（占总资产）
const FEE = 0.005;               // 全局摩擦费率

const DEFAULT_CODES = [
  CODE_XQ,                       // 003949 兴全稳泰债券A
  "160622",                      // 鹏华丰利债券LOF
  "110027",                      // 易方达安心回报A
  "011554",                      // 海富通欣利混合A
  "007466",                      // 华泰柏瑞红利低波联接A（已退役）
  CODE_A500,                     // 022435 南方中证A500ETF联接C
];

const DEFAULT_BUCKET = "65,70";

// 产品名称表
const NAMES = {
  [CODE_XQ]: "兴全稳泰债券A",
  160622: "鹏华丰利债券LOF",
  110027: "易方达安心回报A",
  "011554": "海富通欣利混合A",
  "007466": "华泰柏瑞红利低波联接A",
  [CODE_A500]: "南方中证A500ETF联接C",
};

const SHORT_NAMES = {
  [CODE_XQ]: "兴全中长债",
  160622: "鹏华丰利",
  "007466": "华泰红利",
  "011554": "海富通欣利",
  110027: "易方达回报",
  [CODE_A500]: "南方A500C",
};

// 产品属性表（参与权益计算）
const PRODUCTS = [
  { code: CODE_XQ, name: "兴全中长债", equity: 0.0 },
  { code: "160622", name: "鹏华丰利", equity: 0.15 },
  { code: "007466", name: "华泰红利", equity: 0.55 },
  { code: "011554", name: "海富通欣利", equity: 0.4 },
  { code: "110027", name: "易方达回报", equity: 0.2 },
  { code: CODE_A500, name: "南方A500C", equity: 1.0 },
];

// ════════════════════════════════════════════════════════════
// §5 业绩基准代理权重表（日内方向估算用，不含经理alpha）
// ════════════════════════════════════════════════════════════

// 源：M-Tycoon/4_数据_产品知识库.md §A1.1 枷锁层F4天团 · 自定义基准权益列
// 更新节奏：季报发布后校核，产品库变更时手工同步
// 不在表中的产品不参与基准代理估值
//
// 字段名是 legs 不是 equity：权益、转债与全债腿共存；全债统一挂 000012 国债指数，
// 仅作日内方向代理，不代表基金真实债券组合或久期。
const BENCHMARK_PROXY = {
  // ── 枷锁层 F4 ──
  "160622": { legs: [{ idx: "000832", w: 0.10 },          // 鹏华丰利: 中证转债×10%+全债×90%
                     { idx: "000012", w: 0.90 }] },
  "110027": { legs: [{ idx: "000300", w: 0.20 },          // 易方达回报: HS300×20%+全债×80%
                     { idx: "000012", w: 0.80 }] },
  "011554": { legs: [{ idx: "000300", w: 0.20 },          // 海富通欣利: HS300×20%+恒生×5%+全债×75%
                     { idx: "HSI",   w: 0.05 },
                     { idx: "000012", w: 0.75 }] },
  "007045": { legs: [{ idx: "000300", w: 1.0 }] },        // 博道300增强C: HS300×100%
  // ── 可调度层 ──
  "022435": { legs: [{ idx: "000510", w: 1.0 }] },        // 南方A500联接C: A500×100%
  "007413": { legs: [{ idx: "000905", w: 1.0 }] },        // 长城500增强C: 中证500×100%
  // ── 资金活塞 ──
  // 兴全稳泰A 是纯债，本可按"日收益≈0"留空，但空值渲染成 -- 在看板上是个洞。
  // 挂国债指数×100%：数量级对（日内 ±0.01% 上下），比留白诚实，也比编个 0 诚实。
  // ⚠️ 口径不同于权益腿——国债指数久期与本基金不一致，这是**方向占位**，不是收益预测。
  [CODE_XQ]: { legs: [{ idx: "000012", w: 1.0 }] },       // 兴全稳泰A: 国债指数×100%
};
// 不在表：007466(退役)/013291(备选0持仓)/018014(备选) 等 → 基准代理不可用

// ════════════════════════════════════════════════════════════
// §6 PE 引擎配置
// ════════════════════════════════════════════════════════════

const BUFFER_ZONE = 1.75;             // PE信号死区缓冲
const EQUITY_DEV_LIMIT = 1.75;        // 权益偏离警告阈值
const PE_HIGH_THRESHOLD = 65;         // 权益方向判断分界线（高于此值为高估区）

// PE 12档 S曲线映射表（v7.5方法论）
const PE_EQUITY_TABLE = [
  { lo: 80, hi: 999, target: 20 },
  { lo: 75, hi: 80, target: 22.5 },
  { lo: 70, hi: 75, target: 25 },
  { lo: 65, hi: 70, target: 27.5 },
  { lo: 60, hi: 65, target: 32.5 },
  { lo: 55, hi: 60, target: 42.5 },
  { lo: 50, hi: 55, target: 50 },
  { lo: 45, hi: 50, target: 57.5 },
  { lo: 40, hi: 45, target: 62.5 },
  { lo: 35, hi: 40, target: 70 },
  { lo: 30, hi: 35, target: 75 },
  { lo: 0, hi: 30, target: 80 },
];

// ════════════════════════════════════════════════════════════
// §7 系统与时间配置
// ════════════════════════════════════════════════════════════

const REFRESH_IDX = 10000;           // 指数刷新间隔（ms）
const REFRESH_API = 60000;           // 基金数据刷新间隔（ms）

// 时间节点（分钟数）
const T_PRE_MARKET = 540;            // 盘前  09:00
const T_OPEN = 570;                  // 开盘  09:30
const T_MID_BREAK = 690;             // 午休  11:30
const T_AFTERNOON = 780;             // 下午  13:00
const T_CLOSE = 900;                 // 收盘  15:00
const T_OFF_UPDATE = 1170;           // 官方净值更新 19:30

// 超时配置（ms）
const FETCH_EST_TIMEOUT = 12000;
const FETCH_OFF_TIMEOUT = 12000;
const FETCH_INDEX_TIMEOUT = 12000;

// 夜间采集器读节流（ms），失败也推进（负缓存）。见 D-023
const NAV_COLLECTOR_TTL = 30000;

// 估算缓存（详见 docs/DECISIONS.md D-018）
const EST_CACHE_MAX_AGE = 7 * 24 * 3600000;      // 整份丢弃硬上限（ms）
const EST_GIST_READ_THROTTLE = 30 * 60000;        // Gist 读节流（ms），失败也推进负缓存

// 市场常量
const DAYS = ["星期日","星期一","星期二","星期三","星期四","星期五","星期六"];

// ════════════════════════════════════════════════════════════
// §8 localStorage Key
// ════════════════════════════════════════════════════════════

const STORE_CODES = "fm_v20";
const STORE_PE_ENGINE = "jy_pe_engine_v1";
const STORE_PE = "jy_pe_v2_lagrange";
const STORE_HOLDINGS = "jy_holdings_v1";
const STORE_SELL_PLAN = "jy_sell_plan_v1";
const STORE_PRIORITY_SELL = "jy_priority_sell_v1";
const STORE_CONFIG_VER = "jy_config_ver_v1";
const STORE_EST_CACHE = "fm_est_cache_v1";
const STORE_EST_GIST_DATE = "fm_est_gist_date_v1";
const STORE_GIST_ID = "fm_gist_id";
const STORE_GIST_TOKEN = "fm_gist_token";

// ════════════════════════════════════════════════════════════
// §9 Gist 文件名
// ════════════════════════════════════════════════════════════

const GIST_FILE_PE = "fm_pe.json";
const GIST_FILE_CONFIG = "fm_config.json";
const GIST_FILE_PE_ENGINE = "fm_pe_engine.json";
const GIST_FILE_EST = "fm_est.json";

// ════════════════════════════════════════════════════════════
// §10 纯工具函数（无副作用，供所有层调用）
// ════════════════════════════════════════════════════════════

function isZZ500Product(name) {
  return !!(name && name.includes("中证500"));
}

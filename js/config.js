// ============================================================
// config.js - 静态配置层
// 职责：所有常量声明，不含任何逻辑
// ============================================================

// ---- 系统参数 ----
const SYS_CONFIG = {
  FEE: 0.005,              // 全局摩擦费率
  BUFFER_ZONE: 1.75,       // PE信号死区缓冲
  EQUITY_DEV_LIMIT: 1.75,  // 权益偏离警告阈值
  PE_HIGH_THRESHOLD: 65,   // 权益方向判断分界线（高于此值为高估区）
  CODE_XQ: "003949",       // 资金来源：兴全中长债
  CODE_A500: "022435",     // 增权优先品种：南方中证A500ETF联接C
  LIMIT_A500C: 0.2,        // A500C单品持仓上限（占总资产）
  REFRESH_IDX: 10000,      // 指数刷新间隔（ms）
  REFRESH_API: 60000,      // 基金数据刷新间隔（ms）
  T_PRE_MARKET: 540,       // 盘前开始（分钟）09:00
  T_OPEN: 570,             // 开盘（分钟）09:30
  T_MID_BREAK: 690,        // 午休开始（分钟）11:30
  T_AFTERNOON: 780,        // 下午开盘（分钟）13:00
  T_CLOSE: 900,            // 收盘（分钟）15:00
  FETCH_EST_TIMEOUT: 3000, // 估算净值请求超时（ms）
  FETCH_OFF_TIMEOUT: 1500, // 官方净值单次请求超时（ms）
  FETCH_OFF_DRAIN_DELAY: 0,// 官方净值串行队列间隔（ms）
};

// ---- 市场常量 ----
const DAYS = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
];

const INDICES = [
  { id: "000300", lbl: "沪深300" },
  { id: "000510", lbl: "中证A500" },
  { id: "000905", lbl: "中证500" },
  { id: "H30269", lbl: "红利低波" },
  { id: "000832", lbl: "中证转债" },
  { id: "HSI", lbl: "恒生指数" },
];

// ---- 默认看板列表 ----
const DEFAULT_CODES = [
  SYS_CONFIG.CODE_XQ,  // 003949 兴全稳泰债券A
  "160622",            // 鹏华丰利债券LOF
  "110027",            // 易方达安心回报A
  "011554",            // 海富通欣利混合A
  "007466",            // 华泰柏瑞红利低波联接A
  SYS_CONFIG.CODE_A500,// 022435 南方中证A500ETF联接C
];

// ---- 基金名称表 ----
const NAMES = {
  [SYS_CONFIG.CODE_XQ]: "兴全稳泰债券A",
  160622: "鹏华丰利债券LOF",
  110027: "易方达安心回报A",
  "011554": "海富通欣利混合A",
  "007466": "华泰柏瑞红利低波联接A",
  [SYS_CONFIG.CODE_A500]: "南方中证A500ETF联接C",
};

const SHORT_NAMES = {
  [SYS_CONFIG.CODE_XQ]: "兴全中长债",
  160622: "鹏华丰利",
  "007466": "华泰红利",
  "011554": "海富通欣利",
  110027: "易方达回报",
  [SYS_CONFIG.CODE_A500]: "南方A500C",
};

// ---- 产品属性表（参与权益计算）----
const PRODUCTS = [
  { code: SYS_CONFIG.CODE_XQ, name: "兴全中长债", equity: 0.0 },
  { code: "160622", name: "鹏华丰利", equity: 0.15 },
  { code: "007466", name: "华泰红利", equity: 0.55 },
  { code: "011554", name: "海富通欣利", equity: 0.4 },
  { code: "110027", name: "易方达回报", equity: 0.2 },
  { code: SYS_CONFIG.CODE_A500, name: "南方A500C", equity: 1.0 },
];

// ---- PE 12档 S曲线映射表（v7.5方法论）----
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

// ---- localStorage Key ----
const STORE_CODES = "fm_v20";
const STORE_PE = "jy_pe_v2_lagrange";
const STORE_HOLDINGS = "jy_holdings_v1";
const STORE_SELL_PLAN = "jy_sell_plan_v1";
const STORE_PRIORITY_SELL = "jy_priority_sell_v1";
const STORE_GIST_ID = "fm_gist_id";
const STORE_GIST_TOKEN = "fm_gist_token";

// ---- 纯工具函数（无副作用，供所有层调用）----
// 中证500角色识别：名称含「中证500」即为增权溢出/降权最高优先品种
function isZZ500Product(name) {
  return !!(name && name.includes("中证500"));
}

// ---- Gist 文件名 ----
const GIST_FILE_PE = "fm_pe.json";
const GIST_FILE_CONFIG = "fm_config.json";

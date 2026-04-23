// ==========================================
// 1. 全局系统配置 (SYS_CONFIG)
// ==========================================
const SYS_CONFIG = {
  FEE: 0.005,              // 全局默认摩擦费率 (0.5%)
  DEAD_ZONE: 2.5,          // PE动态死区缓冲范围 (±2.5%)
  CODE_XQ: '003949',       // 兴全中长债
  CODE_A500: '022439',     // 华泰柏瑞A500C
  CODE_ZZ500: '000500',    // 中证500C
  LIMIT_A500C: 0.20,       // 单品 20% 铁律红线
  REFRESH_IDX: 10000,      // 指数刷新间隔 (10秒)
  REFRESH_API: 60000,      // API轮询间隔 (60秒)
  T_PRE_MARKET: 540,       // 09:00 (距离0点的分钟数)
  T_OPEN: 570,             // 09:30
  T_MID_BREAK: 690,        // 11:30
  T_AFTERNOON: 780,        // 13:00
  T_CLOSE: 900             // 15:00
};

// ==========================================
// 2. 市场与常量定义
// ==========================================
const DAYS = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
const INDICES = [
  {id:'000300', lbl:'沪深300'}, {id:'000510', lbl:'中证A500'}, 
  {id:'000905', lbl:'中证500'}, {id:'H30269', lbl:'红利低波'}, 
  {id:'000012', lbl:'国债指数'}, {id:'HSI', lbl:'恒生指数'}
];

// ==========================================
// 3. 产品库与梯度矩阵
// ==========================================
const DEFAULT_CODES = [SYS_CONFIG.CODE_XQ,'160622','110027','011554','007466','004496',SYS_CONFIG.CODE_A500,'007028'];
const NAMES = {
  [SYS_CONFIG.CODE_XQ]: '兴全稳泰债券A', '160622': '鹏华丰利债券LOF', 
  '110027': '易方达安心回报A', '011554': '海富通欣利混合A', 
  '007466': '华泰柏瑞红利低波联接A', '004496': '前海开源多元策略A', 
  '110020': '易方达沪深300联接A', [SYS_CONFIG.CODE_A500]: '华泰柏瑞A500联接C', 
  '007028': '易方达中证500联接A'
};
const SHORT_NAMES = {
  [SYS_CONFIG.CODE_XQ]: '兴全中长债', '160622': '鹏华丰利', 
  '007466': '华泰红利', '011554': '海富通欣利', 
  '110027': '易方达回报', '004496': '前海多元', 
  '110020': '易方达沪深300', [SYS_CONFIG.CODE_A500]: 'A500C', 
  '007028': '易方达中证500联接', [SYS_CONFIG.CODE_ZZ500]: '中证500C'
};

// 物理引擎核心：产品属性表
const PRODUCTS = [
  {code: SYS_CONFIG.CODE_XQ, name: '兴全中长债', equity: 0.00},
  {code: '160622', name: '鹏华丰利', equity: 0.15},
  {code: '007466', name: '华泰红利', equity: 0.55},
  {code: '011554', name: '海富通欣利', equity: 0.40},
  {code: '110027', name: '易方达回报', equity: 0.20},
  {code: '004496', name: '前海开源多元策略', equity: 0.75},
  {code: SYS_CONFIG.CODE_A500, name: 'A500C', equity: 1.00},
  {code: SYS_CONFIG.CODE_ZZ500, name: '中证500C', equity: 1.00}
];

// 拉格朗日定锚：12档 S 曲线映射表
const PE_EQUITY_TABLE = [
  {lo: 80, hi: 999, target: 20}, {lo: 75, hi: 80, target: 22},
  {lo: 70, hi: 75, target: 25}, {lo: 65, hi: 70, target: 29},
  {lo: 60, hi: 65, target: 34}, {lo: 55, hi: 60, target: 40},
  {lo: 50, hi: 55, target: 46}, {lo: 45, hi: 50, target: 52},
  {lo: 40, hi: 45, target: 57}, {lo: 35, hi: 40, target: 61},
  {lo: 30, hi: 35, target: 70}, {lo: 0, hi: 30, target: 80}
];

// 默认持仓 (回退/初始化使用)
const DEFAULT_HOLDINGS = {
  [SYS_CONFIG.CODE_XQ]: 66432.56, '160622': 110301.46, '007466': 63243.39, 
  '011554': 73105.15, '110027': 41234.41, '004496': 12154.72, 
  [SYS_CONFIG.CODE_A500]: 0, [SYS_CONFIG.CODE_ZZ500]: 0
};

// ==========================================
// 4. 存储 Key
// ==========================================
const STORE_CODES = 'fm_v20';
const STORE_PE = 'jy_pe_v2_lagrange';
const STORE_PE_DATE = 'jy_pe_date_v2';
const STORE_HOLDINGS = 'jy_holdings_v1';
const STORE_SELL_PLAN = 'jy_sell_plan_v1';
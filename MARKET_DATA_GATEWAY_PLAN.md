# 三路市场数据网关修订计划：Cloudflare Pages Functions + 腾讯云 DNS

> 替换此前计划中的全部域名和 Worker Custom Domain 内容。  
> Terra 应将本计划保存为项目根目录 `MARKET_DATA_GATEWAY_PLAN.md`。  
> 当前会话处于只读规划模式，我未直接修改仓库。

## 1. 立即纠正 Terra 的执行方向

Terra 可以继续：

- 三条数据链主备实现。
- 整组完整性校验。
- Worker/Pages Functions解析代码。
- 单元测试和GitHub工作流。
- 前端备用状态提示。

Terra 必须停止：

- 修改腾讯云域名的权威DNS服务器。
- 把整个老域名加入Cloudflare Zone。
- 配置Standalone Worker Custom Domain。
- 修改现有 `fund.bailuzun.com` 和其他子域名。
- 运行需要Cloudflare账号权限的部署操作。

新的责任边界：

| 工作                     | 负责人      |
| ---------------------- | -------- |
| 编写代码、测试、提交GitHub       | Terra    |
| 创建Cloudflare Pages项目   | 用户       |
| 授权Cloudflare读取GitHub仓库 | 用户       |
| 设置Pages环境变量            | 用户       |
| 在腾讯云新增一条CNAME          | 用户       |
| 检查Cloudflare证书         | 用户       |
| 查看GitHub Actions验收结果   | Terra/用户 |

## 2. 最终部署架构

不再使用Standalone Worker Custom Domain，改用Cloudflare Pages Functions。

```text
GitHub仓库
    │
    ├─ GitHub Pages
    │    └─ fund.bailuzun.com：首页
    │
    └─ Cloudflare Pages Git集成
         └─ fund-market-api.pages.dev
              └─ 腾讯云单条CNAME
                   fund-api.bailuzun.com
```

腾讯云继续管理整个老域名，只新增：

```text
记录类型：CNAME
主机记录：fund-api
记录值：fund-market-api.pages.dev
TTL：600
```

其他DNS记录、子域名和权威DNS服务器全部不变。

Cloudflare官方明确支持：外部DNS服务商管理的域名，可以用一条CNAME把子域名接入Pages，不需要切换Nameserver。[Pages Custom Domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)

## 3. Pages Functions工程

Terra将数据网关调整为：

```text
workers/
└── fund-market-api/
    ├── functions/
    │   └── [[path]].js
    ├── src/
    │   ├── router.mjs
    │   ├── upstreams.mjs
    │   └── parsers.mjs
    ├── public/
    │   ├── index.html
    │   └── _routes.json
    └── test/
        └── gateway.test.mjs
```

`functions/[[path]].js`仅做Pages Functions入口：

```js
export async function onRequest(context) {
  return handleRequest(context.request, context.env, context);
}
```

`public/_routes.json`只让API路径进入Functions：

```json
{
  "version": 1,
  "include": ["/v1/*"],
  "exclude": []
}
```

`public/index.html`仅返回API健康说明，不承载基金首页。

Cloudflare Pages项目配置：

```text
Production branch：main
Root directory：workers/fund-market-api
Framework preset：None
Build command：留空
Build output directory：public
```

## 4. 三路整组主备

### 顶部指数

`GET /v1/indices`

- 主线路：腾讯批量指数。
- 备用线路：东方财富批量指数。
- 固定6只指数必须全部完整。
- 沪深300 PE、点位、总市值必须随接口返回；主线路缺 PE 或总市值即整组作废。
- 主线路少任意一只或缺锚定字段，丢弃主线路整组，全部切东方财富。
- 东方财富也少一只，整组不可用。
- 指数缓存3秒。

> **2026-07-19 主备对调（原定东方财富为主线路）**：实测东方财富唯一可达镜像 `push2delay` 返回
> `f115=0 / f116=0`，即无 PE、无总市值；`push2his`、`push2` 不可达。而 `js/ui-pe.js` 的 PE bar
> 锚定 `getEnginePE1`（1.0 总市值路），其唯一输入是沪深300实时总市值——主线路缺该字段会让 bar
> 静默冻结在昨收 PE。腾讯三项齐全，故指数组主备对调。东方财富降为备用后仅供点位，UI 显示
> ⚠ 备用线路时即代表 PE bar 已退化为昨收锚定。

### 盘中估算

`GET /v1/funds/estimate?codes=...`

- 主线路：天天基金 `fundgz`。
- 备用线路：腾讯基金 `jj{code}`。
- 主线路必须完整覆盖所有基金。
- 任意一只缺少 `gsz/gszzl/gztime`，主线路整组作废。
- 腾讯备用必须全部具有合法估算净值、估算涨跌幅和估算时间。
- 腾讯 `[5]` 官方净值不得填入估算字段或官方链。
- 两组均失败时整组估算不可用。
- 缓存15秒。

### 官方净值

`GET /v1/funds/official?codes=...`

- 主线路：`FundMNFInfo`。
- 备用线路：`FundMNHisNetList`。
- 主线路少任意基金，丢弃主线路整组。
- 备用也必须完整覆盖全部基金。
- 两组均失败时官方整组不可用。
- 禁止腾讯或盘中估算补官方字段。
- 成功缓存60秒；失败不缓存。

三个接口统一返回：

```json
{
  "ok": true,
  "status": "primary",
  "source": "eastmoney",
  "sourceLabel": "东方财富指数主线路",
  "quoteAt": "2026-07-20 10:30:00",
  "data": []
}
```

`status`只能为：

```text
primary
backup
unavailable
```

响应内不得存在逐行来源字段。

## 5. 前端提示

页面三个区域分别显示一次整组来源：

- 顶部指数区：指数来源。
- 基金表盘中估算列表头：估算来源。
- 基金表官方净值列表头：官方来源。
- 移动端在基金卡片列表上方统一显示，不按卡片重复。

文案：

```text
主线路 · 东方财富指数
⚠ 备用线路 · 腾讯指数
主线路 · 天天基金盘中估算
⚠ 备用线路 · 腾讯基金估算
主线路 · 天天基金移动批量
⚠ 备用线路 · 天天基金历史净值
不可用 · 对应数据组
```

样式：

- 主线路：中性蓝灰。
- 备用线路：琥珀色，必须带“⚠ 备用线路”。
- 不可用：红色。
- 来源提示不得依赖控制台或展开操作。

浏览器只请求：

```text
https://fund-api.bailuzun.com/v1/indices
https://fund-api.bailuzun.com/v1/funds/estimate
https://fund-api.bailuzun.com/v1/funds/official
```

不再直接访问第三方行情域名。

## 6. 两阶段发布

### 第一阶段：只发布API代码

Terra第一个提交只包含：

- `workers/fund-market-api/`
- 单元测试。
- GitHub Actions API验收工作流。
- Cloudflare手工配置说明。

不得在第一阶段修改前端API地址。

Terra push后，用户完成Cloudflare Pages配置。

### 第二阶段：切换前端

只有以下条件满足后，Terra才修改前端：

- `fund-market-api.pages.dev`部署成功。
- 自定义子域名证书正常。
- `fund-api.bailuzun.com`三个API均能访问。
- GitHub Actions真实出口验收通过。
- 三条备用线路均验证成功。

然后Terra：

- 将前端API基址改为 `https://fund-api.bailuzun.com`。
- 删除浏览器第三方JSONP调用。
- 完成页面主备提示。
- 本地HTTP测试后提交第二个commit并push。

这样即使Cloudflare配置未完成，现有GitHub Pages也不会提前失效。

## 7. 用户手工操作

### 创建Cloudflare Pages项目

1. 登录Cloudflare。
2. 打开 `Workers & Pages`。
3. 选择 `Create application` → `Pages` → `Connect to Git`。
4. 授权Cloudflare GitHub应用访问：

```text
srbaby/fund-monitor
```

5. 填写：

```text
Project name：fund-market-api
Production branch：main
Root directory：workers/fund-market-api
Framework preset：None
Build command：留空
Build output directory：public
```

6. 点击部署。
7. 确认以下地址可访问：

```text
https://fund-market-api.pages.dev/
```

### 设置诊断密钥

Cloudflare Pages项目：

```text
Settings
→ Environment variables
→ Production
→ 添加 DIAGNOSTIC_TOKEN
```

使用随机长字符串，不写入Git。

GitHub仓库：

```text
Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

添加：

```text
名称：MARKET_API_DIAGNOSTIC_TOKEN
值：与Cloudflare DIAGNOSTIC_TOKEN相同
```

诊断密钥仅允许GitHub Actions强制测试主/备用，不参与普通页面访问。

### 添加自定义子域名

顺序不能颠倒：

1. Cloudflare Pages项目打开 `Custom domains`。
2. 选择 `Set up a domain`。
3. 输入：

```text
fund-api.bailuzun.com
```

4. Cloudflare提示添加CNAME后，再进入腾讯云DNS。
5. 腾讯云只新增：

```text
CNAME  fund-api  fund-market-api.pages.dev
```

6. 不修改NS，不删除或迁移其他记录。
7. 等待Cloudflare状态变为Active并签发HTTPS证书。
8. 如果长期停留在验证状态，检查老域名是否配置了限制证书机构的CAA记录。

手工直接添加CNAME但未先在Pages项目关联域名，可能返回522，因此必须先在Cloudflare Pages中添加自定义域名。[Cloudflare Pages说明](https://developers.cloudflare.com/pages/configuration/custom-domains/)

## 8. GitHub Actions真实验收

Terra新增手动工作流：

```text
.github/workflows/market-api-smoke.yml
```

输入：

```text
base_url
```

用户首次运行时填写：

```text
https://fund-market-api.pages.dev
```

域名启用后再次填写：

```text
https://fund-api.bailuzun.com
```

工作流使用诊断密钥测试：

```text
/v1/indices?force=primary
/v1/indices?force=backup
/v1/funds/estimate?codes=六只基金&force=primary
/v1/funds/estimate?codes=六只基金&force=backup
/v1/funds/official?codes=六只基金&force=primary
/v1/funds/official?codes=六只基金&force=backup
```

生产普通请求携带 `force` 但没有正确诊断密钥时，必须返回403。

验收要求：

- 每组代码集合完整。
- `force=primary`只返回主线路。
- `force=backup`只返回备用线路。
- 不存在主备混合。
- 腾讯中文名称无GBK乱码。
- 官方主备均低于5秒。（原定主线路2秒。GitHub Actions 在美国 colo 触发，Function 回源境内，
  实测 2 秒上限会周期性 abort 主线路、把整组无谓地打到历史备用，故统一为5秒。）
- 盘中估算备用必须在交易日盘中验证；非盘中腾讯估算字段可能为空，不能据此宣布通过。

## 9. 最终约束

- 腾讯云继续作为老域名唯一权威DNS。
- 只新增一条 `fund-api` CNAME。
- GitHub Pages及 `fund.bailuzun.com` 保持不变。
- Terra不需要、也不应取得Cloudflare或腾讯云权限。
- Cloudflare部署全部通过GitHub集成完成。
- 原有 `pe-night-trigger` 不合并、不修改。
- API未部署并验收前，禁止切换前端。
- 前端、API和自定义域名全部通过后才能宣布完成。

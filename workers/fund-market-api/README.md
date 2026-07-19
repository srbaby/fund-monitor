# Fund Market API (Cloudflare Pages Functions)

The board at `fund.bailuzun.com` fetches all of its market data from here and contacts no third-party
quote host directly. Breaking an endpoint breaks the board.

## Pages configuration

- Project name: `fund-market-api`
- Production branch: `main`
- Root directory: `workers/fund-market-api`
- Framework preset: `None`
- Build command: leave empty
- Build output directory: `public`

Add the production environment variable `DIAGNOSTIC_TOKEN` as a random long string. Do not commit it. Add the same value to the repository Actions secret `MARKET_API_DIAGNOSTIC_TOKEN`.

After the first deployment succeeds, add `fund-api.bailuzun.com` under the Pages project's **Custom domains** page. Only then add this Tencent Cloud DNS record:

```text
CNAME  fund-api  fund-market-api.pages.dev  TTL 600
```

Do not change the authoritative nameservers, existing DNS records, `fund.bailuzun.com`, or the existing `pe-night-trigger` Worker.

## API contract

- `GET /v1/indices`
- `GET /v1/funds/estimate?codes=003949,160622`
- `GET /v1/funds/official?codes=003949,160622`

Each endpoint selects a complete primary group or a complete backup group. It never mixes records, and a
group that cannot be completed is reported `unavailable` rather than half-filled. Querying `force=primary`
or `force=backup` requires the `X-Diagnostic-Token` header; other callers receive `403`.

| endpoint | primary | backup |
| --- | --- | --- |
| `/v1/indices` | Tencent `qt.gtimg.cn` | Eastmoney `push2delay` mirror |
| `/v1/funds/estimate` | Tiantian `fundgz` | Tencent `jj<code>` |
| `/v1/funds/official` | `FundMNFInfo` | `FundMNHisNetList` |

Indices run Tencent-first because the board's PE bar anchors on HS300 realtime market cap and the reachable
Eastmoney mirror returns `f115=f116=0`. A primary index group missing `pe`/`marketCap` is rejected, so the
assertion in the smoke workflow guards the PE bar, not just field counts.

Tencent's fund quote is ten fields wide, not the wide stock layout: `[2..4]` are the intraday estimate and
`[5..8]` the official NAV block. `[5]` is an official NAV and must never be served as an estimate.

## Verification

```text
node --test test/gateway.test.mjs
```

End-to-end acceptance is the `Market API smoke` workflow, run manually against a `base_url`. Pass
`market_session=open` only during a mainland trading session: Tencent zeroes its fund estimate outside one,
so the estimate backup leg cannot be verified off-session and the run reports it as unverified rather than
counting it as a pass.

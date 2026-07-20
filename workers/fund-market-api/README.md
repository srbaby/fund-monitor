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

### KV binding `MARKET_LKG` (required for the last-known-good protection)

Create a KV namespace and bind it to this Pages project as **`MARKET_LKG`**:

```text
Workers & Pages → KV → Create namespace → name: fund-market-lkg
Pages project fund-market-api → Settings → Functions → KV namespace bindings
  Variable name: MARKET_LKG      Namespace: fund-market-lkg
```

Bind it for **Production** (and Preview if you use preview deployments). Without the binding the gateway
still works and simply reports `unavailable` on failure, exactly as it did before the protection existed —
so a missing binding degrades quietly instead of breaking the board, but the board loses the protection.

Writes are throttled to one per key per 5 minutes and stored groups expire after 72 hours, which keeps the
namespace far inside the free tier while still covering a weekend.

`fund-api.bailuzun.com` is registered under the Pages project's **Custom domains** page and resolves through
this Tencent Cloud DNS record:

```text
CNAME  fund-api  fund-market-api.pages.dev  TTL 600
```

Do not change the authoritative nameservers, existing DNS records, `fund.bailuzun.com`, or the existing
`pe-night-trigger` Worker.

## Why the host is locked in code

`bailuzun.com` is served by Tencent Cloud DNS, so it is **not a Cloudflare zone** and no WAF or rate-limiting
rule can be attached to it — account-level WAF is Enterprise-only and zone rules need a zone. The only place
left to close the door is the Function itself.

`/v1/*` therefore answers anonymously **only** on `fund-api.bailuzun.com`. `*.pages.dev`, preview deployment
hostnames and subdomain probes get `403 host_not_allowed`, because they reach the same code and trigger the
same upstream calls while sitting outside even the custom domain's control. Requests carrying a valid
`X-Diagnostic-Token` are exempt, which keeps `pages.dev` usable for debugging if the certificate or the CNAME
ever breaks.

Note this covers the API only. `/` and other static assets are served by Pages before the Function runs, so
they stay reachable everywhere — harmless, since they make no upstream calls.

## API contract

- `GET /v1/indices`
- `GET /v1/funds/estimate?codes=003949,160622`
- `GET /v1/funds/official?codes=003949,160622`

Each endpoint selects a complete primary group or a complete backup group. It never mixes records, and a
group that cannot be completed is **not** served half-filled. Querying `force=primary`
or `force=backup` requires the `X-Diagnostic-Token` header; other callers receive `403`.

`status` is one of:

| status | meaning | `ok` |
| --- | --- | --- |
| `primary` / `backup` | fresh data from that line | `true` |
| `stale` | both lines failed, so the last known good group is served from KV | `true` |
| `unavailable` | both lines failed and there is no usable stored group | `false` |

A `stale` payload keeps every record's original timestamp and adds `servedFrom`, `staleSince` and
`staleAgeMs`. **The board must render it and mark it visibly stale** — serving old data silently is the
one outcome this design refuses. See `docs/DECISIONS.md` D-001 for why the protection lives here and not
in the browser: `localStorage` is per-device, so a second computer opening the board at night saw a blank
page even while the first one still had the day's data.

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

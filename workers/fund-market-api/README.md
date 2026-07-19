# Fund Market API (Cloudflare Pages Functions)

This directory is the first release phase only. It does not change the GitHub Pages frontend or `fund.bailuzun.com`.

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

Each endpoint selects a complete primary group or a complete backup group. It never mixes records. Querying `force=primary` or `force=backup` requires the `X-Diagnostic-Token` header; other callers receive `403`.

Run tests with:

```text
node --test test/gateway.test.mjs
```

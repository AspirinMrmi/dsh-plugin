# Balance and price window

Adds a compact card in the sidebar, directly above the account avatar row (`sidebar.footer.action`):

- **Balance** — the signed-in DeepSeek account wallet (CNY preferred).
- **Session** — what this Session has cost so far, priced request by request at the moment each request started (see below).
- **Peak/off-peak** — the current DeepSeek API price tier and a live countdown to the next switch.

The card carries only labels and numbers. Hovering shows the full detail (billed request count, cache-hit rate, next switch time in Beijing time, schedule, calendar status, update time); clicking refreshes both values. In the collapsed rail the card hides, because the rail has no room for it.

## Pricing rule

Per the [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) (since 2026-08-17):

- Peak hours are **09:00–12:00 and 14:00–18:00 Beijing time, Monday–Friday**, excluding Chinese public holidays. Off-peak is everything else, including full weekends and holidays.
- Off-peak rates are **half** of peak rates.

The holiday calendar comes from [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn) (jsDelivr, with two mirrors). If every source is unreachable, the pill falls back to weekday-only math and says so in the details panel.

## Session spend

Every `assistant/message` event with provider usage is priced once:

```
cost = cacheReadTokens × hit + (inputTokens + cacheWriteTokens) × miss + outputTokens × output
```

`inputTokens` is the uncached prompt part; `cacheReadTokens` is billed at the cache-hit price; `reasoningTokens` is already inside `outputTokens` and is not added again. The tier is decided by the request's start time (the earliest stream timestamp of that message), so a Session that runs across a switch is charged per request instead of at one flat rate.

CNY peak prices per 1M tokens, halved off-peak:

| Model | Cache hit | Cache miss | Output |
| --- | --- | --- | --- |
| `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` | ¥0.04 | ¥2 | ¥8 |
| `deepseek-v4-pro` | ¥0.30 | ¥9 | ¥27 |

Requests served by another model (for example a Claude route through a gateway) have no official DeepSeek price; they are counted as requests but left out of the amount, and the panel says so. Treat the figure as a close estimate: retried attempts with provider usage are counted, and a single request that straddles a boundary is priced once.

## Host route

One same-origin, read-only route:

```
GET /api/deepseek-balance-peak/summary?locale=<tag>&tz=<utcOffsetSeconds>&sessionId=<SessionId>
```

It reads wallets through the Host-only `ctx.deepseekAccount.getBalance` service and the Session log through `ctx.sessionQuery.readSession`, so no credential or message content reaches the browser — only aggregate numbers. Responses are `no-store`, refuse cross-site requests, cache balances for `balanceCacheSeconds`, and cache one Session's spend for 20 seconds.

## Configuration

```yaml
- id: deepseek-balance-peak
  config:
    balanceCacheSeconds: 45   # 10–600, default 45
    extraHolidays: []         # extra off-peak dates, YYYY-MM-DD (Beijing)
    peakWindows: [[540, 720], [840, 1080]]  # optional minutes-of-day override
```

## Notes

- The balance needs a signed-in DeepSeek account in this profile. Signed out shows `未登录 / Not signed in`; a failed Platform read shows `余额不可用 / Balance unavailable` while the countdown keeps working.
- The countdown is computed in the browser from the Beijing clock, so a system time zone other than Asia/Shanghai does not shift the windows.
- After installing or editing `client.js`, reload the Harness page (Ctrl/Cmd+Shift+R) to load the new client module.

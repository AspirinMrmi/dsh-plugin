/**
 * Host half of the balance / peak-price bundle.
 *
 * Serves one same-origin read-only route:
 *   GET /api/deepseek-balance-peak/summary?locale=<tag>&tz=<offset>&sessionId=<id>
 *
 * The response carries:
 * - the signed-in account wallet balances (read through `ctx.deepseekAccount`,
 *   never exposed to the browser as a credential);
 * - the official peak windows in Beijing minutes-of-day plus the Chinese
 *   public holiday calendar;
 * - this Session's spend, priced request by request at the moment the request
 *   started, so a Session that crosses peak and off-peak is accurate.
 */

const ROUTE = '/api/deepseek-balance-peak/summary'
const BEIJING_OFFSET_MS = 8 * 3_600_000
const DEFAULT_PEAK_WINDOWS = [[540, 720], [840, 1_080]]
const HOLIDAY_TTL_MS = 12 * 3_600_000
const HOLIDAY_FAILURE_TTL_MS = 10 * 60_000
const HOLIDAY_TIMEOUT_MS = 5_000
const SESSION_CACHE_TTL_MS = 20_000
const SESSION_CACHE_LIMIT = 40

const HOLIDAY_SOURCES = [
  (year) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  (year) => `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
]

// Official CNY prices per 1M tokens, PEAK tier; off-peak is half (see
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing).
const MODEL_PRICES = new Map([
  ['deepseek-flash', { hit: 0.04, miss: 2, output: 8 }],
  ['deepseek-v4-flash', { hit: 0.04, miss: 2, output: 8 }],
  ['deepseek-v4-flash-vision-exp', { hit: 0.04, miss: 2, output: 8 }],
  ['deepseek-v4-pro', { hit: 0.3, miss: 9, output: 27 }],
])

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const SESSION_ID = /^[A-Za-z0-9._:-]{3,200}$/

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

function isDateKey(value) {
  return typeof value === 'string' && DATE_KEY.test(value)
}

function normalizeWindows(input) {
  if (!Array.isArray(input)) return DEFAULT_PEAK_WINDOWS
  const windows = []
  for (const item of input) {
    if (!Array.isArray(item) || item.length !== 2) continue
    const [start, end] = item
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start < 0 || end > 1_440 || start >= end) continue
    windows.push([Math.trunc(start), Math.trunc(end)])
  }
  windows.sort((a, b) => a[0] - b[0])
  return windows.length > 0 ? windows : DEFAULT_PEAK_WINDOWS
}

function normalizeLocale(value) {
  return typeof value === 'string' && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(value)
    ? value
    : 'en'
}

function normalizeOffset(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return -new Date().getTimezoneOffset() * 60
  return Math.max(-14 * 3_600, Math.min(14 * 3_600, Math.trunc(seconds)))
}

function normalizeSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null
}

function beijingParts(ms) {
  const date = new Date(ms + BEIJING_OFFSET_MS)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
  }
}

function beijingDayKey(ms) {
  const parts = beijingParts(ms)
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

function isPeakAt(ms, windows, holidays) {
  const parts = beijingParts(ms)
  if (parts.weekday === 0 || parts.weekday === 6) return false
  if (holidays.has(beijingDayKey(ms))) return false
  return windows.some(([start, end]) => parts.minutes >= start && parts.minutes < end)
}

function priceFor(model) {
  if (typeof model !== 'string' || model.length === 0) return null
  const name = model.split('/').pop().toLowerCase()
  return MODEL_PRICES.get(name) ?? null
}

/** Earliest stream timestamp of one assistant message, when the log recorded one. */
function requestStart(stream) {
  if (!Array.isArray(stream)) return null
  let earliest = null
  for (const record of stream) {
    const time = typeof record?.time0 === 'number' ? record.time0 : record?.time
    if (typeof time !== 'number') continue
    if (earliest === null || time < earliest) earliest = time
  }
  return earliest
}

function holidayYears(nowMs) {
  const year = beijingParts(nowMs).year
  return [year, year + 1]
}

async function fetchYear(year) {
  for (const source of HOLIDAY_SOURCES) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HOLIDAY_TIMEOUT_MS)
    try {
      const response = await fetch(source(year), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) continue
      const body = await response.json()
      const days = Array.isArray(body?.days) ? body.days : []
      const dates = days
        .filter((day) => day && day.isOffDay === true && isDateKey(day.date))
        .map((day) => day.date)
      if (days.length > 0) return { at: Date.now(), ok: true, dates }
    } catch {
      // Try the next mirror.
    } finally {
      clearTimeout(timer)
    }
  }
  return { at: Date.now(), ok: false, dates: [] }
}

function emptySpend() {
  return {
    cost: 0,
    requests: 0,
    unpriced: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    models: {},
    asOfSeq: 0,
  }
}

export function apply(ctx, config = {}) {
  const server = ctx.get('webServer')
  if (server === undefined) {
    console.error('[deepseek-balance-peak] webServer is unavailable; the balance endpoint was not registered')
    return
  }

  const account = ctx.get('deepseekAccount')
  const sessionQuery = ctx.get('sessionQuery')
  const version = typeof config.version === 'string' && config.version.length > 0 ? config.version : '1.0.0'
  const peakWindows = normalizeWindows(config.peakWindows)
  const extraHolidays = new Set(
    Array.isArray(config.extraHolidays) ? config.extraHolidays.filter(isDateKey) : [],
  )
  const cacheSeconds = Number(config.balanceCacheSeconds)
  const balanceTtlMs = (Number.isFinite(cacheSeconds) ? Math.max(10, Math.min(600, cacheSeconds)) : 45) * 1_000

  const holidayCache = new Map()
  const sessionCache = new Map()
  let balanceCache = null
  let balanceInflight = null

  async function holidaysFor(years) {
    const entries = await Promise.all(
      years.map(async (year) => {
        const hit = holidayCache.get(year)
        const ttl = hit?.ok ? HOLIDAY_TTL_MS : HOLIDAY_FAILURE_TTL_MS
        if (hit && Date.now() - hit.at < ttl) return hit
        const entry = await fetchYear(year)
        holidayCache.set(year, entry)
        return entry
      }),
    )
    const holidays = new Set(extraHolidays)
    let complete = true
    for (const entry of entries) {
      if (!entry.ok) complete = false
      for (const date of entry.dates) holidays.add(date)
    }
    return { holidays, complete }
  }

  async function accountSnapshot(locale, timezoneOffsetSeconds) {
    if (account === undefined) {
      return { signedIn: false, balanceError: 'account-service-unavailable' }
    }
    if (balanceCache !== null && Date.now() - balanceCache.at < balanceTtlMs) return balanceCache.value
    if (balanceInflight !== null) return balanceInflight
    balanceInflight = (async () => {
      try {
        const balance = await account.getBalance({ version, locale, timezoneOffsetSeconds })
        if (balance === null) return { signedIn: false }
        if (balance.status !== 'ready') return { signedIn: true, balanceError: 'request-failed' }
        const project = (wallet) => ({ currency: wallet.currency, balance: wallet.balance })
        return {
          signedIn: true,
          wallets: balance.value.map(project),
          bonusWallets: balance.bonusWallets.map(project),
        }
      } catch {
        return { signedIn: true, balanceError: 'request-failed' }
      }
    })()
      .then((value) => {
        balanceCache = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        balanceInflight = null
      })
    return balanceInflight
  }

  async function computeSpend(sessionId, holidays) {
    const snapshot = await sessionQuery.readSession(sessionId)
    const spend = emptySpend()
    for (const event of snapshot.events) {
      if (event.type !== 'assistant/message') continue
      const usage = event.data?.usage
      if (!usage) continue
      const model = event.data?.message?.source?.model ?? 'unknown'
      const name = model.split('/').pop().toLowerCase()
      const startedAt = requestStart(event.data.stream)
      const billedAt = startedAt ?? event.time
      const peak = isPeakAt(billedAt, peakWindows, holidays)

      spend.requests += 1
      spend.models[name] = (spend.models[name] ?? 0) + 1
      spend.inputTokens += usage.inputTokens ?? 0
      spend.cacheReadTokens += usage.cacheReadTokens ?? 0
      spend.cacheWriteTokens += usage.cacheWriteTokens ?? 0
      spend.outputTokens += usage.outputTokens ?? 0
      spend.asOfSeq = Math.max(spend.asOfSeq, event.seq)

      const price = priceFor(model)
      if (price === null) {
        spend.unpriced += 1
        continue
      }
      const factor = peak ? 1 : 0.5
      const missTokens = (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      spend.cost +=
        ((missTokens * price.miss +
          (usage.cacheReadTokens ?? 0) * price.hit +
          (usage.outputTokens ?? 0) * price.output) *
          factor) /
        1_000_000
    }
    return spend
  }

  async function sessionSpend(sessionId, holidays) {
    if (sessionQuery === undefined || sessionId === null) return null
    const cached = sessionCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < SESSION_CACHE_TTL_MS) return cached.value
    try {
      const value = await computeSpend(sessionId, holidays)
      sessionCache.set(sessionId, { at: Date.now(), value })
      if (sessionCache.size > SESSION_CACHE_LIMIT) {
        const oldest = sessionCache.keys().next().value
        if (oldest !== undefined) sessionCache.delete(oldest)
      }
      return value
    } catch {
      return null
    }
  }

  async function buildSummary(locale, timezoneOffsetSeconds, sessionId) {
    const now = Date.now()
    const { holidays, complete } = await holidaysFor(holidayYears(now))
    const [balance, spend] = await Promise.all([
      accountSnapshot(locale, timezoneOffsetSeconds),
      sessionSpend(sessionId, holidays),
    ])
    return {
      ok: true,
      fetchedAt: now,
      pricing: {
        timeZone: 'Asia/Shanghai',
        peakWindows,
        holidays: [...holidays].sort(),
        calendar: complete ? 'holiday-cn' : 'unavailable',
      },
      ...balance,
      session: spend,
    }
  }

  async function handle(req, res) {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.statusCode = 403
      res.end()
      return
    }

    let payload
    try {
      const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1')
      payload = await buildSummary(
        normalizeLocale(url.searchParams.get('locale')),
        normalizeOffset(url.searchParams.get('tz')),
        normalizeSessionId(url.searchParams.get('sessionId')),
      )
    } catch {
      payload = { ok: false, error: 'summary-failed', fetchedAt: Date.now() }
    }

    const body = JSON.stringify(payload)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Length', Buffer.byteLength(body))
    if (method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  }

  ctx.effect(() => server.register({ kind: 'exact', path: ROUTE, handler: handle }))
}

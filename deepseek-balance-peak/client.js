/**
 * Client half of the balance / peak-price bundle.
 *
 * Renders one card in `sidebar.footer.action`, which the sidebar lays out
 * directly above the account launcher (the avatar row). The card is compact
 * on purpose: balance, this Session's spend, and the price tier with the
 * countdown. Everything explanatory lives in the tooltip.
 */

window.__ModuleLoader__.load({
  id: '@local/deepseek-balance-peak',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-balance-peak'
    const ENDPOINT = '/api/deepseek-balance-peak/summary'
    const DAY_MS = 86_400_000
    const BEIJING_OFFSET_MS = 8 * 3_600_000
    // Fallback only: the Host route returns the configured windows.
    const DEFAULT_PEAK_WINDOWS = [[540, 720], [840, 1_080]]

    const EN = {
      'tier.peak': 'Peak',
      'tier.offPeak': 'Off-peak',
      'to.peak': 'to peak',
      'to.offPeak': 'to off-peak',
      'balance': 'Balance',
      'bonus': 'Bonus',
      'session.spend': 'Session',
      'loading': 'Loading',
      'signedOut': 'Signed out',
      'failed': 'Unavailable',
      'schedule': 'Peak: Mon–Fri 09:00–12:00, 14:00–18:00 (Beijing)',
      'holidayUnavailable': 'Holiday calendar unavailable',
      'updated': 'Updated',
      'unit.day': 'd',
      'session.requests': 'Billed requests',
      'session.cacheHit': 'Cache hit',
    }

    const ZH = {
      'tier.peak': '峰时价',
      'tier.offPeak': '谷时价',
      'to.peak': '转峰',
      'to.offPeak': '转谷',
      'balance': '余额',
      'bonus': '赠送',
      'session.spend': '本会话',
      'loading': '加载中',
      'signedOut': '未登录',
      'failed': '读取失败',
      'schedule': '峰时：工作日 09:00–12:00、14:00–18:00（北京时间）',
      'holidayUnavailable': '节假日数据不可用',
      'updated': '更新于',
      'unit.day': '天',
      'session.requests': '计费请求',
      'session.cacheHit': '缓存命中',
    }

    const CSS = `
.dsh-bpk-slot { flex: 1 1 100%; min-width: 0; display: flex; }
.dsh-bpk-card { width: 100%; min-width: 0; margin: 8px 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1.35; text-align: left; cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease; }
.dsh-bpk-card:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dsh-bpk-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-bpk-line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; }
.dsh-bpk-k { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-bpk-v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.dsh-bpk-meta { align-items: center; padding-top: 5px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-bpk-tier { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; white-space: nowrap; }
.dsh-bpk-trend { flex: none; display: block; color: var(--dsw-alias-state-success-primary); }
.dsh-bpk-trend.is-up { color: var(--dsw-alias-state-error-primary); }
.dsh-bpk-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dsh-bpk-card[aria-busy='true'] .dsh-bpk-v { opacity: .6; }
`.trim()

    const PluginContext = React.createContext({ locale: null, translate: (key) => key })

    function pad2(value) {
      return value < 10 ? `0${value}` : String(value)
    }

    function beijingDayStart(nowMs) {
      const shifted = nowMs + BEIJING_OFFSET_MS
      return Math.floor(shifted / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
    }

    function dayKey(date) {
      return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
    }

    /** Peak intervals around `nowMs`, ascending. Weekends and holidays are absent. */
    function peakIntervals(nowMs, windows, holidays, horizonDays) {
      const intervals = []
      const start = beijingDayStart(nowMs)
      for (let index = 0; index < horizonDays; index += 1) {
        const dayStart = start + index * DAY_MS
        const date = new Date(dayStart + BEIJING_OFFSET_MS)
        const weekday = date.getUTCDay()
        if (weekday === 0 || weekday === 6) continue
        if (holidays.has(dayKey(date))) continue
        for (const window of windows) {
          intervals.push([dayStart + window[0] * 60_000, dayStart + window[1] * 60_000])
        }
      }
      intervals.sort((a, b) => a[0] - b[0])
      return intervals
    }

    function priceState(nowMs, windows, holidays) {
      const intervals = peakIntervals(nowMs, windows, holidays, 21)
      for (const [start, end] of intervals) {
        if (nowMs >= start && nowMs < end) return { peak: true, until: end }
      }
      for (const [start] of intervals) {
        if (start > nowMs) return { peak: false, until: start }
      }
      return { peak: false, until: nowMs + DAY_MS }
    }

    function formatDuration(ms, t) {
      const total = Math.max(0, Math.floor(ms / 1_000))
      const days = Math.floor(total / 86_400)
      const hours = Math.floor((total % 86_400) / 3_600)
      const minutes = Math.floor((total % 3_600) / 60)
      const seconds = total % 60
      const clock = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
      return days > 0 ? `${days}${t('unit.day')} ${clock}` : clock
    }

    function formatCurrency(wallet, locale) {
      const value = Number(wallet?.balance)
      if (!Number.isFinite(value)) return String(wallet?.balance ?? '—')
      const currency = wallet.currency === 'USD' ? 'USD' : 'CNY'
      try {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(value)
      } catch {
        return `${currency === 'USD' ? '$' : '¥'}${value.toFixed(2)}`
      }
    }

    function formatCost(value, locale) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return formatCurrency({ currency: 'CNY', balance: '0' }, locale)
      const format = (amount, digits) => {
        try {
          return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: 'CNY',
            currencyDisplay: 'narrowSymbol',
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(amount)
        } catch {
          return `¥${amount.toFixed(digits)}`
        }
      }
      if (number < 0.0005) return `<${format(0.001, 3)}`
      return format(number, number < 1 ? 3 : 2)
    }

    function formatSwitchTime(ms, locale) {
      try {
        return new Intl.DateTimeFormat(locale, {
          timeZone: 'Asia/Shanghai',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(ms))
      } catch {
        return new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
      }
    }

    function formatClock(ms, locale) {
      try {
        return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
      } catch {
        return new Date(ms).toISOString().slice(11, 16)
      }
    }

    function positiveWallets(wallets) {
      if (!Array.isArray(wallets)) return []
      return wallets.filter((wallet) => wallet && typeof wallet.balance === 'string' && Number(wallet.balance) > 0)
    }

    function primaryWallet(wallets) {
      if (!Array.isArray(wallets)) return null
      const usable = wallets.filter((wallet) => wallet && typeof wallet.balance === 'string')
      return usable.find((wallet) => wallet.currency === 'CNY') ?? usable[0] ?? null
    }

    function noSessions() {
      return null
    }

    function currentSessionId(state) {
      if (!state || !state.byId) return null
      for (const row of Object.values(state.byId)) {
        if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id
      }
      return null
    }

    function useLocaleSnapshot() {
      const { locale } = React.useContext(PluginContext)
      const [snapshot, setSnapshot] = React.useState(() => locale.getSnapshot())
      React.useEffect(() => {
        setSnapshot(locale.getSnapshot())
        return locale.subscribe(() => setSnapshot(locale.getSnapshot()))
      }, [locale])
      return snapshot
    }

    function useT() {
      const { translate } = React.useContext(PluginContext)
      const snapshot = useLocaleSnapshot()
      const fallback = snapshot.active.startsWith('zh') ? ZH : EN
      return (key) => {
        const value = translate(key)
        return value === key ? (fallback[key] ?? key) : value
      }
    }

    function useSummary(locale, sessionId) {
      const [state, setState] = React.useState({ data: null, error: false })
      // Only the newest read may publish: a slower read for the previous
      // Session must not overwrite the current one.
      const generation = React.useRef(0)
      const load = React.useCallback(async () => {
        const request = ++generation.current
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        try {
          const offsetSeconds = -new Date().getTimezoneOffset() * 60
          const sessionParam = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''
          const url = `${ENDPOINT}?locale=${encodeURIComponent(locale)}&tz=${offsetSeconds}${sessionParam}`
          const response = await fetch(url, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (generation.current === request) setState({ data, error: false })
        } catch {
          if (generation.current === request) setState((previous) => ({ data: previous.data, error: true }))
        } finally {
          clearTimeout(timer)
        }
      }, [locale, sessionId])

      React.useEffect(() => {
        void load()
        const interval = window.setInterval(() => void load(), 60_000)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          generation.current += 1
          window.clearInterval(interval)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])

      return [state, load]
    }

    /** Stock-market mark: red rising triangle for peak, green falling triangle for off-peak. */
    function TrendMark({ peak }) {
      return h('svg', {
        className: `dsh-bpk-trend${peak ? ' is-up' : ' is-down'}`,
        viewBox: '0 0 12 12',
        width: 10,
        height: 10,
        'aria-hidden': true,
        focusable: 'false',
      }, h('path', {
        d: peak ? 'M6 1.6 10.7 9.4H1.3Z' : 'M6 10.4 1.3 2.6h9.4Z',
        fill: 'currentColor',
      }))
    }

    function BalanceCard(props) {
      const t = useT()
      const snapshot = useLocaleSnapshot()
      const locale = snapshot.active.startsWith('zh') ? 'zh-CN' : 'en-US'
      const wide = props?.wide !== false
      const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : noSessions
      const sessionId = useSessions(currentSessionId)
      const [now, setNow] = React.useState(() => Date.now())
      const [{ data, error }, reload] = useSummary(snapshot.active, sessionId)

      React.useEffect(() => {
        const interval = window.setInterval(() => setNow(Date.now()), 1_000)
        return () => window.clearInterval(interval)
      }, [])

      const pricing = data?.pricing ?? {}
      const windows = Array.isArray(pricing.peakWindows) && pricing.peakWindows.length > 0
        ? pricing.peakWindows
        : DEFAULT_PEAK_WINDOWS
      const holidays = React.useMemo(
        () => new Set(Array.isArray(pricing.holidays) ? pricing.holidays : []),
        [pricing.holidays],
      )
      const tier = React.useMemo(() => priceState(now, windows, holidays), [now, windows, holidays])

      if (!wide) return null

      const wallet = primaryWallet(data?.wallets)
      const bonus = positiveWallets(data?.bonusWallets)
      const spend = data?.session ?? null
      const hasSpend = spend !== null && spend.requests > 0 && Number.isFinite(Number(spend.cost))
      const costText = hasSpend ? formatCost(spend.cost, locale) : '—'

      let balanceText = t('loading')
      if (data !== null) {
        if (data.signedIn === false) balanceText = t('signedOut')
        else if (wallet !== null) balanceText = formatCurrency(wallet, locale)
        else balanceText = error || data.balanceError ? t('failed') : t('signedOut')
      } else if (error) {
        balanceText = t('failed')
      }

      const tierText = tier.peak ? t('tier.peak') : t('tier.offPeak')
      const switchLabel = tier.peak ? t('to.offPeak') : t('to.peak')
      const countdown = formatDuration(tier.until - now, t)

      const detailParts = []
      detailParts.push(`${t('balance')} ${data !== null && wallet !== null ? formatCurrency(wallet, locale) : balanceText}`)
      if (hasSpend) {
        const parts = [costText, `${spend.requests} ${t('session.requests').toLowerCase()}`]
        const hitBase = spend.inputTokens + spend.cacheReadTokens
        if (hitBase > 0) parts.push(`${t('session.cacheHit').toLowerCase()} ${Math.round((spend.cacheReadTokens / hitBase) * 100)}%`)
        detailParts.push(`${t('session.spend')} ${parts.join(' · ')}`)
      }
      detailParts.push(`${tierText} · ${switchLabel} ${formatSwitchTime(tier.until, locale)}`)
      detailParts.push(t('schedule'))
      if (pricing.calendar === 'unavailable') detailParts.push(t('holidayUnavailable'))
      if (bonus.length > 0) detailParts.push(`${t('bonus')} +${bonus.map((item) => formatCurrency(item, locale)).join(' ')}`)
      if (data?.fetchedAt) detailParts.push(`${t('updated')} ${formatClock(data.fetchedAt, locale)}`)

      const details = detailParts.join(' · ')

      return h('div', { className: 'dsh-bpk-slot' },
        h('style', { key: 'style' }, CSS),
        h('button', {
          type: 'button',
          className: 'dsh-bpk-card',
          onClick: () => void reload(),
          title: details,
          'aria-label': details,
          'aria-busy': data === null,
        },
          h('div', { className: 'dsh-bpk-line' },
            h('span', { className: 'dsh-bpk-k' }, t('balance')),
            h('span', { className: 'dsh-bpk-v' }, balanceText),
          ),
          h('div', { className: 'dsh-bpk-line' },
            h('span', { className: 'dsh-bpk-k' }, t('session.spend')),
            h('span', { className: 'dsh-bpk-v' }, costText),
          ),
          h('div', { className: 'dsh-bpk-line dsh-bpk-meta' },
            h('span', { className: 'dsh-bpk-tier' },
              h(TrendMark, { peak: tier.peak }),
              tierText,
            ),
            h('span', { className: 'dsh-bpk-count' }, `${switchLabel} ${countdown}`),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, 'en', EN))
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'deepseek-balance-peak',
          order: 0,
        }, function BalanceCardEntry(props) {
          return h(PluginContext.Provider, { value: { locale: ctx.locale, translate } },
            h(BalanceCard, props))
        }))
      },
    }
  },
})

/**
 * Selene Bet Tracker — Kalshi sync backend.
 *
 * A static site can't call Kalshi directly: requests must be RSA-PSS signed,
 * and browsers are blocked by Kalshi's CORS policy. This Cloud Function is the
 * thin proxy that solves both. It receives the user's Kalshi credentials in the
 * call payload (the key is stored locally in the user's browser and sent only
 * per-sync — never persisted here), signs the requests, calls Kalshi's REST
 * API, and returns settled bets, open positions, and resting (unfilled)
 * orders, all normalized into the tracker's bet shape — anything not yet
 * settled comes back tagged `result: 'pending'`.
 *
 * IMPORTANT: Kalshi field names can change between API versions. The
 * normalization in `settlementToBet` / `positionToBet` / `orderToBet` is
 * best-effort — verify against the current /portfolio/settlements,
 * /portfolio/positions, and /portfolio/orders responses and adjust as needed.
 *
 * ⚠️ TODO before a real/public launch: this function's Cloud Run service is
 * currently deployed with "Allow public access" (unauthenticated invocation)
 * because the static site has no sign-in to attach an IAM identity to. That
 * doesn't leak any secret (nothing is stored server-side), but it lets
 * anyone invoke it, not just this site. Add Firebase App Check before
 * switching the service back to "Require authentication." See KALSHI_SETUP.md.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const crypto = require('crypto')

// Production host. Use https://demo-api.kalshi.co for the sandbox.
const HOST = 'https://api.elections.kalshi.com'
const BASE = '/trade-api/v2'

/**
 * Kalshi signs: timestamp(ms) + HTTP method + request path (no query string),
 * using RSA-PSS over SHA-256 with salt length = digest length. Node's crypto
 * accepts Kalshi's PKCS#1 ("BEGIN RSA PRIVATE KEY") PEM directly.
 */
function sign(privateKeyPem, timestamp, method, path) {
  const msg = `${timestamp}${method}${path}`
  return crypto
    .sign('sha256', Buffer.from(msg), {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString('base64')
}

async function kalshiGet(pathWithQuery, keyId, privateKey) {
  const ts = Date.now().toString()
  const pathOnly = pathWithQuery.split('?')[0]
  const sig = sign(privateKey, ts, 'GET', BASE + pathOnly)
  const res = await fetch(HOST + BASE + pathWithQuery, {
    method: 'GET',
    headers: {
      'KALSHI-ACCESS-KEY': keyId,
      'KALSHI-ACCESS-SIGNATURE': sig,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Kalshi ${res.status} ${res.statusText} on ${pathOnly}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

// Walks a cursor-paginated Kalshi endpoint, calling onPage(data) for each page.
async function paginate(path, keyId, privateKey, onPage, extraQs = '') {
  let cursor = ''
  for (let page = 0; page < 25; page++) {
    const qs = `?limit=200${extraQs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const data = await kalshiGet(`${path}${qs}`, keyId, privateKey)
    await onPage(data)
    cursor = data.cursor
    if (!cursor) break
  }
}

/**
 * GetMarket — `/markets/{ticker}`. Originally documented as public (no auth),
 * but Kalshi may omit `result` on the public endpoint for settled/delisted
 * markets. We try unauthenticated first (fast, works for open markets), then
 * fall back to an authenticated request when the result is missing — the
 * signed request may return richer data including the settlement result.
 *
 * Cached per-ticker for the life of one sync call since the same market
 * appears across settlements, positions, and orders.
 */
async function getMarketInfo(ticker, marketCache, keyId, privateKey) {
  if (marketCache.has(ticker)) return marketCache.get(ticker)
  let market = null

  // 1. Public (unauthenticated) endpoint — works for open / recently settled markets.
  try {
    const res = await fetch(`${HOST}${BASE}/markets/${ticker}`)
    if (res.ok) {
      const data = await res.json()
      market = data.market || null
    }
  } catch { /* ignore */ }

  // 2. Authenticated fallback — for markets where the public endpoint returns
  //    null (delisted/expired) or returns data without a result field.
  //    The signed call may reveal settlement result for older markets.
  if (keyId && privateKey && (!market || market.result == null)) {
    try {
      const data = await kalshiGet(`/markets/${encodeURIComponent(ticker)}`, keyId, privateKey)
      const authMarket = data.market || null
      // Use authenticated result if it's better (has result, or public had nothing)
      if (authMarket && (authMarket.result != null || !market)) market = authMarket
    } catch { /* ignore — auth failure shouldn't block the sync */ }
  }

  marketCache.set(ticker, market)
  return market
}

// Builds a human-readable description from a GetMarket response, falling
// back to the raw ticker if the lookup failed (e.g. an expired/delisted market).
function describeMarket(market, ticker, side) {
  if (!market) return `${ticker} (${side})`
  const title = market.title || ticker
  const sub = side === 'YES' ? market.yes_sub_title : market.no_sub_title
  return sub ? `${title} — ${sub}` : `${title} (${side})`
}

// Decimal odds -> American odds integer.
function americanFromDecimal(dec) {
  if (!isFinite(dec) || dec <= 1) return 0
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1))
}

// Many Kalshi sports-market tickers embed the event date, e.g.
// KXWCCORNERS-26JUN25TUNNED-9 → 2026-06-25. Using this as the bet date
// instead of settled_time avoids UTC midnight shifts where a late-night
// game (June 25 ET) settles June 26 UTC and lands on the wrong calendar day.
const _MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 }
function parseDateFromTicker(ticker) {
  if (!ticker) return null
  const m = ticker.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{1,2})/)
  if (!m) return null
  const year = 2000 + parseInt(m[1], 10)
  const month = _MONTHS[m[2]]
  const day = parseInt(m[3], 10)
  if (!month || !day || day > 31) return null
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
}

/**
 * Map one Kalshi settlement to the tracker's bet shape.
 * Kalshi contracts settle at $1.00 (100¢); your average fill price in cents
 * is the implied probability, so decimal odds = 100 / avgPriceCents.
 *
 * Revenue / payout field pitfall: Kalshi's `revenue_dollars` is 0 for NO-side
 * wins AND for all losses — it only tracks YES-side payouts. So `revenue_dollars
 * = 0` is ambiguous: it could mean the bet lost OR that the user bet NO and won.
 * We resolve this by determining WHICH SIDE WON first, then computing the payout
 * from first principles (winning side × $1/contract). Signals tried in order:
 *   1. Settlement record's own result field (s.result / s.market_result / etc.)
 *   2. GetMarket response `result` field ('yes' | 'no')
 *   3. Market's last_price proxy (settled to ≤5¢ = NO won, ≥95¢ = YES won)
 *   4. revenue_dollars > 0 → YES won (reliable positive signal for YES side)
 *   5. Settlement-level price fields (final_price, settlement_price, etc.)
 *   6. YES-side bet + revenue_dollars = 0 → YES lost (safe for YES-only positions)
 *
 * Signal priority for determining winner:
 *   1. Settlement result field   (s.result / s.outcome / s.winner / etc.)
 *   2. GetMarket result field    (market.result / market.winner / etc.)
 *   3. Market price proxy        (last_price ≤5¢ = NO, ≥95¢ = YES)
 *   4a. Per-side revenue_dollars (no_revenue_dollars > 0 → NO won, yes_revenue_dollars > 0 → YES won)
 *   4b. revenue_dollars > 0      → YES won  (Kalshi only populates for YES payouts)
 *   4c. revenue_fp > 0           → YES won
 *   4d. Legacy revenue (cents) > 0 + side detection: for pure YES/NO positions, the only
 *       way the user's contracts pay out is if their side won. This is the primary fix for
 *       NO-side wins — the cents `revenue` field may be correct even when revenue_dollars=0.
 *   5. Settlement price fields   (0 = NO, 100 = YES)
 *   6. Pure YES bet + revenue_dollars = 0 → YES lost (revenue_dollars IS accurate for YES)
 *
 * NO-side bets with no determinable outcome are excluded and returned as
 * `_unknownRevenue` with both the raw settlement AND the raw market object so
 * the exact Kalshi field names can be diagnosed from the browser console.
 */
async function settlementToBet(s, marketCache, keyId, privateKey) {
  // ── Contract counts ────────────────────────────────────────────────────────
  let yesCount = parseFloat(s.yes_count_fp ?? s.yes_count ?? 0)
  let noCount = parseFloat(s.no_count_fp ?? s.no_count ?? 0)
  let contracts = yesCount + noCount

  // Fallback: signed unified count field (positive = YES long, negative = NO long)
  if (contracts <= 0) {
    const signed = parseFloat(s.count_fp ?? s.position_fp ?? s.net_count_fp ?? 0)
    if (signed > 0) { yesCount = signed; contracts = signed }
    else if (signed < 0) { noCount = Math.abs(signed); contracts = Math.abs(signed) }
  }

  // ── Cost ──────────────────────────────────────────────────────────────────
  const yesCostDollars = s.yes_total_cost_dollars != null
    ? parseFloat(s.yes_total_cost_dollars || 0)
    : (s.yes_total_cost || 0) / 100
  const noCostDollars = s.no_total_cost_dollars != null
    ? parseFloat(s.no_total_cost_dollars || 0)
    : (s.no_total_cost || 0) / 100
  let costDollars = yesCostDollars + noCostDollars

  // Fallback: unified cost field (some API versions don't split cost by side)
  if (costDollars <= 0) {
    costDollars = s.total_cost_dollars != null
      ? parseFloat(s.total_cost_dollars || 0)
      : s.cost_dollars != null
      ? parseFloat(s.cost_dollars || 0)
      : s.amount_dollars != null
      ? parseFloat(s.amount_dollars || 0)
      : s.total_cost != null
      ? parseFloat(s.total_cost || 0) / 100
      : s.cost != null
      ? parseFloat(s.cost || 0) / 100
      : 0
  }

  if (!s.ticker) return null
  // Kalshi returns settlement records for every market traded in a session,
  // including ones where the user had no position (both counts and cost are 0).
  // These are genuinely empty — not missing-data problems — so drop silently.
  if (contracts <= 0 && costDollars <= 0) return null
  // Partial data (one side zero): flag for diagnosis so missing fields are visible.
  if (contracts <= 0 || costDollars <= 0) {
    return { _unknownRevenue: true, _raw: s, _market: null, _reason: contracts <= 0 ? 'zero_contracts' : 'zero_cost' }
  }

  const side = yesCount >= noCount ? 'YES' : 'NO'
  const market = await getMarketInfo(s.ticker, marketCache, keyId, privateKey)

  // ── Determine which side won ──────────────────────────────────────────────
  let winner = null // 'yes' | 'no'
  let revenueDollarsFromApi = null

  // 1. Settlement record's own result/outcome field (try every known variant)
  const sResult = s.result ?? s.market_result ?? s.settlement_result
    ?? s.outcome ?? s.winner ?? s.winning_side ?? s.settled_result
    ?? s.resolution ?? null
  if (sResult === 'yes' || sResult === 1 || sResult === true) winner = 'yes'
  else if (sResult === 'no' || sResult === 0 || sResult === false) winner = 'no'

  // 2. GetMarket result/outcome field (try every known variant)
  if (!winner) {
    const mResult = market?.result ?? market?.market_result ?? market?.winner
      ?? market?.outcome ?? market?.settled_result ?? market?.resolution ?? null
    if (mResult === 'yes') winner = 'yes'
    else if (mResult === 'no') winner = 'no'
  }

  // 3. Market price proxy: settled markets converge to ≤5¢ (NO won) or ≥95¢ (YES won)
  if (!winner) {
    const lp = market?.last_price ?? market?.close_price ?? market?.settlement_price ?? null
    if (lp != null) {
      const p = parseFloat(lp)
      if (p >= 95) winner = 'yes'
      else if (p <= 5) winner = 'no'
    }
  }

  // 4. Revenue fields — checked in priority order with CORRECT per-side winner assignment.
  //
  //    Key insight: Kalshi's revenue_dollars is 0 for NO-side wins (API bug), but the
  //    legacy integer `revenue` field (in cents) may reflect the actual payout for BOTH
  //    sides. For a pure NO-side bet (yesCount = 0), revenue > 0 unambiguously means
  //    NO won (the user's contracts paid out). Same logic for pure YES bets.
  if (!winner) {
    // 4a. Per-side dollar revenue — correctly maps each side to its winner
    const noRevDollars = s.no_revenue_dollars != null ? parseFloat(s.no_revenue_dollars)
      : s.no_payout_dollars != null ? parseFloat(s.no_payout_dollars)
      : s.no_revenue_fp != null ? parseFloat(s.no_revenue_fp)
      : null
    const yesRevDollars = s.yes_revenue_dollars != null ? parseFloat(s.yes_revenue_dollars)
      : s.yes_payout_dollars != null ? parseFloat(s.yes_payout_dollars)
      : s.yes_revenue_fp != null ? parseFloat(s.yes_revenue_fp)
      : null
    if (noRevDollars != null && noRevDollars > 0) {
      winner = 'no'; revenueDollarsFromApi = noRevDollars
    } else if (yesRevDollars != null && yesRevDollars > 0) {
      winner = 'yes'; revenueDollarsFromApi = yesRevDollars
    }
  }

  if (!winner) {
    // 4b. Combined revenue_dollars: only reliable as a positive YES signal
    const rd = s.revenue_dollars != null ? parseFloat(s.revenue_dollars) : null
    if (rd != null && rd > 0) { winner = 'yes'; revenueDollarsFromApi = rd }
  }

  if (!winner) {
    // 4c. revenue_fp (fixed-point string, same semantic as revenue_dollars)
    const rf = s.revenue_fp != null ? parseFloat(s.revenue_fp) : null
    if (rf != null && rf > 0) { winner = 'yes'; revenueDollarsFromApi = rf }
  }

  if (!winner) {
    // 4d. Legacy `revenue` field in integer CENTS (the field that caused the 100× inflation
    //     bug before it was superseded by revenue_dollars). Kalshi may still populate it for
    //     BOTH YES and NO side settlements. For a PURE NO bet (yesCount = 0), revenue > 0
    //     can ONLY mean NO won (the user's NO contracts paid out). Same for pure YES bets.
    //     Mixed positions (rare): fall back to `side` heuristic.
    const revCents = s.revenue != null ? parseFloat(s.revenue) : null
    if (revCents != null && revCents > 0) {
      revenueDollarsFromApi = revCents / 100
      if (yesCount > 0 && noCount === 0) winner = 'yes'       // pure YES position → YES paid
      else if (noCount > 0 && yesCount === 0) winner = 'no'   // pure NO position  → NO paid
      else winner = side                                        // mixed: best guess
    }
  }

  // 5. Settlement-level price fields (0 = NO won, 100 = YES won; check ±5 for rounding).
  //    `value` is the canonical settlement price confirmed from Kalshi API output
  //    (value:0 = NO won, value:100 = YES won). Checked first as it's the most direct.
  if (!winner) {
    const sp = s.value ?? s.final_price ?? s.settlement_price ?? s.result_price ?? s.last_price ?? null
    if (sp != null) {
      const p = parseFloat(sp)
      if (p >= 95) winner = 'yes'
      else if (p <= 5) winner = 'no'
    }
  }

  // 6. YES-side bet + revenue_dollars = 0 → YES lost (safe only for pure YES positions:
  //    revenue_dollars IS accurate for YES wins, so 0 confirms the loss).
  //    NOT used for NO-side: Kalshi sets revenue_dollars = 0 for both NO wins AND NO losses.
  if (!winner && side === 'YES' && yesCount > 0 && noCount === 0) {
    const rd = s.revenue_dollars != null ? parseFloat(s.revenue_dollars) : null
    if (rd === 0) winner = 'no'
  }

  // Cannot determine outcome — exclude and surface both objects for diagnosis.
  if (!winner) return { _unknownRevenue: true, _raw: s, _market: market }

  // Payout = winning side's contract count × $1.00 per contract.
  // Use the API's actual revenue value when we captured it in steps 4a–4d (more precise).
  const revenueDollars = revenueDollarsFromApi ?? (winner === 'yes' ? yesCount : noCount)

  const pnlDollars = revenueDollars - costDollars
  const avgPriceCents = (costDollars * 100) / contracts
  const dec = 100 / avgPriceCents
  const american = americanFromDecimal(dec)

  // Prefer the date embedded in the ticker (e.g. 26JUN25 → 2026-06-25) over
  // settled_time to avoid UTC midnight shifts: a late-night game on June 25 ET
  // settles June 26 UTC, which would land the bet on the wrong calendar day.
  const betDate = parseDateFromTicker(s.ticker) || parseDateFromTicker(s.event_ticker)
    || String(s.settled_time || '').slice(0, 10)

  return {
    id: `kalshi-${s.ticker}-${s.settled_time}`,
    ticker: s.ticker,
    date: betDate,
    description: describeMarket(market, s.ticker, side),
    sportsbook: 'Kalshi',
    wager: +costDollars.toFixed(2),
    odds: (american > 0 ? '+' : '') + american,
    fmt: 'american',
    dec,
    result: pnlDollars > 0 ? 'won' : pnlDollars < 0 ? 'lost' : 'push',
    source: 'kalshi',
  }
}

/**
 * Map one still-open Kalshi position (not yet settled) to the tracker's bet
 * shape, tagged `result: 'pending'`. Per Kalshi's GetPositions schema,
 * `position_fp` is a signed fixed-point contract count as a numeric string
 * (positive = net long YES, negative = net long NO) and
 * `market_exposure_dollars` is the cost basis already in dollars (not
 * cents) as a numeric string.
 */
async function positionToBet(p, marketCache, keyId, privateKey) {
  const signedCount = parseFloat(p.position_fp || 0)
  const contracts = Math.abs(signedCount)
  const costDollars = Math.abs(parseFloat(p.market_exposure_dollars || 0))
  if (contracts <= 0 || costDollars <= 0) return null

  const side = signedCount >= 0 ? 'YES' : 'NO'
  const avgPriceCents = (costDollars * 100) / contracts // 1..99
  const dec = 100 / avgPriceCents
  const american = americanFromDecimal(dec)
  const market = await getMarketInfo(p.ticker, marketCache, keyId, privateKey)

  return {
    id: `kalshi-open-${p.ticker}`,
    ticker: p.ticker,
    date: String(p.last_updated_ts || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    description: describeMarket(market, p.ticker, side),
    sportsbook: 'Kalshi',
    wager: +costDollars.toFixed(2),
    odds: (american > 0 ? '+' : '') + american,
    fmt: 'american',
    dec,
    result: 'pending',
    source: 'kalshi',
  }
}

/**
 * Map one resting (placed, not yet filled) Kalshi order to the tracker's bet
 * shape, tagged `result: 'pending'`. Per Kalshi's GetOrders schema, prices
 * come back as dollar-string fields (`yes_price_dollars` / `no_price_dollars`)
 * and counts as fixed-point strings (`remaining_count_fp`) — only the
 * *remaining* (unfilled) part of the order is still "at risk." Only
 * `status=resting` orders are fetched: canceled orders have no money at
 * risk, and filled orders already show up via /portfolio/positions.
 */
async function orderToBet(o, marketCache, keyId, privateKey) {
  const contracts = parseFloat(o.remaining_count_fp || 0)
  if (contracts <= 0) return null
  const side = o.side === 'no' ? 'NO' : 'YES'
  const priceDollars = parseFloat((side === 'NO' ? o.no_price_dollars : o.yes_price_dollars) || 0)
  const costDollars = contracts * priceDollars
  if (costDollars <= 0) return null

  const avgPriceCents = priceDollars * 100 // 1..99
  const dec = 100 / avgPriceCents
  const american = americanFromDecimal(dec)
  const market = await getMarketInfo(o.ticker, marketCache, keyId, privateKey)

  return {
    id: `kalshi-order-${o.order_id}`,
    ticker: o.ticker,
    date: String(o.created_time || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    description: describeMarket(market, o.ticker, side),
    sportsbook: 'Kalshi',
    wager: +costDollars.toFixed(2),
    odds: (american > 0 ? '+' : '') + american,
    fmt: 'american',
    dec,
    result: 'pending',
    source: 'kalshi',
  }
}

/**
 * Read a dollar amount that Kalshi may expose either as a fixed-point dollar
 * string (`*_dollars`) or a legacy integer-cents field (`*_cents` / bare). The
 * dollar fields are exact; the cent fields truncate sub-cent values. Prefer
 * dollars, fall back to cents/100.
 */
function readDollars(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] == null) continue
    if (k.endsWith('_dollars')) return parseFloat(obj[k]) || 0
    return (parseFloat(obj[k]) || 0) / 100 // *_cents or legacy cents
  }
  return 0
}

/**
 * Map one Kalshi deposit or withdrawal to a transfer record for the tracker's
 * ledger. `kind` is 'deposit' | 'withdrawal'. Field names are best-effort
 * (Kalshi docs gate scraping) — we read the most likely names with fallbacks,
 * and the sync also returns one raw object so exact names can be confirmed.
 */
function transferRecord(t, kind) {
  const amount = readDollars(t, 'amount_dollars', 'amount_cents', 'amount')
  const fee = readDollars(t, 'fee_dollars', 'fee_cents', 'fee')
  const ts = t.created_ts || t.created_time || t.finalized_ts || t.updated_ts || ''
  return {
    id: `kalshi-${kind}-${t.deposit_id || t.withdrawal_id || t.transfer_id || t.id || ts}`,
    kind,
    date: String(ts).slice(0, 10),
    amount: +amount.toFixed(2),
    fee: +fee.toFixed(2),
    status: t.status || '',
    type: t.type || t.payment_method || '',
  }
}

/**
 * Callable function. From the app:
 *   const sync = httpsCallable(getFunctions(), 'syncKalshi')
 *   const { data } = await sync({ keyId, privateKey })  // -> { bets, count }
 *
 * The credentials are used only to sign this request's calls and are never
 * stored server-side.
 */
exports.syncKalshi = onCall({ cors: true }, async (request) => {
  // Trim so stray whitespace/newlines from pasting don't end up in the
  // KALSHI-ACCESS-KEY header — Kalshi looks up the key verbatim and a trailing
  // space makes it report authentication_error / NOT_FOUND on a valid key.
  const keyId = (request.data?.keyId || '').trim()
  const privateKey = (request.data?.privateKey || '').trim()
  if (!keyId || !privateKey) {
    throw new HttpsError('invalid-argument', 'Missing Kalshi Key ID or private key.')
  }

  const bets = []
  const transfers = []
  let balance = null
  // Raw samples returned for diagnostics; remove once field names are confirmed.
  let rawFirstSettlement = null
  // First settlement where outcome could not be determined — includes the raw
  // settlement object AND GetMarket response so missing field names are visible.
  let rawZeroRevenueSample = null
  // First NO-side settlement (regardless of outcome) — shows what Kalshi
  // returns for settlements where the user held NO contracts, so we can
  // compare a known NO win/loss against the settlement fields.
  let rawFirstNoSideSettlement = null
  let unknownCount = 0
  // Capture a few raw settlements for JUN25-ticker markets so we can see
  // what fields Kalshi returns for that specific game date in the console.
  const rawJun25Samples = []
  let rawBalance = null
  let rawFirstDeposit = null
  let rawFirstWithdrawal = null
  // Caches GetMarket lookups by ticker for the life of this sync call, since
  // the same market often appears across settlements/positions/orders.
  const marketCache = new Map()
  try {
    await paginate('/portfolio/settlements', keyId, privateKey, async (data) => {
      for (const s of data.settlements || []) {
        if (!rawFirstSettlement) rawFirstSettlement = s
        // Capture first NO-side settlement for field-level diagnosis regardless
        // of whether it resolved — compares resolved vs unresolved NO records.
        const noCount = parseFloat(s.no_count_fp ?? s.no_count ?? 0)
        const yesCount = parseFloat(s.yes_count_fp ?? s.yes_count ?? 0)
        if (!rawFirstNoSideSettlement && noCount > yesCount) rawFirstNoSideSettlement = s
        // Capture raw data for JUN25-ticker settlements so the console reveals
        // what market_result / value / revenue fields look like for that game date.
        if (rawJun25Samples.length < 5 && s.ticker && s.ticker.includes('JUN25')) {
          rawJun25Samples.push(s)
        }

        const result = await settlementToBet(s, marketCache, keyId, privateKey)
        // settlementToBet returns { _unknownRevenue, _raw, _market } when the
        // outcome cannot be determined — capture a sample and skip the bet.
        if (result?._unknownRevenue) {
          unknownCount++
          if (!rawZeroRevenueSample) rawZeroRevenueSample = { settlement: result._raw, market: result._market, reason: result._reason }
        } else if (result) {
          bets.push(result)
        }
      }
    })
    // Open (not yet settled) positions, so a filled bet shows up as
    // "pending" immediately instead of waiting for the market to resolve.
    // count_filter=position restricts results to markets with a non-zero
    // position (otherwise Kalshi returns every market ever traded).
    await paginate('/portfolio/positions', keyId, privateKey, async (data) => {
      for (const p of data.market_positions || []) {
        const bet = await positionToBet(p, marketCache, keyId, privateKey)
        if (bet) bets.push(bet)
      }
    }, '&count_filter=position')
    // Resting (placed but not yet filled) orders — money at risk that
    // hasn't become a position yet, so it wouldn't show up above either.
    await paginate('/portfolio/orders', keyId, privateKey, async (data) => {
      for (const o of data.orders || []) {
        const bet = await orderToBet(o, marketCache, keyId, privateKey)
        if (bet) bets.push(bet)
      }
    }, '&status=resting')
  } catch (err) {
    throw new HttpsError('internal', err.message)
  }

  // Account info (balance + cash flow) is a best-effort add-on: each call runs
  // in its own try so a failure (e.g. a key without these permissions, or a
  // renamed endpoint) is reported but never blocks the core bet sync above.
  const accountErrors = []
  try {
    // Cash available + total portfolio value (cash + market value of open
    // positions); the at-risk amount is the difference.
    const bal = await kalshiGet('/portfolio/balance', keyId, privateKey)
    rawBalance = bal
    const cash = readDollars(bal, 'balance_dollars', 'balance')
    const portfolioValue = readDollars(bal, 'portfolio_value_dollars', 'portfolio_value') || cash
    balance = {
      cash,
      portfolioValue,
      atRisk: +Math.max(0, portfolioValue - cash).toFixed(2),
    }
  } catch (err) {
    accountErrors.push(`balance: ${err.message}`)
  }
  try {
    await paginate('/portfolio/deposits', keyId, privateKey, async (data) => {
      for (const d of data.deposits || []) {
        if (!rawFirstDeposit) rawFirstDeposit = d
        transfers.push(transferRecord(d, 'deposit'))
      }
    })
  } catch (err) {
    accountErrors.push(`deposits: ${err.message}`)
  }
  try {
    await paginate('/portfolio/withdrawals', keyId, privateKey, async (data) => {
      for (const w of data.withdrawals || []) {
        if (!rawFirstWithdrawal) rawFirstWithdrawal = w
        transfers.push(transferRecord(w, 'withdrawal'))
      }
    })
  } catch (err) {
    accountErrors.push(`withdrawals: ${err.message}`)
  }

  return {
    bets,
    count: bets.length,
    unknownCount,
    balance,
    transfers,
    accountErrors,
    syncedAt: new Date().toISOString(),
    _rawFirstSettlement: rawFirstSettlement,
    _rawFirstNoSideSettlement: rawFirstNoSideSettlement,
    _rawZeroRevenueSample: rawZeroRevenueSample,
    _rawJun25Samples: rawJun25Samples,
    _rawBalance: rawBalance,
    _rawFirstDeposit: rawFirstDeposit,
    _rawFirstWithdrawal: rawFirstWithdrawal,
  }
})

/* ════════════════════════════════════════════════════════════════════════
 * SharpSports (BetSync) sync — traditional sportsbooks via account linking.
 *
 * Unlike Kalshi (where each user supplies their own key), SharpSports is a
 * B2B account-linking provider: YOU (the developer) hold the app's API key(s)
 * and your users link their books through SharpSports' hosted Booklink UI.
 * Per SharpSports' QuickStart, the PUBLIC key both creates linking contexts
 * AND reads BetSync data (bettors / accounts / betSlips); in the free SANDBOX
 * it's the only key issued (a Private key appears on a paid/live plan). So the
 * Public key is required and the Private key is optional (preferred for live).
 * Both live here as Firebase secrets and never reach the browser:
 *
 *   firebase functions:secrets:set SHARPSPORTS_PUBLIC_KEY     # required
 *   firebase functions:secrets:set SHARPSPORTS_PRIVATE_KEY    # optional (live)
 *
 * The dashboard defaults to the SANDBOX environment, where the test bettor
 * "gooduser" / "Test1" has accounts on every book with representative bet
 * history — no real money, no real credentials. See SHARPSPORTS_SETUP.md.
 *
 * Two callables:
 *   • sharpSportsContext({ internalId, redirectUrl? })
 *       Public key → POST /v1/context → returns a context id (cid) and the
 *       Booklink URL the browser opens so the user can link a book.
 *   • syncSharpSports({ internalId | bettorId })
 *       App key (Public in sandbox, Private if you have one) → resolves the
 *       bettor, lists their linked accounts (to label each bet with its
 *       sportsbook), pulls /v1/betSlips, and returns them normalized into the
 *       tracker's bet shape.
 *
 * ⚠️ Field mapping is best-effort (same caveat as the Kalshi mapper). In
 * particular SharpSports returns money amounts as integer CENTS — if your
 * first sandbox sync shows dollar figures 100× off, flip SS_AMOUNT_DIVISOR.
 * ════════════════════════════════════════════════════════════════════════ */

const SHARPSPORTS_PUBLIC_KEY = defineSecret('SHARPSPORTS_PUBLIC_KEY')

const SS_HOST = 'https://api.sharpsports.io'
const SS_API = '/v1'
const SS_UI = 'https://ui.sharpsports.io'
// SharpSports money fields (atRisk / toWin / payout) are integer cents.
// Flip to 1 if a sandbox sync shows amounts 100× too large.
const SS_AMOUNT_DIVISOR = 100

// Authenticated GET against the SharpSports REST API. `token` is the public
// key for linking/discovery calls and the private key for bet data.
async function ssGet(path, token) {
  const res = await fetch(`${SS_HOST}${SS_API}${path}`, {
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`SharpSports ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

// SharpSports list endpoints sometimes return a bare array and sometimes an
// envelope ({ results: [...] } / { data: [...] }). Normalize to an array.
function ssList(resp) {
  if (Array.isArray(resp)) return resp
  return resp?.results || resp?.data || resp?.betSlips || resp?.bettors || []
}

// Decimal odds from a slip's risk/return, used only when SharpSports doesn't
// hand us explicit odds. atRisk + toWin = total return, so the ratio is
// unit-independent (cents vs dollars cancels out).
function decFromRisk(atRisk, toWin) {
  const stake = Number(atRisk)
  const profit = Number(toWin)
  if (!(stake > 0) || !(profit >= 0)) return null
  return (stake + profit) / stake
}

// Human-readable description for a slip: a single bet's book description, or
// an "N-leg parlay" label when the slip has multiple legs.
function describeSlip(s) {
  const bets = Array.isArray(s.bets) ? s.bets : []
  if (bets.length > 1) return `${bets.length}-leg parlay`
  const b = bets[0] || {}
  if (b.bookDescription) return b.bookDescription
  if (b.proposition) return b.proposition
  const ev = b.event || {}
  const sel = b.marketSelection || {}
  const team = sel.displayName || sel.team || sel.position
  if (team && ev.league) return `${team} — ${ev.league}`
  return s.bookDescription || team || 'Bet'
}

// Map one SharpSports status to the tracker's result vocabulary.
function ssResult(status) {
  const v = String(status || '').toLowerCase()
  if (v === 'won' || v === 'win' || v.includes('won')) return 'won'
  if (v === 'lost' || v === 'loss' || v.includes('lost')) return 'lost'
  if (v === 'push' || v === 'canceled' || v === 'cancelled' || v.includes('refund') || v === 'void') return 'push'
  return 'pending' // pending / live / unsettled / unknown
}

/**
 * Normalize one SharpSports BetSlip into the tracker's bet shape. Odds are
 * taken from the slip's explicit fields when present, else derived from the
 * risk/return ratio. `wager`/`toWin` are converted from cents to dollars.
 */
function betSlipToBet(s, bookByAccount) {
  const wager = Number(s.atRisk) / SS_AMOUNT_DIVISOR
  const toWin = Number(s.toWin) / SS_AMOUNT_DIVISOR
  if (!(wager > 0)) return null

  const decExplicit = Number(s.oddsDecimal) > 1 ? Number(s.oddsDecimal) : null
  const dec = decExplicit || decFromRisk(s.atRisk, s.toWin) || null
  const american = Number.isFinite(Number(s.oddsAmerican)) && Number(s.oddsAmerican) !== 0
    ? Math.round(Number(s.oddsAmerican))
    : (dec ? americanFromDecimal(dec) : 0)

  const sportsbook =
    s.book?.name || s.book?.abbr || bookByAccount[s.bettorAccountId] || 'Sportsbook'

  return {
    id: `ss-${s.id}`,
    slipId: s.id,
    placedAt: s.placedAt || s.timePlaced || s.gradedAt || null,
    description: describeSlip(s),
    sportsbook,
    wager: +wager.toFixed(2),
    toWin: +toWin.toFixed(2),
    odds: (american > 0 ? '+' : '') + american,
    fmt: 'american',
    dec: dec || (american >= 100 ? american / 100 + 1 : american <= -100 ? 100 / Math.abs(american) + 1 : 1),
    result: ssResult(s.status),
    type: s.type || (Array.isArray(s.bets) && s.bets.length > 1 ? 'parlay' : 'single'),
    source: 'sharpsports',
  }
}

/**
 * Create a betSync context and return the Booklink URL the browser should
 * open. Uses the PUBLIC key. `internalId` ties the SharpSports bettor to your
 * own user record so a later sync can find them again.
 */
exports.sharpSportsContext = onCall(
  { cors: true, secrets: [SHARPSPORTS_PUBLIC_KEY] },
  async (request) => {
    const publicKey = SHARPSPORTS_PUBLIC_KEY.value() || process.env.SHARPSPORTS_PUBLIC_KEY
    if (!publicKey) {
      throw new HttpsError('failed-precondition', 'SHARPSPORTS_PUBLIC_KEY is not set. See SHARPSPORTS_SETUP.md.')
    }
    const internalId = request.data?.internalId
    if (!internalId) throw new HttpsError('invalid-argument', 'Missing internalId.')
    const redirectUrl = request.data?.redirectUrl

    const res = await fetch(`${SS_HOST}${SS_API}/context`, {
      method: 'POST',
      headers: { Authorization: `Token ${publicKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ internalId }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new HttpsError('internal', `SharpSports context ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = await res.json()
    const cid = data.cid || data.id
    if (!cid) throw new HttpsError('internal', 'SharpSports did not return a context id.')
    const linkUrl = `${SS_UI}/link/${cid}` + (redirectUrl ? `?redirectUrl=${encodeURIComponent(redirectUrl)}` : '')
    return { cid, linkUrl, internalId }
  }
)

/**
 * Pull a bettor's BetSlips and return them normalized. Uses the PRIVATE key.
 * Pass `bettorId` directly (e.g. the sandbox test bettor from the dashboard)
 * or `internalId` to resolve the bettor created during linking.
 */
exports.syncSharpSports = onCall(
  { cors: true, secrets: [SHARPSPORTS_PUBLIC_KEY] },
  async (request) => {
    // The Public key reads BetSync data (and is the only key in sandbox);
    // prefer a Private key only if you actually have one (live/paid).
    const apiKey =
      process.env.SHARPSPORTS_PRIVATE_KEY ||
      SHARPSPORTS_PUBLIC_KEY.value() || process.env.SHARPSPORTS_PUBLIC_KEY
    if (!apiKey) {
      throw new HttpsError('failed-precondition', 'Set SHARPSPORTS_PUBLIC_KEY (sandbox) or SHARPSPORTS_PRIVATE_KEY (live). See SHARPSPORTS_SETUP.md.')
    }
    let bettorId = request.data?.bettorId
    const internalId = request.data?.internalId

    try {
      // Resolve the bettor from internalId if an explicit id wasn't supplied.
      if (!bettorId) {
        if (!internalId) throw new HttpsError('invalid-argument', 'Provide a bettorId or internalId.')
        const bettors = ssList(await ssGet(`/bettors?internalId=${encodeURIComponent(internalId)}`, apiKey))
        const match = bettors.find(b => b.internalId === internalId) || (bettors.length === 1 ? bettors[0] : null)
        if (!match) {
          throw new HttpsError('failed-precondition', 'No linked bettor found for that internalId yet — link a sportsbook first.')
        }
        bettorId = match.id
      }

      // Map each linked account id → sportsbook name so every bet is labeled.
      const accounts = ssList(await ssGet(`/bettorAccounts?bettorId=${encodeURIComponent(bettorId)}`, apiKey))
      const bookByAccount = {}
      for (const a of accounts) bookByAccount[a.id] = a.book?.name || a.book?.abbr || 'Sportsbook'

      // Pull the bettor's bet slips and normalize.
      const slips = ssList(await ssGet(`/betSlips?bettorId=${encodeURIComponent(bettorId)}&limit=500`, apiKey))
      const bets = slips.map(s => betSlipToBet(s, bookByAccount)).filter(Boolean)

      return { bets, count: bets.length, bettorId, accounts: accounts.length, syncedAt: new Date().toISOString() }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      throw new HttpsError('internal', err.message)
    }
  }
)

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
    throw new Error(`Kalshi ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
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
 * GetMarket — `/markets/{ticker}` — is public market data (no signing, no
 * API key) per Kalshi's docs. Used only to turn a raw ticker like
 * `KXWCGAME-26JUN16FRASEN-FRA` into a human-readable description instead of
 * showing the ticker itself. Cached per-ticker for the life of one sync call
 * since the same market often shows up across settlements/positions/orders.
 */
async function getMarketInfo(ticker, marketCache) {
  if (marketCache.has(ticker)) return marketCache.get(ticker)
  let market = null
  try {
    const res = await fetch(`${HOST}${BASE}/markets/${ticker}`)
    if (res.ok) {
      const data = await res.json()
      market = data.market || null
    }
  } catch {
    market = null
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

/**
 * Map one Kalshi settlement to the tracker's bet shape.
 * Kalshi contracts settle at $1.00 (100¢); your average fill price in cents
 * is the implied probability, so decimal odds = 100 / avgPriceCents.
 *
 * Kalshi migrated portfolio responses to fixed-point / dollar fields
 * (`yes_count_fp`, `yes_total_cost_dollars`, `revenue_dollars`) and the legacy
 * cent-integer fields (`yes_count`, `yes_total_cost`, `revenue`) get truncated
 * or dropped on fractional-enabled markets — which made every settled bet map
 * to null here. We read the new fields first and fall back to the old ones.
 */
async function settlementToBet(s, marketCache) {
  const yesCount = parseFloat(s.yes_count_fp ?? s.yes_count ?? 0)
  const noCount = parseFloat(s.no_count_fp ?? s.no_count ?? 0)
  const contracts = yesCount + noCount

  // Cost basis in dollars: prefer the *_dollars fields, else convert legacy cents.
  const costDollars =
    s.yes_total_cost_dollars != null || s.no_total_cost_dollars != null
      ? parseFloat(s.yes_total_cost_dollars || 0) + parseFloat(s.no_total_cost_dollars || 0)
      : ((s.yes_total_cost || 0) + (s.no_total_cost || 0)) / 100
  if (contracts <= 0 || costDollars <= 0) return null

  // Payout in dollars: prefer revenue_dollars, else convert legacy cents.
  const revenueDollars = s.revenue_dollars != null ? parseFloat(s.revenue_dollars) : (s.revenue || 0) / 100
  const pnlDollars = revenueDollars - costDollars
  const avgPriceCents = (costDollars * 100) / contracts // 1..99
  const dec = 100 / avgPriceCents
  const american = americanFromDecimal(dec)
  const side = yesCount >= noCount ? 'YES' : 'NO'
  const market = await getMarketInfo(s.ticker, marketCache)

  return {
    id: `kalshi-${s.ticker}-${s.settled_time}`,
    ticker: s.ticker,
    date: String(s.settled_time || '').slice(0, 10),
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
async function positionToBet(p, marketCache) {
  const signedCount = parseFloat(p.position_fp || 0)
  const contracts = Math.abs(signedCount)
  const costDollars = Math.abs(parseFloat(p.market_exposure_dollars || 0))
  if (contracts <= 0 || costDollars <= 0) return null

  const side = signedCount >= 0 ? 'YES' : 'NO'
  const avgPriceCents = (costDollars * 100) / contracts // 1..99
  const dec = 100 / avgPriceCents
  const american = americanFromDecimal(dec)
  const market = await getMarketInfo(p.ticker, marketCache)

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
async function orderToBet(o, marketCache) {
  const contracts = parseFloat(o.remaining_count_fp || 0)
  if (contracts <= 0) return null
  const side = o.side === 'no' ? 'NO' : 'YES'
  const priceDollars = parseFloat((side === 'NO' ? o.no_price_dollars : o.yes_price_dollars) || 0)
  const costDollars = contracts * priceDollars
  if (costDollars <= 0) return null

  const avgPriceCents = priceDollars * 100 // 1..99
  const dec = 100 / avgPriceCents
  const american = americanFromDecimal(dec)
  const market = await getMarketInfo(o.ticker, marketCache)

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
 * Callable function. From the app:
 *   const sync = httpsCallable(getFunctions(), 'syncKalshi')
 *   const { data } = await sync({ keyId, privateKey })  // -> { bets, count }
 *
 * The credentials are used only to sign this request's calls and are never
 * stored server-side.
 */
exports.syncKalshi = onCall({ cors: true }, async (request) => {
  const keyId = request.data?.keyId
  const privateKey = request.data?.privateKey
  if (!keyId || !privateKey) {
    throw new HttpsError('invalid-argument', 'Missing Kalshi Key ID or private key.')
  }

  const bets = []
  // Caches GetMarket lookups by ticker for the life of this sync call, since
  // the same market often appears across settlements/positions/orders.
  const marketCache = new Map()
  try {
    await paginate('/portfolio/settlements', keyId, privateKey, async (data) => {
      for (const s of data.settlements || []) {
        const bet = await settlementToBet(s, marketCache)
        if (bet) bets.push(bet)
      }
    })
    // Open (not yet settled) positions, so a filled bet shows up as
    // "pending" immediately instead of waiting for the market to resolve.
    // count_filter=position restricts results to markets with a non-zero
    // position (otherwise Kalshi returns every market ever traded).
    await paginate('/portfolio/positions', keyId, privateKey, async (data) => {
      for (const p of data.market_positions || []) {
        const bet = await positionToBet(p, marketCache)
        if (bet) bets.push(bet)
      }
    }, '&count_filter=position')
    // Resting (placed but not yet filled) orders — money at risk that
    // hasn't become a position yet, so it wouldn't show up above either.
    await paginate('/portfolio/orders', keyId, privateKey, async (data) => {
      for (const o of data.orders || []) {
        const bet = await orderToBet(o, marketCache)
        if (bet) bets.push(bet)
      }
    }, '&status=resting')
  } catch (err) {
    throw new HttpsError('internal', err.message)
  }

  return {
    bets,
    count: bets.length,
    syncedAt: new Date().toISOString(),
  }
})

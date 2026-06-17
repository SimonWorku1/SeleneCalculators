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

/**
 * Selene Bet Tracker — Kalshi sync backend.
 *
 * A static site can't call Kalshi directly: requests must be RSA-PSS signed,
 * and browsers are blocked by Kalshi's CORS policy. This Cloud Function is the
 * thin proxy that solves both. It receives the user's Kalshi credentials in the
 * call payload (the key is stored locally in the user's browser and sent only
 * per-sync — never persisted here), signs the requests, calls Kalshi's REST
 * API, and returns settled positions normalized into the tracker's bet shape.
 *
 * IMPORTANT: Kalshi field names can change between API versions. The
 * normalization in `settlementToBet` is best-effort — verify against the
 * current /portfolio/settlements response and adjust as needed.
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

// Decimal odds -> American odds integer.
function americanFromDecimal(dec) {
  if (!isFinite(dec) || dec <= 1) return 0
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1))
}

/**
 * Map one Kalshi settlement to the tracker's bet shape.
 * Kalshi contracts settle at $1.00 (100¢); your average fill price in cents
 * is the implied probability, so decimal odds = 100 / avgPriceCents.
 */
function settlementToBet(s) {
  const yesCount = s.yes_count || 0
  const noCount = s.no_count || 0
  const contracts = yesCount + noCount
  const costCents = (s.yes_total_cost || 0) + (s.no_total_cost || 0)
  if (contracts <= 0 || costCents <= 0) return null

  const revenueCents = s.revenue || 0
  const pnlCents = revenueCents - costCents
  const avgPriceCents = costCents / contracts // 1..99
  const dec = 100 / avgPriceCents
  const american = americanFromDecimal(dec)
  const side = yesCount >= noCount ? 'YES' : 'NO'

  return {
    id: `kalshi-${s.ticker}-${s.settled_time}`,
    date: String(s.settled_time || '').slice(0, 10),
    description: `${s.ticker} (${side})`,
    sportsbook: 'Kalshi',
    wager: +(costCents / 100).toFixed(2),
    odds: (american > 0 ? '+' : '') + american,
    fmt: 'american',
    dec,
    result: pnlCents > 0 ? 'won' : pnlCents < 0 ? 'lost' : 'push',
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
  let cursor = ''
  try {
    for (let page = 0; page < 25; page++) {
      const qs = `?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const data = await kalshiGet(`/portfolio/settlements${qs}`, keyId, privateKey)
      for (const s of data.settlements || []) {
        const bet = settlementToBet(s)
        if (bet) bets.push(bet)
      }
      cursor = data.cursor
      if (!cursor) break
    }
  } catch (err) {
    throw new HttpsError('internal', err.message)
  }

  return { bets, count: bets.length, syncedAt: new Date().toISOString() }
})

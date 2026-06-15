/**
 * Selene Bet Tracker — Kalshi sync backend (scaffold)
 *
 * This Cloud Function is the small server-side piece that a static site
 * cannot provide on its own: it holds the Kalshi API credentials, performs
 * the required RSA-PSS request signing, calls Kalshi's REST API, and returns
 * the user's settled positions normalized into the tracker's bet shape.
 *
 * The tracker UI is NOT wired to this yet (it still uses localStorage). See
 * KALSHI_SETUP.md for how to deploy this and, later, call it from the app.
 *
 * IMPORTANT: Kalshi field names can change between API versions. The
 * normalization in `settlementToBet` is best-effort — verify against the
 * current /portfolio/settlements response and adjust as needed.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const crypto = require('crypto')

// const admin = require('firebase-admin')
// admin.initializeApp() // uncomment when you start writing bets to Firestore

// Secrets — set with:
//   firebase functions:secrets:set KALSHI_KEY_ID
//   firebase functions:secrets:set KALSHI_PRIVATE_KEY
const KALSHI_KEY_ID = defineSecret('KALSHI_KEY_ID')
const KALSHI_PRIVATE_KEY = defineSecret('KALSHI_PRIVATE_KEY')

// Production host. Use https://demo-api.kalshi.co for the sandbox.
const HOST = 'https://api.elections.kalshi.com'
const BASE = '/trade-api/v2'

/**
 * Kalshi signs: timestamp(ms) + HTTP method + request path (no query string),
 * using RSA-PSS over SHA-256 with salt length = digest length.
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
  }
}

/**
 * Callable function. From the app (once wired):
 *   import { getFunctions, httpsCallable } from 'firebase/functions'
 *   const sync = httpsCallable(getFunctions(), 'syncKalshi')
 *   const { data } = await sync()  // -> { bets, count }
 */
exports.syncKalshi = onCall(
  { secrets: [KALSHI_KEY_ID, KALSHI_PRIVATE_KEY], cors: true },
  async (request) => {
    // Require a signed-in user once you add Firebase Auth:
    // if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.')

    const keyId = KALSHI_KEY_ID.value()
    const privateKey = KALSHI_PRIVATE_KEY.value()
    if (!keyId || !privateKey) {
      throw new HttpsError('failed-precondition', 'Kalshi secrets are not configured.')
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

    // TODO (when wiring storage): persist to Firestore instead of returning,
    // e.g. users/{request.auth.uid}/bets/{bet.id}, then have the app subscribe.

    return { bets, count: bets.length, syncedAt: new Date().toISOString() }
  }
)

# Kalshi Sync — Setup

The Bet Tracker can pull your settled Kalshi positions onto the calendar and
chart. A static site (GitHub Pages) can't call Kalshi directly: every request
must be **RSA-signed**, and browsers are blocked by Kalshi's CORS policy. The
Cloud Function in [`functions/`](functions/) is a thin proxy that solves both.

**How the key is handled:** you paste your Kalshi key into the tracker's
**Connect Kalshi** card. It's stored only in your browser (`localStorage`) and
sent to the Cloud Function **only when you click Sync**, to sign that request.
The function does **not** store it.

> The tracker UI (key input, tutorial, tabs, Sync button) already works. To make
> Sync actually fetch data, deploy the Cloud Function once with the steps below.

> ⚠️ **Currently deployed with public (unauthenticated) invocation enabled** —
> see "Public access" under Notes & caveats below. **Do this before any real
> launch:** lock it down with Firebase App Check (and/or rate limiting) before
> switching the Cloud Run service back to "Require authentication."

---

## A. Get your Kalshi API key (end-user step)

This is also shown in-app under **Connect Kalshi → "How do I get my Kalshi API key?"**

1. Log in to Kalshi in a browser and open **Profile Settings** (`kalshi.com/account/profile`).
2. Scroll to **API Keys** → **Create New API Key**.
3. Copy the **Key ID** and the one-time **Private Key** (`-----BEGIN RSA PRIVATE KEY-----`).
   Kalshi will not show the private key again.
4. Paste both into the tracker's **Connect Kalshi** card and click **Save key**.

---

## B. Deploy the sync proxy (one-time, developer step)

Needed once so the **Sync Kalshi bets** button can fetch data.

### 1. Install the Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

### 2. Confirm the project

[`.firebaserc`](.firebaserc) is set to `selenecalculators`. To target a different
project, edit it or run `firebase use --add`.

### 3. Enable the Blaze plan (required)

Cloud Functions can only make outbound calls to a non-Google service (Kalshi) on
the pay-as-you-go **Blaze** plan; the free Spark plan blocks that egress. Blaze
has a large free tier — personal use is typically ~$0. Set a budget alert for
peace of mind. Firebase console: **⚙ → Usage and billing → Modify plan → Blaze**.

### 4. Install deps and deploy

```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```

That deploys the callable **`syncKalshi`** function. It accepts
`{ keyId, privateKey }`, signs the requests, and calls several Kalshi
endpoints — `/portfolio/settlements` (resolved bets), `/portfolio/positions`
(filled but not-yet-settled bets), and `/portfolio/orders?status=resting`
(placed but not-yet-filled bets) — returning all of them normalized into bets,
with anything not yet settled tagged `result: 'pending'`. It also pulls
`/portfolio/balance` (cash + total portfolio value) and
`/portfolio/deposits` + `/portfolio/withdrawals` (cash-flow history), which
feed the **Kalshi Account** card (cash, portfolio at-risk, lifetime/monthly
P&L, and the deposit/withdrawal ledger). **No secrets to configure**, because
the key comes from the client at call time.

---

## Notes & caveats

- **No server-side secrets.** Because the key is supplied per-call, you do not
  run `firebase functions:secrets:set`. The trade-off is the key transits the
  function (in memory, not stored) when you sync.
- **⚠️ Public access (TODO before final launch).** `syncKalshi`'s Cloud Run
  service has **"Allow public access"** turned on (Cloud Run console → service
  → **Security** tab → Authentication). This was the only way to let the
  static site (no sign-in, no Firebase Auth) call it at all — by default Cloud
  Run gen2 functions require IAM auth and reject the browser's request with a
  CORS/403 error before your code even runs. Public access does **not** leak
  any secret (nothing is stored server-side; callers must supply their own
  Kalshi key), but it does mean *anyone* on the internet — not just this
  site's visitors — can invoke the function and consume your Cloud
  Functions/Cloud Run quota. Before a real/public launch: add **Firebase App
  Check** (verifies calls come from your actual deployed app) and/or rate
  limiting, then flip the service back to "Require authentication."
- **Field mapping is best-effort.** `settlementToBet()` in `functions/index.js`
  maps Kalshi's `/portfolio/settlements` fields to the tracker's
  `{ date, description, wager, odds, result }` shape. Kalshi migrated these to
  fixed-point / dollar fields (`yes_count_fp`, `no_count_fp`,
  `yes_total_cost_dollars`, `no_total_cost_dollars`, `revenue_dollars`) — the
  legacy cent-integer fields (`yes_count`, `yes_total_cost`, `revenue`) get
  truncated or dropped on fractional-enabled markets, which is why settled bets
  used to sync as nothing. The mapper now reads the new fields first and falls
  back to the old ones. After your first real sync, eyeball the results and
  adjust if Kalshi has renamed fields again.
- **Open and unfilled bets sync as "pending."** `positionToBet()` maps
  `/portfolio/positions` (`position_fp`, `market_exposure_dollars`, `ticker`,
  `last_updated_ts`) for bets that have filled but not settled.
  `orderToBet()` maps `/portfolio/orders?status=resting`
  (`remaining_count_fp`, `yes_price_dollars`/`no_price_dollars`, `order_id`,
  `ticker`, `created_time`) for bets placed but not yet filled — Kalshi's
  numeric fields are dollar/fixed-point strings, not cents. Both are tagged
  `result: 'pending'` and show on the Bet Tracker's dedicated **Pending
  Bets** calendar. Each sync drops any old pending placeholder for a ticker
  it touches at all (order filled → position, position settled, etc.) so
  the fresh picture replaces it instead of duplicating.
- **Descriptions use the real market title, not the raw ticker.** Kalshi's
  tickers (e.g. `KXWCGAME-26JUN16FRASEN-FRA`) aren't readable, so `syncKalshi`
  also calls the public, unauthenticated `GET /markets/{ticker}` endpoint
  (`getMarketInfo()`/`describeMarket()` in `functions/index.js`) and builds
  the description from its `title` + `yes_sub_title`/`no_sub_title` fields,
  caching each ticker's lookup for the life of one sync. If a market lookup
  fails (e.g. delisted), it falls back to showing the raw ticker.
- **Odds conversion:** Kalshi contracts pay $1.00 (100¢), so your average fill
  price in cents is the implied probability → decimal odds = `100 / avgPriceCents`.
- **Sandbox vs production:** switch `HOST` in `functions/index.js` to
  `https://demo-api.kalshi.co` to test against Kalshi's demo environment.
- **localStorage, not the cloud.** Bets (and your Kalshi key) live in this
  browser only. Use Export CSV to back up. The included [`firestore.rules`](firestore.rules)
  are here for a future per-user cloud-storage step, not used yet.
- **No WebSockets here.** Cloud Functions are short-lived, so this polls the REST
  API. For live `fill`-channel streaming you'd use a long-running host (Cloud Run).

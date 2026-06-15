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
`{ keyId, privateKey }`, signs the requests, calls Kalshi
`/portfolio/settlements`, and returns normalized bets — **no secrets to
configure**, because the key comes from the client at call time.

---

## Notes & caveats

- **No server-side secrets.** Because the key is supplied per-call, you do not
  run `firebase functions:secrets:set`. The trade-off is the key transits the
  function (in memory, not stored) when you sync.
- **Field mapping is best-effort.** `settlementToBet()` in `functions/index.js`
  maps Kalshi's `/portfolio/settlements` fields (`yes_count`, `no_count`,
  `yes_total_cost`, `no_total_cost`, `revenue`, `settled_time`, `ticker`) to the
  tracker's `{ date, description, wager, odds, result }` shape. After your first
  real sync, eyeball the results and adjust if Kalshi has renamed fields.
- **Odds conversion:** Kalshi contracts pay $1.00 (100¢), so your average fill
  price in cents is the implied probability → decimal odds = `100 / avgPriceCents`.
- **Sandbox vs production:** switch `HOST` in `functions/index.js` to
  `https://demo-api.kalshi.co` to test against Kalshi's demo environment.
- **localStorage, not the cloud.** Bets (and your Kalshi key) live in this
  browser only. Use Export CSV to back up. The included [`firestore.rules`](firestore.rules)
  are here for a future per-user cloud-storage step, not used yet.
- **No WebSockets here.** Cloud Functions are short-lived, so this polls the REST
  API. For live `fill`-channel streaming you'd use a long-running host (Cloud Run).

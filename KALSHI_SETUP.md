# Kalshi Sync — Firebase Backend Setup

This repo ships a **scaffold** for syncing Kalshi data into the Bet Tracker.
A static site (GitHub Pages) can't talk to Kalshi directly: every Kalshi API
request must be **RSA-signed** with a private key that has to stay server-side,
and the browser is blocked by CORS. The Cloud Function in [`functions/`](functions/)
is that small server-side piece — it holds the key, signs requests, and returns
your settled positions.

> **Status:** backend only. The tracker UI still uses `localStorage` and is
> **not** wired to this function yet. Steps 1–8 deploy the backend; the
> "Wiring the app later" section covers connecting the UI.

---

## What you need

- A Google account.
- The [Firebase CLI](https://firebase.google.com/docs/cli): `npm install -g firebase-tools`
- A Kalshi account with API access.

---

## 1. Create a Firebase project

1. Go to <https://console.firebase.google.com> → **Add project**.
2. Note the **Project ID** (e.g. `selene-tracker-1234`).
3. Put it in [`.firebaserc`](.firebaserc), replacing `YOUR_FIREBASE_PROJECT_ID`.

## 2. Upgrade to the Blaze plan (required)

Cloud Functions can only make outbound calls to a non-Google service (Kalshi)
on the **Blaze** (pay-as-you-go) plan. The free Spark plan blocks that egress.
Blaze has a generous free tier — for personal use you'll likely pay ~$0. Set a
budget alert in the Google Cloud console for peace of mind.

In the Firebase console: **⚙ → Usage and billing → Modify plan → Blaze**.

## 3. Log in and select the project

```bash
firebase login
firebase use --add        # pick the project you created
```

## 4. Generate Kalshi API credentials

1. In Kalshi: **Account → API Keys → Create API Key**.
2. You get a **Key ID** and a one-time **RSA private key** (`-----BEGIN RSA PRIVATE KEY-----`).
   Save the private key now — Kalshi will not show it again.

## 5. Store the credentials as Firebase secrets

Never commit these. Store them as managed secrets:

```bash
firebase functions:secrets:set KALSHI_KEY_ID
#   paste the Key ID when prompted

firebase functions:secrets:set KALSHI_PRIVATE_KEY
#   paste the full PEM private key (including BEGIN/END lines), then Ctrl-D
```

## 6. Install dependencies

```bash
cd functions
npm install
cd ..
```

## 7. (Optional) Test locally

```bash
firebase emulators:start --only functions
```

## 8. Deploy

```bash
firebase deploy --only functions
```

You now have a callable function named **`syncKalshi`** that returns:

```json
{ "bets": [ /* normalized bet objects */ ], "count": 42, "syncedAt": "..." }
```

---

## Wiring the app later

When you're ready to connect the tracker UI:

1. `npm install firebase` in the project root.
2. Initialize Firebase in the app and add **Auth** (so each user's bets/key are
   scoped to them). Update [`firestore.rules`](firestore.rules) is already set
   up for `users/{uid}/bets`.
3. Call the function and merge results into the tracker:

   ```js
   import { getFunctions, httpsCallable } from 'firebase/functions'

   const sync = httpsCallable(getFunctions(), 'syncKalshi')
   const { data } = await sync()      // { bets, count, syncedAt }
   // de-dupe by bet.id, then save into the tracker's bet list
   ```

4. Add a **"Sync Kalshi"** button to the tracker's Add Bets / Import section.

To make sync periodic, add a Cloud Scheduler trigger that calls the same logic
on an interval and writes results to Firestore (`users/{uid}/bets`).

---

## Notes & caveats

- **Field mapping is best-effort.** `settlementToBet()` in `functions/index.js`
  maps Kalshi's `/portfolio/settlements` fields (`yes_count`, `no_count`,
  `yes_total_cost`, `no_total_cost`, `revenue`, `settled_time`, `ticker`) to the
  tracker's `{ date, description, wager, odds, result }` shape. Verify against the
  current API response and adjust if Kalshi changes field names.
- **Odds conversion:** Kalshi contracts pay $1.00 (100¢), so your average fill
  price in cents is the implied probability → decimal odds = `100 / avgPriceCents`.
- **Sandbox vs production:** switch `HOST` in `functions/index.js` to
  `https://demo-api.kalshi.co` to test against Kalshi's demo environment.
- **No WebSockets here.** Cloud Functions are short-lived, so this polls the REST
  API. For live `fill`-channel streaming you'd use a long-running host (Cloud Run).

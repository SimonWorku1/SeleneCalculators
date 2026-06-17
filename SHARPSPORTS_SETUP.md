# SharpSports (BetSync) Sync — Setup

The **SharpSports** page links a user's sportsbook account through SharpSports'
BetSync product and pulls their bet slips onto a monthly **P&L calendar** and a
**detailed bet list**. SharpSports is an account-linking provider — think
"Plaid for sportsbooks": your app holds one Public + one Private API key, your
users log into their books inside SharpSports' hosted UI, and **credentials
never touch this site**.

This page works in two modes:

- **Sample mode** — click **Load sample data** to render the calendar + list
  from built-in fixtures, no backend or keys required (good for a demo / UI
  review).
- **Live sandbox mode** — deploy the two Cloud Functions below with your
  SharpSports **sandbox** keys, link a book with the test login
  `gooduser` / `Test1`, and click **Sync bets**.

> **Do you need to give me an API key?** To make a *live* sandbox sync work,
> yes — I need a SharpSports **sandbox Public API Key** and **sandbox Private
> API Key** (Dashboard → Settings → API Keys; the dashboard defaults to
> sandbox). Until those are set, the page still runs in sample mode. **Never**
> paste the Private key into the frontend or commit it — it goes into a
> Firebase secret (below).

---

## A note on the stack (read this first)

The prompt asked for a **Python backend + Next.js frontend on Vercel + a
relational DB**. SeleneCalculators is actually a **React + Vite** site on
**GitHub Pages**, whose only backend is **Firebase Cloud Functions (Node)** —
the same pattern the existing Kalshi sync uses. Since the instruction was to
"create a new page on the SeleneCalculators website," the page is built in the
site's real stack so it deploys the same way everything else does.

The **DBML schema** and **API call sequence** below are stack-agnostic — they
are the spec whether you persist to Postgres (Vercel/Neon/Supabase) or to
Firestore. How the schema maps to *this* implementation:

| DBML table        | This app (now)                          | If you go Postgres/Next.js          |
| ----------------- | --------------------------------------- | ----------------------------------- |
| `users`           | one local `internalId` in localStorage  | a real users table + auth           |
| `bettor_accounts` | returned by `syncSharpSports`           | persisted per user                  |
| `bet_slips`       | localStorage `selene_ss_bets`           | persisted, indexed by `placed_date` |
| `bets` (legs)     | summarized into the slip description    | one row per leg                     |

If you'd rather I build the **standalone Next.js + Python + Vercel + Postgres**
version as a separate app (not a page on this site), say so — the schema and
sequence here drop straight into it.

---

## B. The data model (DBML)

Designed so **daily P&L is a single indexed `GROUP BY`**: each slip stores a
precomputed `net_profit_cents` and a `placed_date` (the local calendar day),
with a composite index on `(user_id, placed_date)`.

```dbml
Table users {
  id            uuid       [pk]
  email         varchar    [unique]
  internal_id   varchar    [unique, note: 'sent to SharpSports as internalId']
  created_at    timestamptz [default: `now()`]
}

Table bettor_accounts {
  id                  varchar   [pk, note: 'SharpSports bettorAccount id']
  user_id             uuid      [ref: > users.id]
  sharpsports_bettor  varchar   [note: 'SharpSports bettor id']
  book_id             varchar
  book_name           varchar
  book_abbr           varchar
  region              varchar
  status              varchar   [note: 'linked | unverified | expired | ...']
  verified            boolean
  linked_at           timestamptz
  last_refreshed_at   timestamptz
  Indexes {
    user_id
    sharpsports_bettor
  }
}

Table bet_slips {
  id                varchar    [pk, note: 'SharpSports betSlip id']
  user_id           uuid       [ref: > users.id]
  bettor_account_id varchar    [ref: > bettor_accounts.id]
  type              varchar    [note: 'single | parlay | teaser | ...']
  status            varchar    [note: 'pending | won | lost | push | canceled']
  at_risk_cents     bigint     [note: 'stake, in cents']
  to_win_cents      bigint     [note: 'profit if it wins, in cents']
  payout_cents      bigint
  odds_american     integer
  odds_decimal      numeric(10,4)
  net_profit_cents  bigint     [note: 'won=+to_win, lost=-at_risk, else 0']
  placed_at         timestamptz
  graded_at         timestamptz
  placed_date       date       [note: 'local day of placed_at = the P&L bucket']
  book_name         varchar    [note: 'denormalized for fast display']
  description       varchar
  raw               jsonb      [note: 'full payload, for re-derivation']
  created_at        timestamptz [default: `now()`]
  Indexes {
    (user_id, placed_date)
    bettor_account_id
    status
  }
}

Table bets {
  id              varchar   [pk, note: 'SharpSports bet (leg) id']
  bet_slip_id     varchar   [ref: > bet_slips.id]
  type            varchar
  odds_american   integer
  book_description varchar
  sport           varchar
  league          varchar
  event_start     timestamptz
  proposition     varchar
  position        varchar
  incomplete      boolean
  Indexes {
    bet_slip_id
  }
}
```

**Daily P&L query** (drives the calendar):

```sql
SELECT placed_date,
       SUM(net_profit_cents) / 100.0 AS net_pnl,
       SUM(at_risk_cents)    / 100.0 AS wagered,
       COUNT(*)                      AS slips
FROM bet_slips
WHERE user_id = $1
  AND placed_date BETWEEN $2 AND $3      -- the visible month
GROUP BY placed_date
ORDER BY placed_date;
```

---

## C. The SharpSports API call sequence

Every request is authenticated with a header — **Public** key for
linking/discovery, **Private** key for bet data:

```
Authorization: Token <API_KEY>
```

```
# 1. Create a betSync context            [PUBLIC key]   → our sharpSportsContext()
POST https://api.sharpsports.io/v1/context
     { "internalId": "<your users.internal_id>" }
  ← { "cid": "CONTEXT_xxx", ... }

# 2. Send the user to the Booklink UI with that cid (popup or full-page redirect)
GET  https://ui.sharpsports.io/link/<cid>
     # optional ?redirectUrl=<return URL>
     # optional deep-link to one book: /link/<cid>/region/<bookRegionId>/login
     # SANDBOX test login:  gooduser / Test1

# 3. (async) SharpSports creates a bettor + bettorAccount tied to internalId.
#    Register a webhookUrl on the context to be pushed updates instead of polling.

# 4. Resolve the bettor                   [PRIVATE key]  → our syncSharpSports()
GET  https://api.sharpsports.io/v1/bettors?internalId=<your users.internal_id>
  ← [ { "id": "BETTOR_xxx", "internalId": "...", ... } ]

# 5. List linked accounts (to label each bet with its book)   [PRIVATE key]
GET  https://api.sharpsports.io/v1/bettorAccounts?bettorId=BETTOR_xxx
  ← [ { "id": "BACCT_xxx", "book": { "name": "DraftKings", "abbr": "dk" } } ]

# 6. Pull bet slips                        [PRIVATE key]
GET  https://api.sharpsports.io/v1/betSlips?bettorId=BETTOR_xxx&limit=500
  ← [ { id, bettorAccountId, status, atRisk, toWin, payout,
        oddsAmerican, oddsDecimal, placedAt, gradedAt, bets:[ ... ] } ]

# 7. (later) Refresh to pull new bets      [PRIVATE key]
POST https://api.sharpsports.io/v1/bettorAccounts/BACCT_xxx/refresh
     # sandbox: a refresh generates a few new random live slips, graded after the event
```

Steps **1–2** are the `sharpSportsContext` Cloud Function; steps **4–6** are
`syncSharpSports`. (The docs block automated fetching, so verify the exact
shapes of the `bettors?internalId=` filter and the `refresh` path against the
current [SharpSports reference](https://docs.sharpsports.io/reference/betslip)
on first run — the code degrades gracefully if a list endpoint returns an
envelope instead of a bare array.)

---

## D. Deploy the Cloud Functions (one-time)

Two callables live in [`functions/index.js`](functions/index.js):
`sharpSportsContext` (Public key) and `syncSharpSports` (Private key).

```bash
# 1. Store your sandbox keys as Firebase secrets (never in the frontend)
firebase functions:secrets:set SHARPSPORTS_PUBLIC_KEY
firebase functions:secrets:set SHARPSPORTS_PRIVATE_KEY

# 2. Deploy
cd functions && npm install && cd ..
firebase deploy --only functions
```

Requires the **Blaze** plan (outbound calls to a non-Google host), same as the
Kalshi function — see [`KALSHI_SETUP.md`](KALSHI_SETUP.md). For the local
emulator, provide the keys via `functions/.env` instead of secrets.

---

## Notes & caveats

- **Money units.** SharpSports returns `atRisk` / `toWin` / `payout` as integer
  **cents**. `betSlipToBet()` divides by `SS_AMOUNT_DIVISOR` (= 100). If your
  first sandbox sync shows dollar amounts 100× off, flip that constant to `1`.
  Odds are taken from `oddsAmerican` / `oddsDecimal` when present and otherwise
  derived from the risk/return ratio (which is unit-independent).
- **Status mapping.** `won → won`, `lost → lost`,
  `push / canceled / refunded → push`, everything else → `pending` (no P&L
  impact). Adjust `ssResult()` if the sandbox returns other statuses.
- **Public access (same TODO as Kalshi).** These callables are reachable
  unauthenticated so the static site can call them. They expose **no secret**
  (keys stay server-side), but add **Firebase App Check** + rate limiting
  before a public launch.
- **Keys are app-level, not per-user.** Unlike the Kalshi sync (each user
  brings their own key), the SharpSports keys are *yours* and serve every user;
  that's why they're Firebase secrets, not entered in the browser.
- **localStorage, not the cloud.** Synced slips persist in this browser only
  (`selene_ss_bets`). The DBML above is the target if/when you add real
  per-user storage.

import { useState, useEffect, useMemo } from 'react'
// Firebase is imported lazily inside the sync/connect handlers so the page
// loads without the Firebase SDK on the critical path (same pattern as the
// Bet Tracker's Kalshi sync).

const BETS_KEY = 'selene_ss_bets'
const INTERNAL_KEY = 'selene_ss_internal_id'
const BETTOR_KEY = 'selene_ss_bettor_id'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const money = (n) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`)

function newInternalId() {
  const rnd = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random())
  return `selene-${rnd}`
}

// Profit (excluding stake) for a settled slip; pending/push contribute 0.
function betProfit(b) {
  if (b.result === 'won') return b.toWin != null ? b.toWin : b.wager * ((b.dec || 1) - 1)
  if (b.result === 'lost') return -b.wager
  return 0
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const v = JSON.parse(raw)
    return v == null ? fallback : v
  } catch {
    return fallback
  }
}

function loadBets() {
  const arr = load(BETS_KEY, [])
  return Array.isArray(arr) ? arr : []
}

const dateOf = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d) ? null : d
}

/* ── A small built-in sandbox sample so the calendar + list are demonstrable
 * before any API key is wired up. Mirrors the normalized shape returned by
 * the syncSharpSports Cloud Function. ── */
function sampleBets() {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth()
  const mk = (day, hour, sportsbook, description, wager, odds, result, type = 'single') => {
    const dec = odds >= 100 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1
    const toWin = +(wager * (dec - 1)).toFixed(2)
    return {
      id: `sample-${day}-${sportsbook}-${Math.random().toString(36).slice(2, 7)}`,
      slipId: null,
      placedAt: new Date(y, m, day, hour, 15).toISOString(),
      description, sportsbook, wager, toWin,
      odds: (odds > 0 ? '+' : '') + odds, fmt: 'american', dec,
      result, type, source: 'sharpsports', sample: true,
    }
  }
  return [
    mk(2, 13, 'DraftKings', 'Lakers ML (vs Celtics)', 50, -130, 'won'),
    mk(2, 19, 'FanDuel', 'Chiefs -6.5 (vs Bills)', 40, -110, 'lost'),
    mk(5, 12, 'BetMGM', 'Patrick Mahomes Over 2.5 TD Passes', 25, +120, 'won'),
    mk(5, 20, 'Caesars', '3-leg parlay', 20, +450, 'lost', 'parlay'),
    mk(9, 18, 'DraftKings', 'Yankees ML (vs Red Sox)', 60, -150, 'won'),
    mk(12, 14, 'FanDuel', 'Warriors +3.5 (vs Suns)', 35, -108, 'push'),
    mk(12, 21, 'BetMGM', 'Over 220.5 (Heat vs Knicks)', 30, -110, 'lost'),
    mk(16, 11, 'PointsBet', 'Steph Curry Over 4.5 Threes', 25, +135, 'won'),
    mk(19, 17, 'DraftKings', 'Eagles ML (vs Cowboys)', 45, +150, 'pending'),
    mk(22, 16, 'Caesars', 'Aaron Judge Over 0.5 HR', 20, +180, 'won'),
  ]
}

export default function SharpSports() {
  const [bets, setBets] = useState(loadBets)
  const [internalId, setInternalId] = useState(() => {
    const existing = load(INTERNAL_KEY, '')
    if (existing) return existing
    const id = newInternalId()
    try { localStorage.setItem(INTERNAL_KEY, id) } catch { /* ignore */ }
    return id
  })
  const [bettorId, setBettorId] = useState(() => load(BETTOR_KEY, ''))
  const [view, setView] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')

  // persist
  useEffect(() => { try { localStorage.setItem(BETS_KEY, JSON.stringify(bets)) } catch { /* ignore */ } }, [bets])
  useEffect(() => { try { localStorage.setItem(BETTOR_KEY, bettorId) } catch { /* ignore */ } }, [bettorId])

  const hasSample = bets.some(b => b.sample)

  async function loadFirebase() {
    const [{ httpsCallable }, { functions }] = await Promise.all([
      import('firebase/functions'),
      import('../firebase.js'),
    ])
    return { httpsCallable, functions }
  }

  /* ── Step 1: create a betSync context and open the Booklink UI ── */
  async function connectBook() {
    setConnecting(true)
    setMsg('Creating a secure linking session…')
    try {
      const { httpsCallable, functions } = await loadFirebase()
      const fn = httpsCallable(functions, 'sharpSportsContext')
      const { data } = await fn({ internalId, redirectUrl: window.location.href })
      if (data?.linkUrl) {
        window.open(data.linkUrl, '_blank', 'noopener,noreferrer')
        setMsg('Opened the SharpSports Booklink window. In the sandbox, link any book with username "gooduser" and password "Test1", then come back and click Sync bets.')
      } else {
        setMsg('No link URL returned. Check the sharpSportsContext function and your Public API key.')
      }
    } catch (e) {
      setMsg(`Couldn't start linking: ${e.message || e}. The sharpSportsContext Cloud Function must be deployed with your SharpSports Public API key — see SHARPSPORTS_SETUP.md.`)
    } finally {
      setConnecting(false)
    }
  }

  /* ── Step 2: pull this bettor's bet slips (server-side, Private key) ── */
  async function sync() {
    setSyncing(true)
    setMsg('Syncing bet slips from SharpSports…')
    try {
      const { httpsCallable, functions } = await loadFirebase()
      const fn = httpsCallable(functions, 'syncSharpSports')
      const payload = bettorId.trim() ? { bettorId: bettorId.trim() } : { internalId }
      const { data } = await fn(payload)
      const incoming = Array.isArray(data?.bets) ? data.bets : []
      // Replace any previously-synced SharpSports bets (drop sample data too)
      // with the fresh pull, de-duped by id.
      const seen = new Set()
      const fresh = incoming.filter(b => b && b.id && !seen.has(b.id) && seen.add(b.id))
      setBets(fresh)
      if (data?.bettorId && !bettorId) setBettorId(data.bettorId)
      setMsg(`Synced ${fresh.length} bet slip${fresh.length === 1 ? '' : 's'} across ${data?.accounts ?? 0} linked account${data?.accounts === 1 ? '' : 's'}.`)
    } catch (e) {
      setMsg(`Sync failed: ${e.message || e}. Deploy the syncSharpSports Cloud Function with your Private API key, or link a book first — see SHARPSPORTS_SETUP.md.`)
    } finally {
      setSyncing(false)
    }
  }

  function loadSample() {
    setBets(sampleBets())
    setMsg('Loaded built-in sample sandbox data so you can see the calendar and bet list. Replace it with a real sync once your keys are set.')
  }

  function clearBets() {
    if (!bets.length) return
    if (!window.confirm('Clear all bet slips shown here?')) return
    setBets([])
    setMsg('Cleared.')
  }

  function regenInternalId() {
    if (!window.confirm('Generate a new user id? You would re-link your books under the new id.')) return
    const id = newInternalId()
    try { localStorage.setItem(INTERNAL_KEY, id) } catch { /* ignore */ }
    setInternalId(id)
    setMsg('New internal user id generated.')
  }

  /* ── month math ── */
  const { year, month } = view
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const firstWeekday = new Date(year, month, 1).getDay()
  const todayStr = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()

  // bets that fall in the viewed month (by local placed date)
  const monthBets = useMemo(() => bets.filter(b => {
    const d = dateOf(b.placedAt)
    return d && d.getFullYear() === year && d.getMonth() === month
  }), [bets, year, month])

  const dayPnl = useMemo(() => {
    const map = {}
    for (const b of monthBets) {
      const d = dateOf(b.placedAt)
      const day = d.getDate()
      map[day] = (map[day] || 0) + betProfit(b)
    }
    return map
  }, [monthBets])

  const dayCount = useMemo(() => {
    const map = {}
    for (const b of monthBets) {
      const day = dateOf(b.placedAt).getDate()
      map[day] = (map[day] || 0) + 1
    }
    return map
  }, [monthBets])

  const stats = useMemo(() => {
    let wagered = 0, profit = 0, won = 0, lost = 0, pending = 0
    for (const b of monthBets) {
      if (b.result === 'pending') { pending++; continue }
      wagered += b.wager
      profit += betProfit(b)
      if (b.result === 'won') won++
      else if (b.result === 'lost') lost++
    }
    const decided = won + lost
    return { wagered, profit, won, lost, pending, winRate: decided ? (won / decided) * 100 : null, roi: wagered ? (profit / wagered) * 100 : null }
  }, [monthBets])

  function changeMonth(delta) {
    setView(v => {
      const d = new Date(v.year, v.month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  const resultBadge = { won: 'badge-green', lost: 'badge-red', push: 'badge-yellow', pending: 'badge-blue' }

  // detailed list, newest first
  const listBets = useMemo(
    () => [...monthBets].sort((a, b) => (dateOf(b.placedAt) || 0) - (dateOf(a.placedAt) || 0)),
    [monthBets]
  )

  return (
    <div className="page wide">
      <div className="page-header">
        <h1>SharpSports Sync</h1>
        <p>Link a sportsbook through SharpSports BetSync (sandbox) and pull your bet slips into a monthly P&amp;L calendar and a detailed bet list.</p>
      </div>

      <div className="calc-layout">
        {/* ── Left column: connect + sync + summary ── */}
        <div className="calc-col">
          <div className="card">
            <h2>Connect &amp; Sync</h2>

            <div className="field" style={{ marginBottom: 14 }}>
              <label>Your internal user id (sent to SharpSports as <code>internalId</code>)</label>
              <input type="text" value={internalId} readOnly onFocus={e => e.target.select()} />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-sm bt-action-btn" onClick={connectBook} disabled={connecting}>
                {connecting ? 'Opening…' : '🔗 Connect a sportsbook'}
              </button>
              <button className="btn btn-sm bt-action-btn" onClick={sync} disabled={syncing}>
                {syncing ? 'Syncing…' : '🔄 Sync bets'}
              </button>
              <button className="btn btn-outline btn-sm" onClick={regenInternalId}>New id</button>
            </div>

            <div className="field" style={{ marginTop: 16 }}>
              <label>Sandbox bettor id (optional — paste the test bettor from your SharpSports dashboard to pull its history directly)</label>
              <input type="text" placeholder="e.g. BETTOR_xxxxxxxx" value={bettorId} onChange={e => setBettorId(e.target.value)} autoComplete="off" />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button className="btn btn-outline btn-sm" onClick={loadSample}>Load sample data</button>
              <button className="btn btn-outline btn-sm" onClick={clearBets} disabled={bets.length === 0}>Clear</button>
            </div>

            {msg && <div className="info-box" style={{ marginTop: 14 }}>{msg}</div>}
            {hasSample && (
              <div className="info-box" style={{ marginTop: 14, borderColor: 'rgba(245,182,66,0.4)', background: 'rgba(245,182,66,0.08)' }}>
                Showing <strong>sample sandbox data</strong>, not a live sync.
              </div>
            )}

            <div className="info-box" style={{ marginTop: 14 }}>
              SharpSports is an account-linking provider (think “Plaid for sportsbooks”). Your app holds its API key server-side — in the free <strong>sandbox</strong> that's just the <strong>Public key</strong> (no Private key needed); users link their books in SharpSports’ hosted UI, so credentials never touch this site. Link with <code>gooduser</code> / <code>Test1</code>. Setup &amp; the API call sequence are in <strong>SHARPSPORTS_SETUP.md</strong>.
            </div>
          </div>

          <div className="card">
            <h2>{MONTHS[month]} {year} — Summary</h2>
            <div className="result-grid">
              <div className="result-item"><div className="label">Net P&amp;L</div><div className={`value ${stats.profit >= 0 ? 'green' : 'red'}`}>{money(stats.profit)}</div></div>
              <div className="result-item"><div className="label">Total Wagered</div><div className="value">${stats.wagered.toFixed(2)}</div></div>
              <div className="result-item"><div className="label">ROI</div><div className={`value ${(stats.roi ?? 0) >= 0 ? 'green' : 'red'}`}>{stats.roi === null ? '—' : `${stats.roi >= 0 ? '+' : ''}${stats.roi.toFixed(1)}%`}</div></div>
              <div className="result-item"><div className="label">Record (W-L)</div><div className="value yellow">{stats.won}–{stats.lost}{stats.pending ? ` · ${stats.pending} open` : ''}</div></div>
            </div>
          </div>
        </div>

        {/* ── Right column: calendar ── */}
        <div className="calc-col">
          <div className="card">
            <div className="bt-month-nav">
              <button className="btn btn-outline btn-sm" onClick={() => changeMonth(-1)}>← Prev</button>
              <h2 style={{ margin: 0 }}>{MONTHS[month]} {year}</h2>
              <button className="btn btn-outline btn-sm" onClick={() => changeMonth(1)}>Next →</button>
            </div>
            <div className="bt-calendar bt-compact">
              {WEEKDAYS.map(w => <div key={w} className="bt-weekday">{w}</div>)}
              {Array.from({ length: firstWeekday }).map((_, i) => <div key={`e${i}`} className="bt-cell empty" />)}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1
                const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                const pnl = dayPnl[day]
                const count = dayCount[day]
                const has = count > 0
                return (
                  <div key={day} className={`bt-cell${iso === todayStr ? ' today' : ''}${has ? (pnl > 0 ? ' pos' : pnl < 0 ? ' neg' : '') : ''}`}>
                    <div className="bt-day-num">{day}</div>
                    {has && (
                      <>
                        <div className={`bt-day-pnl ${pnl > 0 ? 'green' : pnl < 0 ? 'red' : ''}`}>{pnl === 0 ? '$0' : money(pnl)}</div>
                        <div className="bt-day-count">{count} bet{count === 1 ? '' : 's'}</div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Detailed bet list ── */}
      <div className="card">
        <h2>Bets — {MONTHS[month]} {year}</h2>
        {listBets.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            No bet slips for this month yet. Connect a sportsbook and Sync, or Load sample data to preview.
          </p>
        ) : (
          <table className="result-table">
            <thead>
              <tr><th>Date</th><th>Time</th><th>Sportsbook</th><th>Bet</th><th>Odds</th><th>Wagered</th><th>Status</th><th>P&amp;L</th></tr>
            </thead>
            <tbody>
              {listBets.map(b => {
                const d = dateOf(b.placedAt)
                const p = betProfit(b)
                return (
                  <tr key={b.id}>
                    <td>{d ? `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}` : '—'}</td>
                    <td>{d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                    <td><span className="badge badge-blue">{b.sportsbook}</span></td>
                    <td>{b.description}{b.type === 'parlay' ? ' 🎟' : ''}</td>
                    <td>{b.odds}</td>
                    <td>${b.wager.toFixed(2)}</td>
                    <td><span className={`badge ${resultBadge[b.result]}`}>{b.result.charAt(0).toUpperCase() + b.result.slice(1)}</span></td>
                    <td style={{ color: b.result === 'pending' ? 'var(--text-muted)' : p > 0 ? 'var(--accent-green)' : p < 0 ? 'var(--accent-red)' : 'var(--text)', fontWeight: 600 }}>
                      {b.result === 'pending' ? '—' : money(p)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

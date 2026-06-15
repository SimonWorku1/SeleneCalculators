import { useState, useEffect, useMemo, useRef } from 'react'
// Firebase is imported lazily inside syncKalshi() so the localStorage-only
// tracker loads without the Firebase SDK (and without it installed).

const STORAGE_KEY = 'selene_bets'
const KALSHI_KEYID = 'selene_kalshi_key_id'
const KALSHI_PRIVKEY = 'selene_kalshi_private_key'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/* ── odds helpers ── */
function toDecimal(val, fmt) {
  const n = parseFloat(val)
  if (isNaN(n)) return null
  if (fmt === 'decimal') return n > 1 ? n : null
  if (n >= 100) return n / 100 + 1
  if (n <= -100) return 100 / Math.abs(n) + 1
  return null
}

// Profit (not including stake) for a settled bet. Pending/push contribute 0.
function betProfit(bet) {
  if (bet.result === 'won') return bet.wager * (bet.dec - 1)
  if (bet.result === 'lost') return -bet.wager
  return 0 // push or pending
}

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const money = (n) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`)

function loadBets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    // backfill source for bets saved before source tagging existed
    return arr.map(b => ({ ...b, source: b.source || 'manual' }))
  } catch {
    return []
  }
}

/* ── SVG month chart (no external deps) ── */
function MonthChart({ days, mode }) {
  const W = 760, H = 240, padL = 52, padR = 16, padT = 18, padB = 26
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const n = days.length

  const vals = days.map(d => (mode === 'cumulative' ? d.cumulative : d.daily))
  let max = Math.max(0, ...vals)
  let min = Math.min(0, ...vals)
  if (max === min) { max += 1; min -= 1 }
  const pad = (max - min) * 0.08
  max += pad; min -= pad

  const xFor = (i) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const yFor = (v) => padT + innerH * (1 - (v - min) / (max - min))
  const zeroY = yFor(0)

  const final = vals[vals.length - 1] ?? 0
  const lineColor = final >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'

  // x-axis day labels (every ~5 days)
  const step = Math.max(1, Math.round(n / 6))
  const labels = days.filter((_, i) => i % step === 0 || i === n - 1)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="bt-chart" preserveAspectRatio="xMidYMid meet">
      {/* zero baseline */}
      <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="var(--border)" strokeWidth="1" />
      {/* y labels */}
      <text x={padL - 8} y={yFor(max) + 4} textAnchor="end" className="bt-axis">{money(max)}</text>
      <text x={padL - 8} y={zeroY + 4} textAnchor="end" className="bt-axis">$0</text>
      <text x={padL - 8} y={yFor(min) + 4} textAnchor="end" className="bt-axis">{money(min)}</text>

      {mode === 'cumulative' ? (
        <>
          <polyline
            points={days.map((d, i) => `${xFor(i)},${yFor(d.cumulative)}`).join(' ')}
            fill="none" stroke={lineColor} strokeWidth="2.5"
            strokeLinejoin="round" strokeLinecap="round"
          />
          {days.map((d, i) => (
            <circle key={i} cx={xFor(i)} cy={yFor(d.cumulative)} r={n > 20 ? 0 : 2.5} fill={lineColor} />
          ))}
        </>
      ) : (
        days.map((d, i) => {
          if (d.daily === 0) return null
          const bw = Math.max(2, (innerW / n) * 0.6)
          const x = xFor(i) - bw / 2
          const y = d.daily >= 0 ? yFor(d.daily) : zeroY
          const h = Math.abs(yFor(d.daily) - zeroY)
          return (
            <rect key={i} x={x} y={y} width={bw} height={h} rx="1"
              fill={d.daily >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'} />
          )
        })
      )}

      {/* x labels */}
      {labels.map((d) => (
        <text key={d.day} x={xFor(d.day - 1)} y={H - 6} textAnchor="middle" className="bt-axis">{d.day}</text>
      ))}
    </svg>
  )
}

export default function BetTracker() {
  const [bets, setBets] = useState(loadBets)
  const [view, setView] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  const [chartMode, setChartMode] = useState('cumulative')
  const [oddsFmt, setOddsFmt] = useState('american')
  const [form, setForm] = useState({
    date: todayISO(), description: '', sportsbook: '', wager: '', odds: '', result: 'pending',
  })
  const [error, setError] = useState('')
  const [importMsg, setImportMsg] = useState('')
  const [genMsg, setGenMsg] = useState('')
  const [syncMsg, setSyncMsg] = useState('')
  const [testEv, setTestEv] = useState('5')
  const [showManual, setShowManual] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [sourceTab, setSourceTab] = useState('all') // all | manual | kalshi
  const [kKeyId, setKKeyId] = useState(() => { try { return localStorage.getItem(KALSHI_KEYID) || '' } catch { return '' } })
  const [kPriv, setKPriv] = useState(() => { try { return localStorage.getItem(KALSHI_PRIVKEY) || '' } catch { return '' } })
  const [editKalshi, setEditKalshi] = useState(() => { try { return !localStorage.getItem(KALSHI_KEYID) } catch { return true } })
  const [showSecret, setShowSecret] = useState(false)
  const [showTutorial, setShowTutorial] = useState(false)
  const fileRef = useRef(null)
  const kalshiConnected = !editKalshi && kKeyId && kPriv

  // persist
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bets)) } catch { /* ignore quota */ }
  }, [bets])

  /* ── add bet ── */
  function addBet(e) {
    e.preventDefault()
    setError('')
    const dec = toDecimal(form.odds, oddsFmt)
    const wager = parseFloat(form.wager)
    if (!form.date) return setError('Pick a date for the bet.')
    if (!(wager > 0)) return setError('Enter a wager amount greater than 0.')
    if (!dec) return setError(`Enter valid ${oddsFmt} odds (e.g. ${oddsFmt === 'american' ? '-110 or +150' : '1.91'}).`)
    const bet = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      date: form.date,
      description: form.description.trim() || 'Untitled bet',
      sportsbook: form.sportsbook.trim(),
      wager,
      odds: form.odds,
      fmt: oddsFmt,
      dec,
      result: form.result,
      source: 'manual',
    }
    setBets(prev => [...prev, bet])
    setForm(f => ({ ...f, description: '', wager: '', odds: '' }))
    setShowManual(false)
  }

  function removeBet(id) {
    setBets(prev => prev.filter(b => b.id !== id))
  }

  function cycleResult(id) {
    const order = ['pending', 'won', 'lost', 'push']
    setBets(prev => prev.map(b =>
      b.id === id ? { ...b, result: order[(order.indexOf(b.result) + 1) % order.length] } : b))
  }

  /* ── random test data ── */
  function generateTestBets() {
    const markets = ['Lakers ML', 'Chiefs -3.5', 'Over 47.5', 'Yankees ML', 'Celtics -6',
      'Warriors +4.5', 'Trump 2028 Nominee', 'Fed cuts rates', 'BTC > $100k EOY',
      'Real Madrid to win', 'Djokovic to win', 'Under 215.5', 'Eagles ML', 'Bills -7']
    const books = ['Kalshi', 'DraftKings', 'FanDuel', 'BetMGM', 'Polymarket', 'Caesars']
    const americanOdds = [-200, -150, -130, -110, +100, +120, +150, +180, +220, +300, -250]
    const rand = (arr) => arr[Math.floor(Math.random() * arr.length)]

    // Target EV as ROI per bet (% of stake). For decimal odds `dec`, the win
    // probability that yields a given EV is p = (EV + 1) / dec, since
    // EV = p·dec − 1. ~12% of bets are left pending and don't count toward P&L.
    const targetRoi = (parseFloat(testEv) || 0) / 100

    const made = []
    let seq = 0
    // ~5 bets for every day of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const perDay = 4 + Math.floor(Math.random() * 3) // 4–6 bets/day
      for (let j = 0; j < perDay; j++) {
        const odds = rand(americanOdds)
        const dec = toDecimal(odds, 'american')
        const wager = Math.round((5 + Math.random() * 195) / 5) * 5 // $5–$200, step 5
        let result
        if (Math.random() < 0.12) result = 'pending'
        else {
          const p = Math.min(0.97, Math.max(0.03, (targetRoi + 1) / dec))
          result = Math.random() < p ? 'won' : 'lost'
        }
        made.push({
          id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random() + seq++),
          date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          description: rand(markets),
          sportsbook: rand(books),
          wager,
          odds: (odds > 0 ? '+' : '') + odds,
          fmt: 'american',
          dec,
          result,
          source: 'manual',
        })
      }
    }
    setBets(prev => [...prev, ...made])
    const evLabel = targetRoi === 0 ? 'break-even' : `${targetRoi > 0 ? '+' : ''}${(targetRoi * 100).toFixed(0)}% EV`
    setGenMsg(`Added ${made.length} random test bets (${evLabel}, ~5/day) to ${MONTHS[month]} ${year}.`)
  }

  function clearMonth() {
    if (!monthBets.length) return
    if (!window.confirm(`Delete all ${monthBets.length} bets in ${MONTHS[month]} ${year}?`)) return
    const ids = new Set(monthBets.map(b => b.id))
    setBets(prev => prev.filter(b => !ids.has(b.id)))
    setImportMsg(`Cleared ${MONTHS[month]} ${year}.`)
  }

  function clearAll() {
    if (!bets.length) return
    if (!window.confirm(`Delete ALL ${bets.length} bets across every month? This cannot be undone.`)) return
    setBets([])
    setImportMsg('Cleared all bets.')
  }

  /* ── Kalshi key (stored locally on this device) ── */
  function saveKalshiKey() {
    const id = kKeyId.trim()
    const pk = kPriv.trim()
    if (!id || !pk) { setSyncMsg('Enter both your Key ID and private key.'); return }
    try {
      localStorage.setItem(KALSHI_KEYID, id)
      localStorage.setItem(KALSHI_PRIVKEY, pk)
    } catch { /* ignore quota */ }
    setKKeyId(id)
    setKPriv(pk)
    setEditKalshi(false)
    setShowSecret(false)
    setSyncMsg('Kalshi key saved on this device.')
  }

  function removeKalshiKey() {
    if (!window.confirm('Remove your Kalshi key from this device?')) return
    try {
      localStorage.removeItem(KALSHI_KEYID)
      localStorage.removeItem(KALSHI_PRIVKEY)
    } catch { /* ignore */ }
    setKKeyId('')
    setKPriv('')
    setEditKalshi(true)
    setSyncMsg('Kalshi key removed.')
  }

  /* ── Kalshi sync (key signed server-side via Firebase Cloud Function) ── */
  async function syncKalshi() {
    if (!kKeyId || !kPriv) { setSyncMsg('Save your Kalshi key first.'); return }
    setSyncing(true)
    setSyncMsg('Syncing from Kalshi…')
    try {
      const [{ httpsCallable }, { functions }] = await Promise.all([
        import('firebase/functions'),
        import('../firebase.js'),
      ])
      const fn = httpsCallable(functions, 'syncKalshi')
      const { data } = await fn({ keyId: kKeyId, privateKey: kPriv })
      const incoming = Array.isArray(data?.bets) ? data.bets : []
      let added = 0
      setBets(prev => {
        const ids = new Set(prev.map(b => b.id))
        const fresh = incoming
          .filter(b => b && b.id && !ids.has(b.id))
          .map(b => ({ ...b, source: 'kalshi' }))
        added = fresh.length
        return [...prev, ...fresh]
      })
      setSyncMsg(`Kalshi sync complete — ${added} new bet${added === 1 ? '' : 's'} imported (${incoming.length} returned).`)
    } catch (e) {
      setSyncMsg(`Kalshi sync failed: ${e.message || e}. The syncKalshi Cloud Function must be deployed first — see KALSHI_SETUP.md.`)
    } finally {
      setSyncing(false)
    }
  }

  /* ── month math ── */
  const { year, month } = view
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const firstWeekday = new Date(year, month, 1).getDay()

  const monthBets = useMemo(
    () => bets.filter(b => {
      const [y, m] = b.date.split('-').map(Number)
      return y === year && m === month + 1
    }),
    [bets, year, month]
  )

  const counts = useMemo(() => {
    let manual = 0, kalshi = 0
    for (const b of monthBets) (b.source === 'kalshi' ? kalshi++ : manual++)
    return { manual, kalshi, all: monthBets.length }
  }, [monthBets])

  // bets visible under the current source tab
  const viewBets = useMemo(() => {
    if (sourceTab === 'all') return monthBets
    return monthBets.filter(b => (sourceTab === 'kalshi' ? b.source === 'kalshi' : b.source !== 'kalshi'))
  }, [monthBets, sourceTab])

  // per-day net P&L (settled only)
  const dayPnl = useMemo(() => {
    const map = {}
    for (const b of viewBets) {
      const day = Number(b.date.split('-')[2])
      map[day] = (map[day] || 0) + betProfit(b)
    }
    return map
  }, [viewBets])

  const dayCount = useMemo(() => {
    const map = {}
    for (const b of viewBets) {
      const day = Number(b.date.split('-')[2])
      map[day] = (map[day] || 0) + 1
    }
    return map
  }, [viewBets])

  // chart series
  const chartDays = useMemo(() => {
    const out = []
    let run = 0
    for (let d = 1; d <= daysInMonth; d++) {
      const daily = dayPnl[d] || 0
      run += daily
      out.push({ day: d, daily, cumulative: run })
    }
    return out
  }, [dayPnl, daysInMonth])

  // summary stats
  const stats = useMemo(() => {
    let wagered = 0, profit = 0, won = 0, lost = 0, settled = 0, pending = 0
    for (const b of viewBets) {
      if (b.result === 'pending') { pending++; continue }
      wagered += b.wager
      profit += betProfit(b)
      if (b.result === 'won') { won++; settled++ }
      else if (b.result === 'lost') { lost++; settled++ }
      else settled++ // push counts as settled but not W/L
    }
    const decided = won + lost
    return {
      wagered, profit, won, lost, settled, pending,
      winRate: decided ? (won / decided) * 100 : null,
      roi: wagered ? (profit / wagered) * 100 : null,
    }
  }, [viewBets])

  const hasChartData = viewBets.some(b => b.result !== 'pending')

  function changeMonth(delta) {
    setView(v => {
      const d = new Date(v.year, v.month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  const todayStr = todayISO()

  /* ── CSV import / export ── */
  function exportCsv() {
    const header = 'date,description,sportsbook,wager,odds,format,result'
    const rows = bets.map(b =>
      [b.date, `"${(b.description || '').replace(/"/g, '""')}"`, `"${(b.sportsbook || '').replace(/"/g, '""')}"`,
        b.wager, b.odds, b.fmt, b.result].join(','))
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'selene-bets.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // very small CSV parser (handles quoted fields)
  function parseCsv(text) {
    const rows = []
    let row = [], field = '', inQ = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
        else if (c === '"') inQ = false
        else field += c
      } else if (c === '"') inQ = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n' || c === '\r') {
        if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = '' }
        if (c === '\r' && text[i + 1] === '\n') i++
      } else field += c
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row) }
    return rows
  }

  function find(headers, ...names) {
    for (const name of names) {
      const idx = headers.findIndex(h => h === name)
      if (idx !== -1) return idx
    }
    return -1
  }

  function importCsv(e) {
    setImportMsg('')
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result)).filter(r => r.some(c => c.trim() !== ''))
        if (rows.length < 2) { setImportMsg('No data rows found in CSV.'); return }
        const headers = rows[0].map(h => h.trim().toLowerCase())
        const iDate = find(headers, 'date', 'placed', 'created', 'settled_time', 'created_time')
        const iDesc = find(headers, 'description', 'market', 'title', 'event', 'ticker')
        const iBook = find(headers, 'sportsbook', 'book', 'source', 'platform')
        const iWager = find(headers, 'wager', 'stake', 'amount', 'cost', 'risk')
        const iOdds = find(headers, 'odds', 'price', 'american', 'decimal')
        const iFmt = find(headers, 'format', 'odds_format')
        const iResult = find(headers, 'result', 'status', 'outcome')
        if (iDate === -1 || iWager === -1 || iOdds === -1) {
          setImportMsg('CSV needs at least date, wager, and odds columns. See the expected format note below.')
          return
        }
        const imported = []
        for (let r = 1; r < rows.length; r++) {
          const row = rows[r]
          const rawDate = (row[iDate] || '').trim()
          // normalize date to YYYY-MM-DD (accept ISO timestamps too)
          let date = rawDate.slice(0, 10)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            const parsed = new Date(rawDate)
            if (isNaN(parsed)) continue
            date = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
          }
          const wager = parseFloat(row[iWager])
          const fmt = iFmt !== -1 && (row[iFmt] || '').toLowerCase().includes('dec') ? 'decimal' : 'american'
          const dec = toDecimal(row[iOdds], fmt)
          if (!(wager > 0) || !dec) continue
          let result = iResult !== -1 ? (row[iResult] || '').trim().toLowerCase() : 'pending'
          if (['win', 'won', 'yes', 'settled_yes', 'profit'].some(k => result.includes(k))) result = 'won'
          else if (['loss', 'lost', 'no', 'settled_no'].some(k => result.includes(k))) result = 'lost'
          else if (result.includes('push') || result.includes('void') || result.includes('refund')) result = 'push'
          else result = 'pending'
          imported.push({
            id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random() + r),
            date,
            description: (iDesc !== -1 ? row[iDesc] : '').trim() || 'Imported bet',
            sportsbook: (iBook !== -1 ? row[iBook] : '').trim(),
            wager, odds: String(row[iOdds]).trim(), fmt, dec, result, source: 'manual',
          })
        }
        if (!imported.length) { setImportMsg('No valid rows could be imported.'); return }
        setBets(prev => [...prev, ...imported])
        setImportMsg(`Imported ${imported.length} bet${imported.length === 1 ? '' : 's'}.`)
      } catch {
        setImportMsg('Could not parse that file. Make sure it is a valid CSV.')
      } finally {
        if (fileRef.current) fileRef.current.value = ''
      }
    }
    reader.readAsText(file)
  }

  const resultBadge = { won: 'badge-green', lost: 'badge-red', push: 'badge-yellow', pending: 'badge-blue' }

  return (
    <div className="page wide">
      <div className="page-header">
        <h1>Bet Tracker</h1>
        <p>Log your bets, see daily profit and loss on a calendar, and chart your results across the month.</p>
      </div>

      {/* ── Source tabs ── */}
      <div className="ev-tabs bt-source-tabs">
        <button className={`ev-tab${sourceTab === 'all' ? ' active' : ''}`} onClick={() => setSourceTab('all')}>All ({counts.all})</button>
        <button className={`ev-tab${sourceTab === 'manual' ? ' active' : ''}`} onClick={() => setSourceTab('manual')}>Manual ({counts.manual})</button>
        <button className={`ev-tab${sourceTab === 'kalshi' ? ' active' : ''}`} onClick={() => setSourceTab('kalshi')}>Kalshi ({counts.kalshi})</button>
      </div>

      {/* ── Calendar (top) ── */}
      <div className="card">
        <div className="bt-month-nav">
          <button className="btn btn-outline btn-sm" onClick={() => changeMonth(-1)}>← Prev</button>
          <h2 style={{ margin: 0 }}>{MONTHS[month]} {year}</h2>
          <button className="btn btn-outline btn-sm" onClick={() => changeMonth(1)}>Next →</button>
        </div>
        <div className="bt-calendar">
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

      {/* ── Summary ── */}
      <div className="card">
        <h2>{MONTHS[month]} {year} — Summary</h2>
        <div className="result-grid">
          <div className="result-item"><div className="label">Net P&amp;L</div><div className={`value ${stats.profit >= 0 ? 'green' : 'red'}`}>{money(stats.profit)}</div></div>
          <div className="result-item"><div className="label">Total Wagered</div><div className="value">${stats.wagered.toFixed(2)}</div></div>
          <div className="result-item"><div className="label">ROI</div><div className={`value ${(stats.roi ?? 0) >= 0 ? 'green' : 'red'}`}>{stats.roi === null ? '—' : `${stats.roi >= 0 ? '+' : ''}${stats.roi.toFixed(1)}%`}</div></div>
          <div className="result-item"><div className="label">Win Rate</div><div className="value blue">{stats.winRate === null ? '—' : `${stats.winRate.toFixed(0)}%`}</div></div>
          <div className="result-item"><div className="label">Record (W-L)</div><div className="value yellow">{stats.won}–{stats.lost}{stats.pending ? ` · ${stats.pending} open` : ''}</div></div>
        </div>
      </div>

      {/* ── Add bets ── */}
      <div className="card">
        <h2>Add Bets</h2>
        <div className="bt-add-actions">
          <button className="btn btn-sm bt-action-btn" onClick={() => { setError(''); setForm(f => ({ ...f, date: todayISO() })); setShowManual(true) }}>+ Add Manual Bet</button>
          <button className="btn btn-outline btn-sm bt-action-btn" onClick={generateTestBets}>🎲 Add Random Bets (~5/day)</button>
          <div className="field" style={{ maxWidth: 170 }}>
            <label>Random bet EV (ROI %)</label>
            <input type="number" step="any" placeholder="5" value={testEv} onChange={e => setTestEv(e.target.value)} />
          </div>
        </div>
        {genMsg && <div className="info-box" style={{ marginTop: 14 }}>{genMsg}</div>}
      </div>

      {/* ── Connect Kalshi ── */}
      <div className="card">
        <h2>Connect Kalshi</h2>

        <button className="btn btn-outline btn-sm" style={{ width: 'auto', marginTop: 0 }} onClick={() => setShowTutorial(t => !t)}>
          {showTutorial ? 'Hide' : 'How do I get my Kalshi API key?'}
        </button>

        {showTutorial && (
          <div className="info-box" style={{ marginTop: 14 }}>
            <strong>Getting your Kalshi API key (one-time, on a computer):</strong>
            <ol className="bt-steps">
              <li>Log in to Kalshi in your browser and open <strong>Profile Settings</strong> (<code>kalshi.com/account/profile</code>).</li>
              <li>Scroll to the <strong>API Keys</strong> section and click <strong>Create New API Key</strong>.</li>
              <li>Kalshi shows you a <strong>Key ID</strong> and a one-time <strong>Private Key</strong> (and downloads a <code>.txt</code> file). <strong>Copy the private key now</strong> — Kalshi will not show it again.</li>
              <li>Paste the <strong>Key ID</strong> and the <strong>full private key</strong> (including the <code>-----BEGIN…</code> and <code>-----END…</code> lines) into the boxes below, then click <strong>Save key</strong>.</li>
            </ol>
            Lost the private key? Just create a new one — the old one keeps working until you delete it.
          </div>
        )}

        {kalshiConnected ? (
          <div style={{ marginTop: 16 }}>
            <div className="info-box" style={{ borderColor: 'rgba(63,185,80,0.4)', background: 'rgba(63,185,80,0.08)', color: 'var(--accent-green)' }}>
              ✓ Kalshi key saved on this device (Key ID ending <strong>…{kKeyId.slice(-6)}</strong>). Your private key never leaves your browser except to sign a sync request.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button className="btn btn-sm bt-action-btn" onClick={syncKalshi} disabled={syncing}>{syncing ? 'Syncing…' : '🔄 Sync Kalshi bets'}</button>
              <button className="btn btn-outline btn-sm" onClick={() => { setShowSecret(false); setEditKalshi(true) }}>Replace key</button>
              <button className="btn btn-outline btn-sm" onClick={removeKalshiKey}>Remove key</button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Kalshi Key ID</label>
              <input
                type={showSecret ? 'text' : 'password'}
                placeholder="e.g. 1a2b3c4d-…"
                value={kKeyId}
                onChange={e => setKKeyId(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label>Kalshi Private Key (PEM)</label>
              <textarea
                className="bt-secret"
                rows={4}
                placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;…&#10;-----END RSA PRIVATE KEY-----"
                value={kPriv}
                onChange={e => setKPriv(e.target.value)}
                style={!showSecret ? { WebkitTextSecurity: 'disc' } : undefined}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <label className="bt-show-toggle">
              <input type="checkbox" checked={showSecret} onChange={e => setShowSecret(e.target.checked)} /> Show key while typing
            </label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <button className="btn btn-sm bt-action-btn" onClick={saveKalshiKey}>Save key</button>
              {kKeyId && kPriv && localStorage.getItem(KALSHI_KEYID) && (
                <button className="btn btn-outline btn-sm" onClick={() => { setEditKalshi(false); setShowSecret(false) }}>Cancel</button>
              )}
            </div>
          </div>
        )}

        {syncMsg && <div className="info-box" style={{ marginTop: 14 }}>{syncMsg}</div>}

        <div className="info-box" style={{ marginTop: 14 }}>
          Your key is stored only in this browser (localStorage). Syncing sends it once to your Firebase Cloud Function (which signs the request and is never stored there) — deploy <code>functions/syncKalshi</code> first; see <strong>KALSHI_SETUP.md</strong>. No backend yet? Use <strong>Import CSV</strong> below instead.
        </div>
      </div>

      {/* ── Chart ── */}
      <div className="card">
        <div className="bt-month-nav">
          <h2 style={{ margin: 0 }}>Profit / Loss — {MONTHS[month]}</h2>
          <div className="format-toggle" style={{ margin: 0 }}>
            <button className={`format-btn${chartMode === 'cumulative' ? ' active' : ''}`} onClick={() => setChartMode('cumulative')}>Cumulative</button>
            <button className={`format-btn${chartMode === 'daily' ? ' active' : ''}`} onClick={() => setChartMode('daily')}>Daily</button>
          </div>
        </div>
        {hasChartData
          ? <MonthChart days={chartDays} mode={chartMode} />
          : <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No settled bets this month yet. Add bets and mark them won or lost to see your P&amp;L curve.</p>}
      </div>

      {/* ── Bet list ── */}
      <div className="card">
        <h2>Bets — {MONTHS[month]} {year}{sourceTab !== 'all' ? ` · ${sourceTab === 'kalshi' ? 'Kalshi' : 'Manual'}` : ''}</h2>
        {viewBets.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No bets to show under this tab.</p>
        ) : (
          <table className="result-table">
            <thead>
              <tr><th>Date</th><th>Bet</th><th>Source</th><th>Wager</th><th>Odds</th><th>Result</th><th>P&amp;L</th><th></th></tr>
            </thead>
            <tbody>
              {[...viewBets].sort((a, b) => a.date.localeCompare(b.date)).map(b => {
                const p = betProfit(b)
                return (
                  <tr key={b.id}>
                    <td>{b.date.slice(5)}</td>
                    <td>{b.description}</td>
                    <td>
                      <span className={`badge ${b.source === 'kalshi' ? 'badge-blue' : 'badge-yellow'}`} title={b.sportsbook || ''}>
                        {b.source === 'kalshi' ? 'Kalshi' : (b.sportsbook || 'Manual')}
                      </span>
                    </td>
                    <td>${b.wager.toFixed(2)}</td>
                    <td>{b.odds}</td>
                    <td>
                      <button className={`badge ${resultBadge[b.result]}`} style={{ cursor: 'pointer', border: 'none' }} onClick={() => cycleResult(b.id)} title="Click to change result">
                        {b.result.charAt(0).toUpperCase() + b.result.slice(1)}
                      </button>
                    </td>
                    <td style={{ color: b.result === 'pending' ? 'var(--text-muted)' : p > 0 ? 'var(--accent-green)' : p < 0 ? 'var(--accent-red)' : 'var(--text)', fontWeight: 600 }}>
                      {b.result === 'pending' ? '—' : money(p)}
                    </td>
                    <td><button className="bt-del" onClick={() => removeBet(b.id)} title="Delete bet">✕</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Import / Export ── */}
      <div className="card">
        <h2>Import &amp; Export</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>Import CSV</button>
          <button className="btn btn-outline btn-sm" onClick={exportCsv} disabled={bets.length === 0}>Export CSV</button>
          <button className="btn btn-outline btn-sm" onClick={clearMonth} disabled={monthBets.length === 0}>Clear Month</button>
          <button className="btn btn-outline btn-sm" onClick={clearAll} disabled={bets.length === 0}>Clear All Bets</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={importCsv} style={{ display: 'none' }} />
        </div>
        {importMsg && <div className="info-box" style={{ marginTop: 14 }}>{importMsg}</div>}
        <div className="info-box" style={{ marginTop: 14 }}>
          <strong>Import CSV</strong> works for any sportsbook export (or Kalshi, if you'd rather not connect a key): the importer matches columns by name — <strong>date</strong>, <strong>wager</strong> (or stake/amount/cost), and <strong>odds</strong> (or price), plus optional <strong>description</strong>, <strong>sportsbook</strong>, <strong>format</strong>, and <strong>result</strong>. Clear Month / Clear All Bets remove what's stored locally.
        </div>
      </div>

      <div className="card">
        <h2>About This Tracker</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 14, color: 'var(--text-muted)' }}>
          <div><strong style={{ color: 'var(--text)' }}>Your data stays local</strong><br />Bets are saved in your browser (localStorage) on this device only — nothing is uploaded to a server. Use Export CSV to back up or move your data.</div>
          <div><strong style={{ color: 'var(--text)' }}>P&amp;L math</strong><br />Won bets profit = wager × (decimal odds − 1); lost bets lose the wager; pushes and pending bets count as $0. ROI is net profit ÷ total wagered on settled bets.</div>
          <div><strong style={{ color: 'var(--text)' }}>Quick edits</strong><br />Click any result badge in the table to cycle Pending → Won → Lost → Push.</div>
        </div>
      </div>

      {/* ── Manual entry modal ── */}
      {showManual && (
        <div className="bt-modal-overlay" onClick={() => setShowManual(false)}>
          <div className="bt-modal card" onClick={e => e.stopPropagation()}>
            <div className="bt-month-nav">
              <h2 style={{ margin: 0 }}>Add a Manual Bet</h2>
              <button className="bt-del" style={{ fontSize: 18 }} onClick={() => setShowManual(false)} title="Close">✕</button>
            </div>
            <div className="format-toggle">
              {['american', 'decimal'].map(f => (
                <button key={f} type="button" className={`format-btn${oddsFmt === f ? ' active' : ''}`} onClick={() => setOddsFmt(f)}>
                  {f.charAt(0).toUpperCase() + f.slice(1)} odds
                </button>
              ))}
            </div>
            <form onSubmit={addBet}>
              <div className="field-group">
                <div className="field">
                  <label>Date</label>
                  <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Bet / Market</label>
                  <input type="text" placeholder="e.g. Lakers ML" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Sportsbook / Platform</label>
                  <input type="text" placeholder="e.g. Kalshi, DraftKings" value={form.sportsbook} onChange={e => setForm(f => ({ ...f, sportsbook: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Wager ($)</label>
                  <input type="number" placeholder="100" min="0.01" step="0.01" value={form.wager} onChange={e => setForm(f => ({ ...f, wager: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Odds</label>
                  <input type="number" placeholder={oddsFmt === 'american' ? '-110' : '1.91'} step="any" value={form.odds} onChange={e => setForm(f => ({ ...f, odds: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Result</label>
                  <select value={form.result} onChange={e => setForm(f => ({ ...f, result: e.target.value }))}>
                    <option value="pending">Pending</option>
                    <option value="won">Won</option>
                    <option value="lost">Lost</option>
                    <option value="push">Push / Void</option>
                  </select>
                </div>
              </div>
              {error && <div className="info-box" style={{ borderColor: 'rgba(248,81,73,0.4)', background: 'rgba(248,81,73,0.08)', color: 'var(--accent-red)' }}>{error}</div>}
              <button className="btn" type="submit">Add Bet</button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

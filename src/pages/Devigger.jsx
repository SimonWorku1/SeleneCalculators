import { useState } from 'react'

function toDecimal(val, fmt) {
  const n = parseFloat(val)
  if (isNaN(n)) return null
  if (fmt === 'decimal') return n > 1 ? n : null
  if (n >= 100) return n / 100 + 1
  if (n <= -100) return 100 / Math.abs(n) + 1
  return null
}

function fmtAmerican(dec) {
  if (dec >= 2) return '+' + Math.round((dec - 1) * 100)
  return String(Math.round(-100 / (dec - 1)))
}

function normCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911
  const sign = x < 0 ? -1 : 1
  const t = 1 / (1 + p * Math.abs(x) / Math.sqrt(2))
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-(x*x)/2)
  return 0.5 * (1 + sign * y)
}

function normInv(p) {
  const a = [-3.969683028665376e1,2.209460984245205e2,-2.759285104469687e2,1.383577518672690e2,-3.066479806614716e1,2.506628277459239]
  const b = [-5.447609879822406e1,1.615858368580409e2,-1.556989798598866e2,6.680131188771972e1,-1.328068155288572e1]
  const c = [-7.784894002430293e-3,-3.223964580411365e-1,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783]
  const d = [7.784695709041462e-3,3.224671290700398e-1,2.445134137142996,3.754408661907416]
  const plo = 0.02425, phi = 1 - plo
  let q, r
  if (p < plo) {
    q = Math.sqrt(-2*Math.log(p))
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  } else if (p <= phi) {
    q = p - 0.5; r = q*q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
  } else {
    q = Math.sqrt(-2*Math.log(1-p))
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  }
}

function devig(probs, method) {
  const total = probs.reduce((a, b) => a + b, 0)
  const overround = total - 1

  if (method === 'multiplicative') return probs.map(p => p / total)

  if (method === 'additive') {
    const share = overround / probs.length
    return probs.map(p => p - share)
  }

  if (method === 'power') {
    let lo = 0.5, hi = 1.5
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2
      probs.reduce((a, p) => a + Math.pow(p, mid), 0) > 1 ? (lo = mid) : (hi = mid)
    }
    const k = (lo + hi) / 2
    const fair = probs.map(p => Math.pow(p, k))
    const s = fair.reduce((a, b) => a + b, 0)
    return fair.map(p => p / s)
  }

  if (method === 'probit') {
    const z = probs.map(p => normInv(Math.min(Math.max(p, 0.0001), 0.9999)))
    let lo = -3, hi = 3
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2
      z.reduce((a, zi) => a + normCDF(zi - mid), 0) > 1 ? (lo = mid) : (hi = mid)
    }
    const k = (lo + hi) / 2
    const fair = z.map(zi => normCDF(zi - k))
    const s = fair.reduce((a, b) => a + b, 0)
    return fair.map(p => p / s)
  }

  if (method === 'worstcase') {
    const fair = probs.map(p => Math.max(0, p - overround))
    const s = fair.reduce((a, b) => a + b, 0)
    return s > 0 ? fair.map(p => p / s) : probs.map(p => p / total)
  }

  return probs.map(p => p / total)
}

const METHODS = [
  { value: 'multiplicative', label: 'Multiplicative' },
  { value: 'additive',       label: 'Additive' },
  { value: 'power',          label: 'Power' },
  { value: 'probit',         label: 'Probit' },
  { value: 'worstcase',      label: 'Worst Case' },
]

let _id = 3

export default function Devigger() {
  const [fmt, setFmt] = useState('american')
  const [method, setMethod] = useState('multiplicative')
  const [kellyMult, setKellyMult] = useState('0.25')
  const [kellyBankroll, setKellyBankroll] = useState('1000')
  const [legs, setLegs] = useState([
    { id: 1, a: '', b: '' },
  ])
  const [finalOdds, setFinalOdds] = useState('')

  function addLeg() { setLegs(p => [...p, { id: _id++, a: '', b: '' }]) }
  function removeLeg(id) { if (legs.length > 1) setLegs(p => p.filter(l => l.id !== id)) }
  function updateLeg(id, f, v) { setLegs(p => p.map(l => l.id === id ? { ...l, [f]: v } : l)) }

  const legResults = legs.map(leg => {
    const dA = toDecimal(leg.a, fmt), dB = toDecimal(leg.b, fmt)
    if (!dA || !dB) return null
    const pA = 1 / dA, pB = 1 / dB
    const juice = (pA + pB - 1) * 100
    const [fA] = devig([pA, pB], method)
    return { juice, fA, fairOdds: fmtAmerican(1 / fA), fairPct: (fA * 100).toFixed(1) }
  })

  const allValid = legResults.every(r => r !== null)

  const totalJuice = allValid ? legResults.reduce((s, r) => s + r.juice, 0) : null
  const fairParlay = allValid ? legResults.reduce((p, r) => p * r.fA, 1) : null
  const fairParlayOdds = fairParlay ? fmtAmerican(1 / fairParlay) : null

  const finalDec = toDecimal(finalOdds, fmt)
  let ev = null, kellyBet = null, kellyPctStr = null
  if (fairParlay && finalDec) {
    ev = (fairParlay * finalDec - 1) * 100
    const b = finalDec - 1
    const kelly = Math.max(0, (b * fairParlay - (1 - fairParlay)) / b) * (parseFloat(kellyMult) || 0.25)
    kellyBet = (kelly * (parseFloat(kellyBankroll) || 1000)).toFixed(2)
    kellyPctStr = (kelly * 100).toFixed(2)
  }

  const methodLabel = METHODS.find(m => m.value === method)?.label

  return (
    <div className="page">
      <div className="page-header">
        <h1>Devigger</h1>
        <p>Remove the bookmaker's margin to find true no-vig probabilities and fair odds.</p>
      </div>

      {/* Settings */}
      <div className="card">
        <div className="dv-settings">
          <div className="dv-sg">
            <label>Format</label>
            <div className="format-toggle" style={{ margin: 0 }}>
              {['american', 'decimal'].map(f => (
                <button key={f} className={`format-btn${fmt === f ? ' active' : ''}`} onClick={() => setFmt(f)}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="dv-sg">
            <label>Devig Method</label>
            <select value={method} onChange={e => setMethod(e.target.value)} style={{ width: 'auto' }}>
              {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div className="dv-sg">
            <label>Kelly Multiplier</label>
            <input type="number" value={kellyMult} min="0.01" max="1" step="0.05"
              onChange={e => setKellyMult(e.target.value)} style={{ width: 70 }} />
          </div>
          <div className="dv-sg">
            <label>Kelly Bankroll $</label>
            <input type="number" value={kellyBankroll} min="1"
              onChange={e => setKellyBankroll(e.target.value)} style={{ width: 90 }} />
          </div>
        </div>
      </div>

      {/* Legs */}
      <div className="card">
        <h2>
          Leg Odds
          <span className="dv-subhead">Your Side / Other Side</span>
        </h2>
        <div className="dv-legs">
          {legs.map((leg, i) => (
            <div key={leg.id} className="dv-leg">
              <div className="dv-leg-inputs">
                <span className="dv-leg-num">Leg {i + 1}</span>
                <input type="number" className="dv-leg-inp"
                  placeholder={fmt === 'american' ? '-110' : '1.91'}
                  value={leg.a} onChange={e => updateLeg(leg.id, 'a', e.target.value)} />
                <span className="dv-sep">/</span>
                <input type="number" className="dv-leg-inp"
                  placeholder={fmt === 'american' ? '-110' : '1.91'}
                  value={leg.b} onChange={e => updateLeg(leg.id, 'b', e.target.value)} />
                {legs.length > 1 && (
                  <button className="dv-rm" onClick={() => removeLeg(leg.id)}>✕</button>
                )}
              </div>
              {legResults[i] && (
                <div className="dv-leg-out">
                  Market Juice = <strong>{legResults[i].juice.toFixed(2)}%</strong>
                  <span className="dv-dot"> · </span>
                  Fair Value = <strong className="dv-green">{legResults[i].fairOdds}</strong>
                  <span className="dv-muted"> ({legResults[i].fairPct}%)</span>
                </div>
              )}
            </div>
          ))}
        </div>
        <button className="btn btn-sm btn-outline" onClick={addLeg} style={{ marginTop: 12 }}>+ Add Leg</button>
      </div>

      {/* Final / parlay odds */}
      <div className="card">
        <h2>{legs.length > 1 ? 'Final Parlay Odds' : 'Final Odds'}</h2>
        <p className="dv-hint">
          {legs.length > 1
            ? 'Enter the offered parlay price to calculate EV and Kelly bet size.'
            : 'Enter the offered odds on this bet to calculate EV and Kelly bet size.'}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <input type="number" style={{ maxWidth: 180 }}
            placeholder={fmt === 'american' ? 'e.g. +264' : 'e.g. 3.64'}
            value={finalOdds} onChange={e => setFinalOdds(e.target.value)} />
          {allValid && !finalOdds && fairParlayOdds && (
            <span className="dv-hint" style={{ margin: 0 }}>
              Fair value: <strong>{fairParlayOdds}</strong> ({fairParlay ? (fairParlay * 100).toFixed(1) : '—'}%)
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      {allValid && (
        <div className="card">
          <h2>
            Results
            <span className="dv-subhead">{methodLabel}</span>
          </h2>
          <div className="dv-res-list">
            {legs.map((leg, i) => (
              <div key={leg.id} className="dv-res-row">
                <span className="dv-res-tag">Leg #{i + 1} ({leg.a})</span>
                <span>Market Juice = <strong>{legResults[i].juice.toFixed(2)}%</strong></span>
                <span>Fair Value = <strong className="dv-green">{legResults[i].fairOdds}</strong> ({legResults[i].fairPct}%)</span>
              </div>
            ))}

            {legs.length > 1 && (
              <div className="dv-res-row dv-res-parlay">
                <span className="dv-res-tag">Final Odds ({fairParlayOdds})</span>
                <span>Σ(Market Juice) = <strong>{totalJuice.toFixed(2)}%</strong></span>
                <span>Fair Value = <strong className="dv-green">{fairParlayOdds}</strong> ({(fairParlay * 100).toFixed(1)}%)</span>
              </div>
            )}

            {ev !== null && (
              <div className="dv-res-row dv-res-summary">
                <span className="dv-res-tag">Summary</span>
                <span>EV% = <strong className={ev >= 0 ? 'dv-green' : 'dv-red'}>{ev >= 0 ? '+' : ''}{ev.toFixed(2)}%</strong></span>
                <span>Kelly Bet = <strong>${kellyBet}</strong> ({kellyPctStr}% of bankroll)</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* About methods */}
      <div className="card">
        <h2>About Devig Methods</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 14, color: 'var(--text-muted)' }}>
          <div><strong style={{ color: 'var(--text)' }}>Multiplicative</strong><br />Scales each implied probability proportionally so they sum to 100%. Most common method.</div>
          <div><strong style={{ color: 'var(--text)' }}>Additive</strong><br />Subtracts an equal share of overround from each implied probability.</div>
          <div><strong style={{ color: 'var(--text)' }}>Power</strong><br />Finds exponent k such that Σp_i^k = 1. Generally most accurate for heavily-vig'd markets.</div>
          <div><strong style={{ color: 'var(--text)' }}>Probit</strong><br />Transforms implied probs via inverse normal CDF, shifts to sum to 100%, then transforms back. Accurate for balanced two-way markets.</div>
          <div><strong style={{ color: 'var(--text)' }}>Worst Case</strong><br />Assumes the full overround is against you — gives the most conservative fair probability.</div>
        </div>
      </div>
    </div>
  )
}

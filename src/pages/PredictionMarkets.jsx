import { useState } from 'react'

function probToAmerican(p) {
  if (p >= 0.5) return -(p / (1 - p)) * 100
  return ((1 - p) / p) * 100
}
function americanToDecimal(a) {
  if (a >= 100) return a / 100 + 1
  return 100 / Math.abs(a) + 1
}
function probToDecimal(p) { return 1 / p }
function toFractional(p) {
  const x = (1 - p) / p
  let lo = [0, 1], hi = [1, 0]
  for (let i = 0; i < 1000; i++) {
    const mid = [lo[0] + hi[0], lo[1] + hi[1]]
    if (mid[1] > 200) {
      const best = Math.abs(lo[0] / lo[1] - x) <= Math.abs(hi[0] / hi[1] - x) ? lo : hi
      return `${best[0]}/${best[1]}`
    }
    const v = mid[0] / mid[1]
    if (Math.abs(v - x) < 1e-8) return `${mid[0]}/${mid[1]}`
    if (v < x) lo = mid; else hi = mid
  }
  return `${lo[0]}/${lo[1]}`
}
function formatAmerican(a) {
  const r = Math.round(a)
  if (r >= 0 || r === -100) return `+${Math.abs(r)}`
  return String(r)
}
function parseFractional(str) {
  const parts = str.split('/')
  if (parts.length !== 2) return null
  const num = parseFloat(parts[0])
  const den = parseFloat(parts[1])
  if (isNaN(num) || isNaN(den) || den === 0) return null
  return 1 / (1 + num / den)
}

const REF_PROBS = [5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95]

function InfoTip({ text }) {
  return (
    <span className="info-tip">
      <span className="info-tip-icon">i</span>
      <span className="info-tip-box">{text}</span>
    </span>
  )
}



const EMPTY = { cents: '', american: '', decimal: '', frac: '' }

export default function PredictionMarkets() {
  const [vals, setVals] = useState(EMPTY)

  function handleChange(field, raw) {
    let p = null

    if (field === 'cents') {
      const v = parseFloat(raw)
      if (!isNaN(v) && v > 0 && v < 100) p = v / 100
    } else if (field === 'american') {
      const a = parseFloat(raw)
      if (!isNaN(a) && (a >= 100 || a <= -100)) p = 1 / americanToDecimal(a)
    } else if (field === 'decimal') {
      const d = parseFloat(raw)
      if (!isNaN(d) && d > 1) p = 1 / d
    } else if (field === 'frac') {
      p = parseFractional(raw)
    }

    const next = { ...vals, [field]: raw }
    if (p !== null && p > 0 && p < 1) {
      if (field !== 'cents')    next.cents    = String(Math.round(p * 100))
      if (field !== 'american') next.american = formatAmerican(probToAmerican(p))
      if (field !== 'decimal')  next.decimal  = probToDecimal(p).toFixed(2)
      if (field !== 'frac')     next.frac     = toFractional(p)
    }
    setVals(next)
  }

  const centsNum = parseFloat(vals.cents)
  const activeRow = !isNaN(centsNum) ? Math.round(centsNum) : null

  return (
    <div className="page">
      <div className="page-header">
        <h1>Prediction Markets Converter</h1>
        <p>Enter any value to convert — all fields update together.</p>
      </div>

      <div className="card">
        <div className="field" style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            Prediction Market Price (cents)
            <InfoTip text="A number from 1–99 representing the market price in cents (e.g. 65 = 65% implied probability)." />
          </label>
          <input
            type="number"
            placeholder="e.g. 65"
            min="1"
            max="99"
            value={vals.cents}
            onChange={e => handleChange('cents', e.target.value)}
            style={{ fontSize: 18 }}
          />
        </div>

        <div className="pm-outputs">
          <div className="pm-output">
            <div className="pm-output-label">American Odds <InfoTip text="≥ +100 for underdogs or ≤ −100 for favorites (e.g. +200, −150)." /></div>
            <input
              type="text"
              placeholder="e.g. -186"
              value={vals.american}
              onChange={e => handleChange('american', e.target.value)}
            />
          </div>
          <div className="pm-output">
            <div className="pm-output-label">Decimal Odds <InfoTip text="Any number greater than 1 (e.g. 1.5385). Represents total return per $1 staked." /></div>
            <input
              type="number"
              placeholder="e.g. 1.5385"
              step="0.0001"
              value={vals.decimal}
              onChange={e => handleChange('decimal', e.target.value)}
            />
          </div>
          <div className="pm-output">
            <div className="pm-output-label">Fractional Odds <InfoTip text="Format: numerator/denominator (e.g. 7/13). Represents profit relative to stake." /></div>
            <input
              type="text"
              placeholder="e.g. 7/13"
              value={vals.frac}
              onChange={e => handleChange('frac', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Quick Reference</h2>
        <table className="result-table">
          <thead>
            <tr><th>Price (¢)</th><th>American</th><th>Decimal</th><th>Fractional</th></tr>
          </thead>
          <tbody>
            {REF_PROBS.map(pct => {
              const prob = pct / 100
              return (
                <tr key={pct} className={activeRow === pct ? 'active-row' : ''}>
                  <td>{pct}¢</td>
                  <td>{formatAmerican(probToAmerican(prob))}</td>
                  <td>{probToDecimal(prob).toFixed(2)}</td>
                  <td>{toFractional(prob)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

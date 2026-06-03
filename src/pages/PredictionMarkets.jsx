import { useState } from 'react'

function probToAmerican(p) {
  if (p >= 0.5) return -(p / (1 - p)) * 100
  return ((1 - p) / p) * 100
}
function probToDecimal(p) { return 1 / p }
function getGCD(a, b) { return b === 0 ? a : getGCD(b, a % b) }
function toFractional(p) {
  const num = Math.round(((1 - p) / p) * 100)
  const denom = 100
  const gcd = getGCD(num, denom)
  return `${num / gcd}/${denom / gcd}`
}
function formatAmerican(a) {
  return a >= 0 ? `+${a.toFixed(0)}` : `${a.toFixed(0)}`
}

const REF_PROBS = [5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95]

export default function PredictionMarkets() {
  const [cents, setCents] = useState('')

  const p = parseFloat(cents) / 100
  const valid = !isNaN(p) && p > 0 && p < 1

  const american = valid ? formatAmerican(probToAmerican(p)) : '—'
  const decimal  = valid ? probToDecimal(p).toFixed(2) : '—'
  const frac     = valid ? toFractional(p) : '—'

  return (
    <div className="page">
      <div className="page-header">
        <h1>Prediction Markets Converter</h1>
        <p>Enter a prediction market price to convert to sports-book odds formats.</p>
      </div>

      <div className="card">
        <div className="field">
          <label style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>
            Prediction Market Price (cents)
          </label>
          <input
            type="number"
            placeholder="e.g. 65"
            min="1"
            max="99"
            step="1"
            value={cents}
            onChange={e => setCents(e.target.value)}
            style={{ fontSize: 18 }}
            autoFocus
          />
        </div>

        <div className="pm-outputs">
          <div className="pm-output">
            <div className="pm-output-label">American Odds</div>
            <div className={`pm-output-value${valid ? '' : ' placeholder'}`}>{american}</div>
          </div>
          <div className="pm-output">
            <div className="pm-output-label">Decimal Odds</div>
            <div className={`pm-output-value${valid ? '' : ' placeholder'}`}>{decimal}</div>
          </div>
          <div className="pm-output">
            <div className="pm-output-label">Fractional Odds</div>
            <div className={`pm-output-value${valid ? '' : ' placeholder'}`}>{frac}</div>
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
                <tr key={pct} className={cents === String(pct) ? 'active-row' : ''}>
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

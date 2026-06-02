import { useState } from 'react'

const NAMES = ['Home / Team A', 'Away / Team B', 'Draw']

function toDecimal(val, fmt) {
  const n = parseFloat(val)
  if (isNaN(n)) return null
  if (fmt === 'decimal') return n > 1 ? n : null
  if (n >= 100) return n / 100 + 1
  if (n <= -100) return 100 / Math.abs(n) + 1
  return null
}

function formatOdds(dec, fmt) {
  if (fmt === 'decimal') return dec.toFixed(3)
  if (dec >= 2) return '+' + Math.round((dec - 1) * 100)
  return String(Math.round(-100 / (dec - 1)))
}

function devig(probs, method) {
  const total = probs.reduce((a, b) => a + b, 0)
  if (method === 'multiplicative') return probs.map(p => p / total)
  if (method === 'additive') {
    const share = (total - 1) / probs.length
    return probs.map(p => p - share)
  }
  // power/shin
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

export default function Devigger() {
  const [fmt, setFmt] = useState('american')
  const [method, setMethod] = useState('multiplicative')
  const [size, setSize] = useState(2)
  const [outcomes, setOutcomes] = useState([
    { name: 'Home / Team A', odds: '' },
    { name: 'Away / Team B', odds: '' },
  ])

  function setMarket(n) {
    setSize(n)
    setOutcomes(Array.from({ length: n }, (_, i) => ({ name: NAMES[i], odds: '' })))
  }

  function update(i, field, val) {
    setOutcomes(prev => prev.map((o, j) => j === i ? { ...o, [field]: val } : o))
  }

  const decimals = outcomes.map(o => toDecimal(o.odds, fmt))
  const allValid = decimals.every(d => d !== null)
  let res = null
  if (allValid) {
    const imp = decimals.map(d => 1 / d)
    const total = imp.reduce((a, b) => a + b, 0)
    const vig = (total - 1) * 100
    const fair = devig(imp, method)
    res = { imp, total, vig, fair }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Devigger / No-Vig Fair Odds Calculator</h1>
        <p>Remove the bookmaker's margin (vig/juice) from any market to find the true implied probability and fair no-vig odds for each outcome.</p>
      </div>

      <div className="card">
        <h2>Settings</h2>
        <div className="field-group">
          <div className="field">
            <label>Odds Format</label>
            <div className="format-toggle">
              {['american','decimal'].map(f => (
                <button key={f} className={`format-btn${fmt === f ? ' active' : ''}`} onClick={() => setFmt(f)}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Devig Method</label>
            <select value={method} onChange={e => setMethod(e.target.value)}>
              <option value="multiplicative">Multiplicative (Standard)</option>
              <option value="additive">Additive</option>
              <option value="power">Power / Shin</option>
            </select>
          </div>
          <div className="field">
            <label>Market Type</label>
            <div className="format-toggle">
              {[2, 3].map(n => (
                <button key={n} className={`format-btn${size === n ? ' active' : ''}`} onClick={() => setMarket(n)}>{n}-Way</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Market Odds</h2>
        {outcomes.map((o, i) => (
          <div key={i} className="field-group" style={{ marginBottom: 12 }}>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>{NAMES[i]}</label>
              <input type="text" value={o.name} onChange={e => update(i, 'name', e.target.value)} placeholder="Label" />
            </div>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>Odds</label>
              <input type="number" value={o.odds} onChange={e => update(i, 'odds', e.target.value)} placeholder={fmt === 'american' ? 'e.g. -110' : 'e.g. 1.91'} />
            </div>
          </div>
        ))}
      </div>

      {res && (
        <div className="card">
          <h2>Results</h2>
          <div className="result-grid">
            <div className="result-item"><div className="label">Total Overround</div><div className="value red">{(res.total * 100).toFixed(2)}%</div></div>
            <div className="result-item"><div className="label">Book Margin (Vig)</div><div className="value yellow">{res.vig.toFixed(2)}%</div></div>
            <div className="result-item"><div className="label">Vig Per Side</div><div className="value yellow">~{(res.vig / size).toFixed(2)}%</div></div>
            <div className="result-item"><div className="label">Method</div><div className="value blue" style={{ fontSize: 14, textTransform: 'capitalize' }}>{method}</div></div>
          </div>
          <table className="result-table" style={{ marginTop: 20 }}>
            <thead><tr><th>Outcome</th><th>Book Odds</th><th>Implied Prob</th><th>Fair Prob</th><th>Fair Odds</th></tr></thead>
            <tbody>
              {outcomes.map((o, i) => (
                <tr key={i}>
                  <td><strong>{o.name}</strong></td>
                  <td>{formatOdds(decimals[i], fmt)}</td>
                  <td>{(res.imp[i] * 100).toFixed(2)}%</td>
                  <td><strong>{(res.fair[i] * 100).toFixed(2)}%</strong></td>
                  <td style={{ color: 'var(--accent-green)', fontWeight: 600 }}>{formatOdds(1 / res.fair[i], fmt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="info-box">
            <strong>How to read this:</strong> The book holds a <strong>{res.vig.toFixed(2)}%</strong> margin. After removing the vig via the <em>{method}</em> method, fair probabilities sum to exactly 100%. If the odds you're offered beat the <strong>Fair Odds</strong> column, you have a +EV bet.
          </div>
        </div>
      )}

      <div className="card">
        <h2>About Devig Methods</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 14, color: 'var(--text-muted)' }}>
          <div><strong style={{ color: 'var(--text)' }}>Multiplicative (Standard)</strong><br />Scales each implied probability proportionally so they sum to 100%.</div>
          <div><strong style={{ color: 'var(--text)' }}>Additive</strong><br />Subtracts an equal share of overround from each implied probability.</div>
          <div><strong style={{ color: 'var(--text)' }}>Power / Shin</strong><br />Solves for the margin analytically — generally most accurate for heavily-vig'd markets.</div>
        </div>
      </div>
    </div>
  )
}

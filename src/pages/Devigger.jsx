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
  if (dec >= 2) return '+' + (dec - 1) * 100 |0
  return String((-100 / (dec - 1)) |0)
}

// Normal CDF approximation
function normCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911
  const sign = x < 0 ? -1 : 1
  const t = 1 / (1 + p * Math.abs(x) / Math.sqrt(2))
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-(x*x)/2)
  return 0.5 * (1 + sign * y)
}

// Inverse normal CDF (rational approximation)
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
  { value: 'probit',         label: 'Probit' },
  { value: 'multiplicative', label: 'Multiplicative' },
  { value: 'additive',       label: 'Additive' },
  { value: 'power',          label: 'Power' },
  { value: 'worstcase',      label: 'Worst Case' },
]

export default function Devigger() {
  const [fmt, setFmt] = useState('american')
  const [method, setMethod] = useState('probit')
  const [size, setSize] = useState(2)
  const [outcomes, setOutcomes] = useState([
    { odds: '' },
    { odds: '' },
  ])

  function setMarket(n) {
    setSize(n)
    setOutcomes(Array.from({ length: n }, () => ({ odds: '' })))
  }

  function updateOdds(i, val) {
    setOutcomes(prev => prev.map((o, j) => j === i ? { ...o, odds: val } : o))
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
        <h1>Devigger</h1>
        <p>Remove the bookmaker's margin to find true no-vig probabilities and fair odds.</p>
      </div>

      <div className="card">
        <div className="dv-toolbar">
          <div className="format-toggle" style={{ margin: 0 }}>
            {['american', 'decimal'].map(f => (
              <button key={f} className={`format-btn${fmt === f ? ' active' : ''}`} onClick={() => setFmt(f)}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <select value={method} onChange={e => setMethod(e.target.value)} style={{ width: 'auto' }}>
            {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>

          <div className="format-toggle" style={{ margin: 0 }}>
            {[2, 3].map(n => (
              <button key={n} className={`format-btn${size === n ? ' active' : ''}`} onClick={() => setMarket(n)}>{n}-Way</button>
            ))}
          </div>
        </div>

        {/* Grid header */}
        <div className="dv-grid" style={{ '--dv-cols': size }}>
          <div className="dv-col-head">Odds</div>
          <div className="dv-col-head">No-Vig %</div>
          <div className="dv-col-head">No-Vig Odds</div>

          {outcomes.map((o, i) => {
            const fairPct  = res ? (res.fair[i] * 100).toFixed(2) + '%' : '—'
            const fairOdds = res ? formatOdds(1 / res.fair[i], fmt) : '—'
            const isGreen  = res && (1 / res.fair[i]) > decimals[i]
            return (
              <>
                <input
                  key={`odds-${i}`}
                  type="number"
                  placeholder={fmt === 'american' ? '+110' : '2.10'}
                  value={o.odds}
                  onChange={e => updateOdds(i, e.target.value)}
                  className="dv-odds-input"
                />
                <div key={`pct-${i}`} className="dv-result">{fairPct}</div>
                <div key={`odds-out-${i}`} className={`dv-result${isGreen ? ' dv-green' : ''}`}>{fairOdds}</div>
              </>
            )
          })}
        </div>

        {res && (
          <div className="dv-summary">
            <span>Vig: <strong className="yellow">{res.vig.toFixed(2)}%</strong></span>
            <span>Overround: <strong className="red">{(res.total * 100).toFixed(2)}%</strong></span>
          </div>
        )}
      </div>

      <div className="card">
        <h2>About Devig Methods</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 14, color: 'var(--text-muted)' }}>
          <div><strong style={{ color: 'var(--text)' }}>Probit</strong><br />Transforms implied probs through the inverse normal CDF, shifts them to sum to 100%, then transforms back. Tends to be accurate for balanced two-way markets.</div>
          <div><strong style={{ color: 'var(--text)' }}>Multiplicative</strong><br />Scales each implied probability proportionally so they sum to 100%. Most common method.</div>
          <div><strong style={{ color: 'var(--text)' }}>Additive</strong><br />Subtracts an equal share of overround from each implied probability.</div>
          <div><strong style={{ color: 'var(--text)' }}>Power</strong><br />Shin's method — finds an exponent analytically. Generally most accurate for heavily-vig'd markets.</div>
          <div><strong style={{ color: 'var(--text)' }}>Worst Case</strong><br />Assumes the full overround is against you — gives the most conservative (lowest) fair probability for each outcome.</div>
        </div>
      </div>
    </div>
  )
}

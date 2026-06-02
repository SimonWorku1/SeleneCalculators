import { useState, useMemo } from 'react'

function probToAmerican(p) {
  if (p >= 0.5) return -(p / (1 - p)) * 100
  return ((1 - p) / p) * 100
}
function americanToDecimal(a) {
  if (a >= 100) return (a / 100) + 1
  return (100 / Math.abs(a)) + 1
}
function probToDecimal(p) { return 1 / p }
function getGCD(a, b) { return b === 0 ? a : getGCD(b, a % b) }
function toFractional(p) {
  const ratio = (1 - p) / p
  const denom = 100
  const num = Math.round(ratio * denom)
  const gcd = getGCD(num, denom)
  return `${num / gcd}/${denom / gcd}`
}
function formatAmerican(a) {
  return a >= 0 ? `+${a.toFixed(0)}` : `${a.toFixed(0)}`
}

const REF_PROBS = [5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95]

export default function PredictionMarkets() {
  const [mode, setMode] = useState('prob')
  const [probInput, setProbInput] = useState('')
  const [centsInput, setCentsInput] = useState('')
  const [americanInput, setAmericanInput] = useState('')
  const [decimalInput, setDecimalInput] = useState('')

  // Compute the probability from whichever input mode is active
  let prob = null
  if (mode === 'prob' && probInput !== '') {
    const v = parseFloat(probInput)
    if (!isNaN(v) && v > 0 && v < 100) prob = v / 100
  } else if (mode === 'american' && americanInput !== '') {
    const a = parseFloat(americanInput)
    if (!isNaN(a) && (a >= 100 || a <= -100)) {
      prob = 1 / americanToDecimal(a)
    }
  } else if (mode === 'decimal' && decimalInput !== '') {
    const d = parseFloat(decimalInput)
    if (!isNaN(d) && d > 1) prob = 1 / d
  }

  const result = prob !== null ? {
    prob,
    dec: probToDecimal(prob),
    amer: probToAmerican(prob),
    frac: toFractional(prob),
    cents: (prob * 100).toFixed(2),
  } : null

  function handleProbChange(val) {
    setProbInput(val)
    const v = parseFloat(val)
    if (!isNaN(v)) setCentsInput(v.toFixed(2))
  }

  function handleCentsChange(val) {
    setCentsInput(val)
    const v = parseFloat(val)
    if (!isNaN(v)) setProbInput(v.toFixed(2))
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Prediction Markets Converter</h1>
        <p>Convert between prediction market probabilities (Polymarket, Kalshi, Manifold) and sports-book odds formats. Works in both directions.</p>
      </div>

      <div className="card">
        <h2>Conversion Direction</h2>
        <div className="format-toggle">
          {[['prob','Probability → Odds'],['american','American → All'],['decimal','Decimal → All']].map(([m, label]) => (
            <button key={m} className={`format-btn${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
      </div>

      {mode === 'prob' && (
        <div className="card">
          <h2>Input</h2>
          <div className="field-group">
            <div className="field">
              <label>Probability (%)</label>
              <input type="number" placeholder="e.g. 65" min="0.01" max="99.99" step="0.01" value={probInput} onChange={e => handleProbChange(e.target.value)} />
            </div>
            <div className="field">
              <label>Contract Price (¢, optional)</label>
              <input type="number" placeholder="e.g. 65 = 65¢ = 65%" min="0.01" max="99.99" step="0.01" value={centsInput} onChange={e => handleCentsChange(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {mode === 'american' && (
        <div className="card">
          <h2>Input</h2>
          <div className="field-group">
            <div className="field">
              <label>American Odds</label>
              <input type="number" placeholder="e.g. -150 or +200" value={americanInput} onChange={e => setAmericanInput(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {mode === 'decimal' && (
        <div className="card">
          <h2>Input</h2>
          <div className="field-group">
            <div className="field">
              <label>Decimal Odds</label>
              <input type="number" placeholder="e.g. 1.667" min="1.001" step="0.001" value={decimalInput} onChange={e => setDecimalInput(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="card">
          <h2>Converted Values</h2>
          <table className="conv-table">
            <tbody>
              <tr><td className="conv-label">Probability</td><td><span className="conv-value blue">{(result.prob * 100).toFixed(2)}%</span></td></tr>
              <tr><td className="conv-label">Contract Price</td><td><span className="conv-value">{result.cents}¢</span> &nbsp;<span className="badge badge-blue">Poly / Kalshi</span></td></tr>
              <tr><td className="conv-label">American Odds</td><td><span className="conv-value">{formatAmerican(result.amer)}</span></td></tr>
              <tr><td className="conv-label">Decimal Odds</td><td><span className="conv-value">{result.dec.toFixed(3)}</span></td></tr>
              <tr><td className="conv-label">Fractional Odds</td><td><span className="conv-value">{result.frac}</span></td></tr>
              <tr>
                <td className="conv-label">Implied Edge vs 50/50</td>
                <td>
                  <span className={`conv-value ${result.prob > 0.5 ? 'red' : 'green'}`}>{result.prob > 0.5 ? '-' : '+'}{Math.abs((result.prob - 0.5) * 100).toFixed(2)}%</span>
                  {' '}<span className={`badge ${result.prob > 0.5 ? 'badge-red' : 'badge-green'}`}>{result.prob > 0.5 ? 'Favorite' : 'Underdog'}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Quick Reference Table</h2>
        <table className="result-table">
          <thead>
            <tr><th>Probability</th><th>Contract Price</th><th>American</th><th>Decimal</th><th>Fractional</th></tr>
          </thead>
          <tbody>
            {REF_PROBS.map(pct => {
              const p = pct / 100
              return (
                <tr key={pct}>
                  <td>{pct}%</td>
                  <td>{pct}¢</td>
                  <td>{formatAmerican(probToAmerican(p))}</td>
                  <td>{probToDecimal(p).toFixed(3)}</td>
                  <td>{toFractional(p)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

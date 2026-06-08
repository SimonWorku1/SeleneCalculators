import { useState } from 'react'

function toDecimal(val, fmt) {
  const n = parseFloat(val)
  if (isNaN(n)) return null
  if (fmt === 'decimal') return n > 1 ? n : null
  if (n >= 100) return n / 100 + 1
  if (n <= -100) return 100 / Math.abs(n) + 1
  return null
}

export default function EVCalculator() {
  const [fmt, setFmt] = useState('american')
  const [oddsInput, setOddsInput] = useState('')
  const [probInput, setProbInput] = useState('')
  const [stakeInput, setStakeInput] = useState('100')
  const [numBets, setNumBets] = useState('100')
  const [tab, setTab] = useState('ev')

  const dec = toDecimal(oddsInput, fmt)
  const p = parseFloat(probInput) / 100
  const stake = parseFloat(stakeInput)
  const n = parseInt(numBets) || 100
  const valid = dec && !isNaN(p) && p > 0 && p < 1 && stake > 0

  let r = null
  if (valid) {
    const q = 1 - p
    const b = dec - 1
    const ev = p * b * stake - q * stake
    const evPct = (ev / stake) * 100
    const bookProb = 1 / dec
    const edge = (p - bookProb) * 100
    const kelly = Math.max(0, (b * p - q) / b)
    const totalEV = ev * n
    const totalStaked = stake * n
    const variance = p * Math.pow(b * stake, 2) + q * Math.pow(stake, 2) - Math.pow(ev, 2)
    const std = Math.sqrt(variance * n)
    r = { p, q, b, ev, evPct, bookProb, edge, kelly, totalEV, totalStaked, std,
          best: totalEV + 2 * std, worst: totalEV - 2 * std, pos: ev > 0 }
  }

  const s = (n) => n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`

  return (
    <div className="page">
      <div className="page-header">
        <h1>Expected Value (EV) Calculator</h1>
        <p>Calculate the expected value of any bet given your estimated true win probability and the offered odds.</p>
      </div>

      <div className="calc-layout">
        {/* LEFT: inputs */}
        <div className="calc-col">
          <div className="card">
            <h2>Odds Format</h2>
            <div className="format-toggle">
              {['american','decimal'].map(f => (
                <button key={f} className={`format-btn${fmt === f ? ' active' : ''}`} onClick={() => setFmt(f)}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Bet Details</h2>
            <div className="field-group">
              <div className="field">
                <label>Offered Odds</label>
                <input type="number" placeholder={fmt === 'american' ? 'e.g. -110' : 'e.g. 1.91'} value={oddsInput} onChange={e => setOddsInput(e.target.value)} />
              </div>
              <div className="field">
                <label>Your True Win Probability (%)</label>
                <input type="number" placeholder="e.g. 55" min="0.01" max="99.99" step="0.01" value={probInput} onChange={e => setProbInput(e.target.value)} />
              </div>
              <div className="field">
                <label>Stake ($)</label>
                <input type="number" placeholder="100" min="0.01" value={stakeInput} onChange={e => setStakeInput(e.target.value)} />
              </div>
            </div>
            <div className="info-box" style={{ marginTop: 12 }}>
              <strong>True probability</strong> is your honest estimate of how likely the outcome is — ideally from sharp closing lines, no-vig models, or the devigger above.
            </div>
          </div>

          <div className="card">
            <h2>Understanding Expected Value</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 14, color: 'var(--text-muted)' }}>
              <div><strong style={{ color: 'var(--text)' }}>EV Formula</strong><br />EV = (Win Prob × Profit) − (Loss Prob × Stake). Positive EV = profitable long-term.</div>
              <div><strong style={{ color: 'var(--text)' }}>Kelly Criterion</strong><br />f* = (bp − q) / b where b = decimal odds − 1. Maximises long-run bankroll growth.</div>
              <div><strong style={{ color: 'var(--text)' }}>ROI vs EV</strong><br />EV% is edge per dollar wagered. Real results deviate from expected, especially over small samples.</div>
            </div>
          </div>
        </div>

        {/* RIGHT: tabbed results */}
        <div className="calc-col">
          <div className="card">
            <div className="ev-tabs">
              <button className={`ev-tab${tab === 'ev' ? ' active' : ''}`} onClick={() => setTab('ev')}>EV</button>
              <button className={`ev-tab${tab === 'longterm' ? ' active' : ''}`} onClick={() => setTab('longterm')}>Long-Term Projections</button>
            </div>

            {tab === 'ev' && (
              <>
                {r ? (
                  <>
                    <div style={{ marginBottom: 16 }}>
                      <span className={`badge ${r.pos ? 'badge-green' : 'badge-red'}`}>
                        {r.pos ? '+EV Bet — Profitable Long Term' : '-EV Bet — Unprofitable Long Term'}
                      </span>
                    </div>
                    <div className="result-grid">
                      <div className="result-item"><div className="label">Expected Value</div><div className={`value ${r.pos ? 'green' : 'red'}`}>{r.ev >= 0 ? '+' : ''}${r.ev.toFixed(2)}</div></div>
                      <div className="result-item"><div className="label">EV % (ROI)</div><div className={`value ${r.pos ? 'green' : 'red'}`}>{r.evPct >= 0 ? '+' : ''}{r.evPct.toFixed(2)}%</div></div>
                      <div className="result-item"><div className="label">Your Edge</div><div className={`value ${r.edge >= 0 ? 'green' : 'red'}`}>{r.edge >= 0 ? '+' : ''}{r.edge.toFixed(2)}%</div></div>
                      <div className="result-item"><div className="label">Book Implied Prob</div><div className="value">{(r.bookProb * 100).toFixed(2)}%</div></div>
                      <div className="result-item"><div className="label">True Win Prob</div><div className="value blue">{(p * 100).toFixed(2)}%</div></div>
                      <div className="result-item"><div className="label">Kelly Bet Size</div><div className="value yellow">{(r.kelly * 100).toFixed(2)}% bankroll</div></div>
                    </div>
                  </>
                ) : (
                  <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 8 }}>Enter odds, probability, and stake to see results.</p>
                )}
              </>
            )}

            {tab === 'longterm' && (
              <>
                <div className="field" style={{ marginBottom: 16 }}>
                  <label>Number of Bets</label>
                  <input type="number" value={numBets} min="1" onChange={e => setNumBets(e.target.value)} style={{ maxWidth: 160 }} />
                </div>
                {r ? (
                  <>
                    <div className="result-grid">
                      <div className="result-item"><div className="label">Total EV ({n} bets)</div><div className={`value ${r.pos ? 'green' : 'red'}`}>{s(r.totalEV)}</div></div>
                      <div className="result-item"><div className="label">Total Staked</div><div className="value">${r.totalStaked.toFixed(2)}</div></div>
                      <div className="result-item"><div className="label">Projected Wins</div><div className="value green">{(r.p * n).toFixed(1)}</div></div>
                      <div className="result-item"><div className="label">Std Deviation</div><div className="value yellow">±${r.std.toFixed(2)}</div></div>
                    </div>
                    <table className="result-table" style={{ marginTop: 20 }}>
                      <thead><tr><th>Scenario</th><th>Description</th><th>Total P&amp;L</th><th>Win Rate</th></tr></thead>
                      <tbody>
                        <tr>
                          <td><span className="badge badge-green">Best Case</span></td>
                          <td>+2 std deviations above expected</td>
                          <td style={{ color: 'var(--accent-green)', fontWeight: 600 }}>{s(r.best)}</td>
                          <td>{((r.p + 2 * Math.sqrt(r.p * r.q / n)) * 100).toFixed(1)}%</td>
                        </tr>
                        <tr>
                          <td><span className="badge badge-blue">Expected</span></td>
                          <td>Long-run average at {(p * 100).toFixed(1)}% win rate</td>
                          <td style={{ color: r.pos ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>{s(r.totalEV)}</td>
                          <td>{(r.p * 100).toFixed(1)}%</td>
                        </tr>
                        <tr>
                          <td><span className="badge badge-red">Worst Case</span></td>
                          <td>−2 std deviations below expected</td>
                          <td style={{ color: 'var(--accent-red)', fontWeight: 600 }}>{s(r.worst)}</td>
                          <td>{Math.max(0, (r.p - 2 * Math.sqrt(r.p * r.q / n)) * 100).toFixed(1)}%</td>
                        </tr>
                      </tbody>
                    </table>
                    <div className="info-box" style={{ marginTop: 16 }}>
                      <strong>Kelly Criterion:</strong> Full Kelly is <strong>{(r.kelly * 100).toFixed(2)}%</strong> of bankroll. Half-Kelly (<strong>{(r.kelly / 2 * 100).toFixed(2)}%</strong>) reduces variance while retaining ~75% of expected growth. Over {n} bets at ${stake}/each: <strong>${r.totalStaked.toFixed(2)}</strong> in action, projected P&L of <strong>{s(r.totalEV)}</strong>.
                    </div>
                  </>
                ) : (
                  <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 8 }}>Enter odds, probability, and stake to see projections.</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

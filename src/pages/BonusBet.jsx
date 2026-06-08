import { useState } from 'react'

function toDecimal(val, fmt) {
  const n = parseFloat(val)
  if (isNaN(n)) return null
  if (fmt === 'decimal') return n > 1 ? n : null
  if (n >= 100) return n / 100 + 1
  if (n <= -100) return 100 / Math.abs(n) + 1
  return null
}

function InfoTip({ text }) {
  return (
    <span className="info-tip">
      <span className="info-tip-icon">i</span>
      <span className="info-tip-box">{text}</span>
    </span>
  )
}

export default function BonusBet() {
  const [fmt, setFmt] = useState('american')
  const [betType, setBetType] = useState('free')
  const [amount, setAmount] = useState('')
  const [betOdds, setBetOdds] = useState('')
  const [hedgeOdds, setHedgeOdds] = useState('')

  const decBet = toDecimal(betOdds, fmt)
  const decHedge = toDecimal(hedgeOdds, fmt)
  const amt = parseFloat(amount)
  const valid = decBet && decHedge && amt > 0

  let res = null
  if (valid) {
    if (betType === 'free') {
      // Free bet: stake not returned on win
      const hedgeStake = amt * (decBet - 1) / decHedge
      const profit = hedgeStake * (decHedge - 1)
      const conversion = (profit / amt) * 100
      const evNoHedge = amt * (decBet - 1) / decBet  // implied-prob EV of free bet straight
      res = { hedgeStake, profit, conversion, evNoHedge }
    } else {
      // Regular bet: stake returned on win, hedge to guarantee equal profit
      const hedgeStake = amt * decBet / decHedge
      const profitWin  = amt * (decBet - 1) - hedgeStake
      const profitLose = hedgeStake * (decHedge - 1) - amt
      const profit = (profitWin + profitLose) / 2  // should be equal; show average
      res = { hedgeStake, profitWin, profitLose, profit: Math.min(profitWin, profitLose), conversion: null }
    }
  }

  const f = (n) => n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`

  return (
    <div className="page">
      <div className="page-header">
        <h1>Bonus Bet Converter</h1>
        <p>Calculate the optimal hedge to convert a bonus or free bet into guaranteed cash.</p>
      </div>

      {/* Settings */}
      <div className="card">
        <div className="bb-settings">
          <div className="dv-sg">
            <label>Bet Type</label>
            <div className="format-toggle" style={{ margin: 0 }}>
              <button className={`format-btn${betType === 'free' ? ' active' : ''}`} onClick={() => setBetType('free')}>Free Bet</button>
              <button className={`format-btn${betType === 'regular' ? ' active' : ''}`} onClick={() => setBetType('regular')}>Regular Bet</button>
            </div>
          </div>
          <div className="dv-sg">
            <label>Odds Format</label>
            <div className="format-toggle" style={{ margin: 0 }}>
              {['american', 'decimal'].map(f => (
                <button key={f} className={`format-btn${fmt === f ? ' active' : ''}`} onClick={() => setFmt(f)}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Inputs */}
      <div className="card">
        <h2>Bet Details</h2>
        <div className="field-group">
          <div className="field">
            <label>
              {betType === 'free' ? 'Free Bet Amount ($)' : 'Bet Amount ($)'}
              <InfoTip text={betType === 'free' ? "The face value of your free/bonus bet token." : "The amount of real money you are staking on the bet."} />
            </label>
            <input type="number" placeholder="e.g. 100" min="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div className="field">
            <label>
              {betType === 'free' ? 'Free Bet Odds' : 'Bet Odds'}
              <InfoTip text={betType === 'free' ? "Odds at which you're placing the free bet. Use the longest odds available — higher odds = better conversion rate." : "Odds on the side you're betting on."} />
            </label>
            <input type="number" placeholder={fmt === 'american' ? 'e.g. +200' : 'e.g. 3.00'} value={betOdds} onChange={e => setBetOdds(e.target.value)} />
          </div>
          <div className="field">
            <label>
              Hedge Odds
              <InfoTip text="Odds on the opposite outcome at another sportsbook. This is the bet you place with real money to guarantee profit regardless of the result." />
            </label>
            <input type="number" placeholder={fmt === 'american' ? 'e.g. -250' : 'e.g. 1.40'} value={hedgeOdds} onChange={e => setHedgeOdds(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Results */}
      {res && (
        <div className="card">
          <h2>Results</h2>

          {betType === 'free' ? (
            <>
              <div className="result-grid">
                <div className="result-item">
                  <div className="label">Hedge Stake</div>
                  <div className="value">${res.hedgeStake.toFixed(2)}</div>
                </div>
                <div className="result-item">
                  <div className="label">Guaranteed Profit</div>
                  <div className="value green">{f(res.profit)}</div>
                </div>
                <div className="result-item">
                  <div className="label">Conversion Rate</div>
                  <div className="value yellow">{res.conversion.toFixed(1)}%</div>
                </div>
                <div className="result-item">
                  <div className="label">EV (No Hedge)</div>
                  <div className="value blue">{f(res.evNoHedge)}</div>
                </div>
              </div>
              <div className="info-box" style={{ marginTop: 16 }}>
                Bet <strong>${amt.toFixed(2)}</strong> free bet at <strong>{betOdds}</strong>, then hedge <strong>${res.hedgeStake.toFixed(2)}</strong> at <strong>{hedgeOdds}</strong> on the other side. You lock in <strong>{f(res.profit)}</strong> ({res.conversion.toFixed(1)}% of the free bet value) regardless of outcome.
              </div>
            </>
          ) : (
            <>
              <div className="result-grid">
                <div className="result-item">
                  <div className="label">Hedge Stake</div>
                  <div className="value">${res.hedgeStake.toFixed(2)}</div>
                </div>
                <div className="result-item">
                  <div className="label">If Bet Wins</div>
                  <div className={`value ${res.profitWin >= 0 ? 'green' : 'red'}`}>{f(res.profitWin)}</div>
                </div>
                <div className="result-item">
                  <div className="label">If Hedge Wins</div>
                  <div className={`value ${res.profitLose >= 0 ? 'green' : 'red'}`}>{f(res.profitLose)}</div>
                </div>
                <div className="result-item">
                  <div className="label">Guaranteed Profit</div>
                  <div className={`value ${res.profit >= 0 ? 'green' : 'red'}`}>{f(res.profit)}</div>
                </div>
              </div>
              <div className="info-box" style={{ marginTop: 16 }}>
                Bet <strong>${amt.toFixed(2)}</strong> at <strong>{betOdds}</strong> and hedge <strong>${res.hedgeStake.toFixed(2)}</strong> at <strong>{hedgeOdds}</strong>. {Math.abs(res.profitWin - res.profitLose) < 0.01 ? 'Both outcomes return the same profit.' : 'Outcomes are not perfectly balanced — consider adjusting your hedge stake.'}
              </div>
            </>
          )}
        </div>
      )}

      {/* Tips */}
      <div className="card">
        <h2>Tips for Free Bets</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 14, color: 'var(--text-muted)' }}>
          <div><strong style={{ color: 'var(--text)' }}>Use long odds</strong><br />Free bets convert better at longer odds (e.g. +200 to +400). At +100 you only convert ~50%; at +300 you convert ~75%.</div>
          <div><strong style={{ color: 'var(--text)' }}>Find a sharp hedge</strong><br />Hedge at the sharpest book available to get the best price on the other side, maximizing your guaranteed return.</div>
          <div><strong style={{ color: 'var(--text)' }}>Conversion rate</strong><br />A typical free bet converts at 60–80% depending on line availability. Anything above 70% is excellent.</div>
        </div>
      </div>
    </div>
  )
}

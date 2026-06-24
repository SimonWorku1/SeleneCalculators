import { useState, useCallback } from 'react'
import { ScaleIcon } from '../components/icons.jsx'

function toDecimal(val, format) {
  const n = parseFloat(val)
  if (isNaN(n)) return null
  if (format === 'decimal') return n > 1 ? n : null
  if (n >= 100) return (n / 100) + 1
  if (n <= -100) return (100 / Math.abs(n)) + 1
  return null
}

function fmt(n) { return n.toFixed(2) }

export default function Arbitrage() {
  const [oddsFormat, setOddsFormat] = useState('american')
  const [stakeMode, setStakeMode] = useState('manual')
  const [bankroll, setBankroll] = useState('1000')
  const [outcomes, setOutcomes] = useState([
    { id: 1, name: 'Team A', odds: '', stake: '100' },
    { id: 2, name: 'Team B', odds: '', stake: '100' },
  ])

  const decimals = outcomes.map(o => toDecimal(o.odds, oddsFormat))
  const allOddsValid = decimals.every(d => d !== null)

  // Compute stakes (auto mode or manual mode)
  let stakes
  if (stakeMode === 'auto' && allOddsValid) {
    const impliedProbs = decimals.map(d => 1 / d)
    const totalImplied = impliedProbs.reduce((a, b) => a + b, 0)
    stakes = impliedProbs.map(p => (parseFloat(bankroll) || 0) * p / totalImplied)
  } else {
    stakes = outcomes.map(o => parseFloat(o.stake) || 0)
  }

  const impliedProbs = allOddsValid ? decimals.map(d => 1 / d) : []
  const totalImplied = allOddsValid ? impliedProbs.reduce((a, b) => a + b, 0) : 0
  const isArb = allOddsValid && totalImplied < 1

  const payouts = allOddsValid ? outcomes.map((o, i) => stakes[i] * decimals[i]) : []
  const totalStake = stakes.reduce((a, b) => a + b, 0)
  const guaranteedPayout = allOddsValid ? Math.min(...payouts) : 0
  const profit = guaranteedPayout - totalStake
  const roiPct = totalStake > 0 ? (profit / totalStake) * 100 : 0
  const hasProfit = isArb && profit > 0

  function updateOdds(id, value) {
    setOutcomes(prev => prev.map(o => o.id === id ? { ...o, odds: value } : o))
  }

  function updateName(id, value) {
    setOutcomes(prev => prev.map(o => o.id === id ? { ...o, name: value } : o))
  }

  function updateStake(anchorId, value) {
    // In manual mode: autofill others to equalize payouts
    const anchorIdx = outcomes.findIndex(o => o.id === anchorId)
    const anchorDecimal = toDecimal(outcomes[anchorIdx].odds, oddsFormat)

    if (allOddsValid && anchorDecimal !== null) {
      const anchorVal = parseFloat(value) || 0
      const targetPayout = anchorVal * anchorDecimal
      setOutcomes(prev => prev.map((o, i) => {
        if (o.id === anchorId) return { ...o, stake: value }
        const d = toDecimal(o.odds, oddsFormat)
        return { ...o, stake: d ? (targetPayout / d).toFixed(2) : o.stake }
      }))
    } else {
      setOutcomes(prev => prev.map(o => o.id === anchorId ? { ...o, stake: value } : o))
    }
  }


  const gridCols = `110px repeat(${outcomes.length}, 1fr)`

  const displayStakes = stakeMode === 'auto' && allOddsValid
    ? stakes.map(s => s.toFixed(2))
    : outcomes.map(o => o.stake)

  return (
    <div className="page">
      <div className="page-header">
        <div className="eyebrow"><ScaleIcon />Arbitrage</div>
        <h1>Arbitrage Calculator</h1>
        <p>Enter odds and stakes for each outcome to detect guaranteed profit opportunities and calculate optimal wager amounts.</p>
      </div>

      <div className="calc-layout">
        {/* LEFT: inputs */}
        <div className="calc-col">
          {/* Settings bar */}
          <div className="settings-bar">
            <div>
              <label>Odds Format</label>
              <div className="format-toggle" style={{ display: 'inline-flex' }}>
                <button className={`format-btn${oddsFormat === 'american' ? ' active' : ''}`} onClick={() => setOddsFormat('american')}>American</button>
                <button className={`format-btn${oddsFormat === 'decimal' ? ' active' : ''}`} onClick={() => setOddsFormat('decimal')}>Decimal</button>
              </div>
            </div>
            <div>
              <label>Stakes</label>
              <div className="format-toggle" style={{ display: 'inline-flex' }}>
                <button className={`format-btn${stakeMode === 'manual' ? ' active' : ''}`} onClick={() => setStakeMode('manual')}>Manual</button>
                <button className={`format-btn${stakeMode === 'auto' ? ' active' : ''}`} onClick={() => setStakeMode('auto')}>Auto (Optimal)</button>
              </div>
            </div>
            {stakeMode === 'auto' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ margin: 0 }}>Bankroll $</label>
                <input type="number" value={bankroll} placeholder="1000" min="1" style={{ width: 110 }} onChange={e => setBankroll(e.target.value)} />
              </div>
            )}
          </div>

          {/* Grid card */}
          <div className="arb-card">
            {/* Column headers */}
            <div className="arb-row" style={{ display: 'grid', gridTemplateColumns: gridCols }}>
              <div className="arb-col-header" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }} />
              {outcomes.map((o, i) => (
                <div key={o.id} className="arb-col-header" style={{ gridColumn: i + 2 }}>
                  <input
                    type="text"
                    value={o.name}
                    onChange={e => updateName(o.id, e.target.value)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.5px', width: '100%', outline: 'none', padding: 0 }}
                  />
                </div>
              ))}
            </div>

            {/* Odds row */}
            <div className="arb-row" style={{ display: 'grid', gridTemplateColumns: gridCols }}>
              <div className="arb-row-label">Odds</div>
              {outcomes.map(o => (
                <div key={o.id} className="arb-cell">
                  <input
                    type="number"
                    className="odds-inp"
                    placeholder={oddsFormat === 'american' ? '+110' : '2.10'}
                    value={o.odds}
                    onChange={e => updateOdds(o.id, e.target.value)}
                  />
                </div>
              ))}
            </div>

            {/* Stake row */}
            <div className="arb-row" style={{ display: 'grid', gridTemplateColumns: gridCols }}>
              <div className="arb-row-label">Stake</div>
              {outcomes.map((o, i) => (
                <div key={o.id} className="arb-cell">
                  <div className={`money-wrap${stakeMode === 'auto' ? ' readonly' : ''}`}>
                    <span className="prefix">$</span>
                    <input
                      type="number"
                      className="stake-inp"
                      placeholder="100"
                      value={stakeMode === 'auto' ? (allOddsValid ? stakes[i].toFixed(2) : o.stake) : o.stake}
                      readOnly={stakeMode === 'auto'}
                      onChange={stakeMode === 'manual' ? e => updateStake(o.id, e.target.value) : undefined}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Payout row */}
            <div className="arb-row" style={{ display: 'grid', gridTemplateColumns: gridCols }}>
              <div className="arb-row-label">Payout</div>
              {outcomes.map((o, i) => (
                <div key={o.id} className="arb-cell">
                  <div className="money-wrap readonly">
                    <span className="prefix">$</span>
                    <input type="number" readOnly value={allOddsValid ? fmt(payouts[i]) : ''} placeholder="0.00" />
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="arb-footer">
              <div className="arb-footer-item">
                <div className="f-label">Total Stake</div>
                <div className="f-value">${fmt(totalStake)}</div>
              </div>
              <div className="arb-footer-item">
                <div className="f-label">Total Payout</div>
                <div className="f-value">${allOddsValid ? fmt(guaranteedPayout) : '0.00'}</div>
              </div>
              <div className="arb-footer-item">
                <div className="f-label">{hasProfit ? 'Profit' : 'Loss'} ({roiPct.toFixed(2)}%)</div>
                <div className="f-value" style={{ color: hasProfit ? 'var(--accent-green)' : allOddsValid ? 'var(--accent-red)' : undefined }}>
                  {allOddsValid ? `${profit >= 0 ? '+' : ''}$${fmt(profit)}` : '$0.00'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: results */}
        <div className="calc-col">
          {/* Banner */}
          <div className={`arb-banner ${hasProfit ? 'positive' : 'negative'}`}>
            <span className="banner-icon">{!allOddsValid ? '—' : hasProfit ? '✓' : '✗'}</span>
            <span>
              {!allOddsValid
                ? 'Enter odds to check for arbitrage'
                : hasProfit
                  ? <span>Arbitrage opportunity found — guaranteed profit of <strong>+${fmt(profit)}</strong> ({roiPct.toFixed(2)}% ROI). Combined implied probability: {(totalImplied * 100).toFixed(2)}%.</span>
                  : isArb
                    ? <span>Arbitrage odds detected but stakes are unbalanced — adjust stakes to lock in profit. Combined implied probability: {(totalImplied * 100).toFixed(2)}%.</span>
                    : <span>No arbitrage — books hold a <strong>{((totalImplied - 1) * 100).toFixed(2)}%</strong> margin. Combined implied probability: {(totalImplied * 100).toFixed(2)}%.</span>
              }
            </span>
          </div>

          {/* Info box */}
          {hasProfit && (
            <div className="info-box">
              <strong>How to execute:</strong> Bet {outcomes.map((o, i) => <span key={o.id}><strong>${fmt(stakes[i])}</strong> on {o.name || `Outcome ${i + 1}`}{i < outcomes.length - 1 ? ', ' : ''}</span>)}. Regardless of which outcome wins, your guaranteed return is <strong>${fmt(guaranteedPayout)}</strong> for a profit of <strong>+${fmt(profit)}</strong> ({roiPct.toFixed(2)}% ROI).
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

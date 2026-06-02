import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Betting Calculators</h1>
        <p>Professional-grade tools for sports bettors. Find arbitrage opportunities, remove the vig, convert odds, and calculate expected value.</p>
      </div>
      <div className="calc-grid">
        <Link to="/arbitrage" className="calc-card">
          <div className="icon">⚖️</div>
          <h3>Arbitrage Calculator</h3>
          <p>Detect guaranteed profit opportunities by betting both sides of a market across different books. Enter odds and stake to see exact wager amounts.</p>
        </Link>
        <Link to="/prediction-markets" className="calc-card">
          <div className="icon">📊</div>
          <h3>Prediction Markets Converter</h3>
          <p>Convert between probability percentages (Polymarket, Kalshi) and American, Decimal, and Fractional odds formats instantly.</p>
        </Link>
        <Link to="/devigger" className="calc-card">
          <div className="icon">🔬</div>
          <h3>Devigger / No-Vig Fair Odds</h3>
          <p>Strip the bookmaker's margin from any market to find the true implied probability and fair odds for 2-way and 3-way markets.</p>
        </Link>
        <Link to="/ev-calculator" className="calc-card">
          <div className="icon">📈</div>
          <h3>Expected Value Calculator</h3>
          <p>Calculate the expected value of any bet given your edge. See EV in dollars, ROI percentage, and long-run projections.</p>
        </Link>
      </div>
    </div>
  )
}

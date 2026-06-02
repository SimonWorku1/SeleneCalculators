import { NavLink } from 'react-router-dom'

export default function Header() {
  return (
    <header>
      <NavLink to="/" className="logo">Selene<span>Calc</span></NavLink>
      <nav>
        <NavLink to="/arbitrage" className={({ isActive }) => isActive ? 'active' : ''}>Arbitrage</NavLink>
        <NavLink to="/prediction-markets" className={({ isActive }) => isActive ? 'active' : ''}>Prediction Markets</NavLink>
        <NavLink to="/devigger" className={({ isActive }) => isActive ? 'active' : ''}>Devigger</NavLink>
        <NavLink to="/ev-calculator" className={({ isActive }) => isActive ? 'active' : ''}>Expected Value</NavLink>
      </nav>
    </header>
  )
}

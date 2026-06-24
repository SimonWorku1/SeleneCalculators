import { NavLink } from 'react-router-dom'
import {
  MoonIcon,
  ScaleIcon,
  ChartIcon,
  BeakerIcon,
  TrendingUpIcon,
  GiftIcon,
  CalendarIcon,
  LinkIcon,
  SearchIcon,
  DiscordIcon,
} from './icons.jsx'

const links = [
  { to: '/arbitrage', label: 'Arbitrage', Icon: ScaleIcon },
  { to: '/prediction-markets', label: 'Prediction Markets', Icon: ChartIcon },
  { to: '/devigger', label: 'Devigger', Icon: BeakerIcon },
  { to: '/ev-calculator', label: 'Expected Value', Icon: TrendingUpIcon },
  { to: '/bonus-bet', label: 'Bonus Bet', Icon: GiftIcon },
  { to: '/bet-tracker', label: 'Bet Tracker', Icon: CalendarIcon },
  { to: '/sharpsports', label: 'SharpSports', Icon: LinkIcon },
]

export default function Header() {
  return (
    <header className="sw-nav">
      <NavLink to="/" className="logo" end>
        <MoonIcon className="logo-moon" width={20} height={20} />
        <span className="logo-word">SELENE</span>
        <span className="logo-tag">CALC</span>
      </NavLink>

      <nav>
        {links.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            title={label}
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          >
            <Icon className="nav-ico" width={16} height={16} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Right cluster mirrors Selene's nav. Search + Discord are placeholders
          (no command palette / server URL wired yet); swap in real targets later. */}
      <div className="nav-right">
        <button className="nav-search" type="button" aria-label="Search">
          <SearchIcon width={15} height={15} />
          <span className="nav-search-ph">Search calculators</span>
          <kbd>⌘K</kbd>
        </button>
        <button className="nav-discord" type="button">
          <DiscordIcon width={17} height={17} />
          <span>Join our Discord</span>
        </button>
        <button className="nav-avatar" type="button" aria-label="Account">
          SC
        </button>
      </div>
    </header>
  )
}

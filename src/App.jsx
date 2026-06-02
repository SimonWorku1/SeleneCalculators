import { Routes, Route } from 'react-router-dom'
import Header from './components/Header.jsx'
import Home from './pages/Home.jsx'
import Arbitrage from './pages/Arbitrage.jsx'
import PredictionMarkets from './pages/PredictionMarkets.jsx'
import Devigger from './pages/Devigger.jsx'
import EVCalculator from './pages/EVCalculator.jsx'

export default function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/arbitrage" element={<Arbitrage />} />
        <Route path="/prediction-markets" element={<PredictionMarkets />} />
        <Route path="/devigger" element={<Devigger />} />
        <Route path="/ev-calculator" element={<EVCalculator />} />
      </Routes>
    </>
  )
}

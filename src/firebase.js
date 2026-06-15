// Firebase client setup. The web config below is public by design (Firebase
// identifies the project with it client-side) — it is safe to commit. Secrets
// like the Kalshi private key live server-side in Firebase secrets, never here.
import { initializeApp } from 'firebase/app'
import { getFunctions } from 'firebase/functions'

const firebaseConfig = {
  apiKey: 'AIzaSyBDfvxaXaOXWVb1u2K2WTouPm9ILfRjzYg',
  authDomain: 'selenecalculators.firebaseapp.com',
  projectId: 'selenecalculators',
  storageBucket: 'selenecalculators.firebasestorage.app',
  messagingSenderId: '1052856495467',
  appId: '1:1052856495467:web:64ac4809879c82e16df02e',
  measurementId: 'G-TVPM0KWM36',
}

export const app = initializeApp(firebaseConfig)
export const functions = getFunctions(app)

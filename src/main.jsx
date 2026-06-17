import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Staging-only 3D landing prototype, served at /preview. Lazy-loaded via a dynamic
// import so the live app bundle never ships Three.js — it only loads when you visit
// /preview. Everything else routes to the normal app exactly as before.
const Landing3D = lazy(() => import('./preview/Landing3D.jsx'))
const isPreview = typeof window !== 'undefined' && window.location.pathname.startsWith('/preview')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isPreview ? (
      <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#0a0a0b', color: '#5f5f6a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 13, letterSpacing: '0.1em' }}>Loading 3D preview…</div>}>
        <Landing3D />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)

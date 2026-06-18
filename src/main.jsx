import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Staging-only landing previews (carry the "staging — not live" banner):
//   /preview      → desktop 3D landing
//   /preview/2d   → light mobile landing
// The LIVE landing renders inside <App/> for logged-out visitors — banner-free, wired to
// real auth, and device-aware (3D on desktop, light on mobile). These /preview routes are
// just for eyeballing the variants in isolation.
const Landing3D = lazy(() => import('./preview/Landing3D.jsx'))
const Landing2D = lazy(() => import('./preview/Landing2D.jsx'))
const path = typeof window !== 'undefined' ? window.location.pathname : ''
const isPreview = path.startsWith('/preview')
const is2D = path.startsWith('/preview/2d')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isPreview ? (
      <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#0a0a0b', color: '#5f5f6a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 13, letterSpacing: '0.1em' }}>Loading preview…</div>}>
        {is2D ? <Landing2D staging /> : <Landing3D staging />}
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)

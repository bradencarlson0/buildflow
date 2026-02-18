import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { RuntimeErrorBoundary, StartupErrorPanel } from './RuntimeErrorFallback.jsx'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing #root mount node')
}

const root = createRoot(rootElement)

const renderStartupError = (error) => {
  root.render(<StartupErrorPanel title="BuildFlow failed to start" error={error} />)
}

const bootstrap = async () => {
  try {
    const { default: App } = await import('./App.jsx')
    root.render(
      <StrictMode>
        <RuntimeErrorBoundary>
          <App />
        </RuntimeErrorBoundary>
      </StrictMode>,
    )
  } catch (error) {
    console.error('BuildFlow bootstrap error', error)
    renderStartupError(error)
  }
}

bootstrap()

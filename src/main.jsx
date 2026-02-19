import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { RuntimeErrorBoundary, StartupErrorPanel } from './RuntimeErrorFallback.jsx'

const MODULE_IMPORT_RETRY_KEY = 'buildflow:module_import_retry_once'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing #root mount node')
}

const root = createRoot(rootElement)

const renderStartupError = (error) => {
  root.render(<StartupErrorPanel title="BuildFlow failed to start" error={error} />)
}

const isModuleImportFailure = (error) => {
  const message = String(error?.message ?? error ?? '').toLowerCase()
  if (!message) return false
  return (
    message.includes('importing a module script failed') ||
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('module script')
  )
}

const tryAutoRecoverModuleImport = () => {
  try {
    if (sessionStorage.getItem(MODULE_IMPORT_RETRY_KEY) === '1') return false
    sessionStorage.setItem(MODULE_IMPORT_RETRY_KEY, '1')
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('_bf_retry', String(Date.now()))
    window.location.replace(nextUrl.toString())
    return true
  } catch {
    return false
  }
}

const bootstrap = async () => {
  try {
    const { default: App } = await import('./App.jsx')
    try {
      sessionStorage.removeItem(MODULE_IMPORT_RETRY_KEY)
    } catch {
      // ignore
    }
    root.render(
      <StrictMode>
        <RuntimeErrorBoundary>
          <App />
        </RuntimeErrorBoundary>
      </StrictMode>,
    )
  } catch (error) {
    console.error('BuildFlow bootstrap error', error)
    if (isModuleImportFailure(error) && tryAutoRecoverModuleImport()) return
    renderStartupError(error)
  }
}

bootstrap()

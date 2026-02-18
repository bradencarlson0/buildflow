import { Component } from 'react'

const toErrorMessage = (error) => {
  if (!error) return 'Unknown startup error.'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || String(error)
  return String(error)
}

export const StartupErrorPanel = ({ title, error }) => (
  <div className="min-h-screen bg-slate-100 px-4 py-6 text-slate-900 sm:px-6">
    <div className="mx-auto w-full max-w-2xl rounded-2xl border border-red-200 bg-white p-5 shadow-sm sm:p-6">
      <h1 className="text-xl font-bold text-red-700">{title}</h1>
      <p className="mt-2 text-sm text-slate-700">
        BuildFlow hit a runtime error. Reload once; if this repeats, send this message to support.
      </p>
      <pre className="mt-4 max-h-[48vh] overflow-auto rounded-xl bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        {toErrorMessage(error)}
      </pre>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 inline-flex h-10 items-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white"
      >
        Reload App
      </button>
    </div>
  </div>
)

export class RuntimeErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('BuildFlow runtime error', error, info)
  }

  render() {
    if (this.state.error) {
      return <StartupErrorPanel title="BuildFlow Runtime Error" error={this.state.error} />
    }
    return this.props.children
  }
}

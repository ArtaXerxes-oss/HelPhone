import { describe, it, expect, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import useDocumentTitle, { setPageTitle } from '../src/lib/useDocumentTitle'

// ---------------------------------------------------------------------------
// Issue #105 — dynamic page titles. The routed pages (Landing /help,
// /ranking) call useDocumentTitle so document.title reflects the current
// page during client-side navigation instead of staying "HelPhone".
// ---------------------------------------------------------------------------

function Page({ title }) {
  useDocumentTitle(title)
  return null
}

afterEach(() => {
  document.title = ''
})

describe('setPageTitle', () => {
  it('suffixes the app name', () => {
    setPageTitle('Help')
    expect(document.title).toBe('Help | HelPhone')
  })

  it('falls back to the app name for empty titles', () => {
    setPageTitle('')
    expect(document.title).toBe('HelPhone')
  })
})

describe('useDocumentTitle', () => {
  it('sets a unique title per page with the HelPhone suffix', () => {
    const { unmount } = render(<Page title="Landing" />)
    expect(document.title).toBe('Landing | HelPhone')
    unmount()

    render(<Page title="Help" />)
    expect(document.title).not.toBe('Landing | HelPhone')
    expect(document.title).toBe('Help | HelPhone')
  })

  it('updates on re-render when the title changes', () => {
    const { rerender } = render(<Page title="Help" />)
    rerender(<Page title="Ranking" />)
    expect(document.title).toBe('Ranking | HelPhone')
  })
})

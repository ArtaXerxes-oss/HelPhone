import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

function SanityBadge({ title }) {
  return (
    <div data-testid="sanity-badge" className="badge">
      <span>{title}</span>
    </div>
  )
}

describe('Automated Pre-Commit Code Quality Pipeline Sanity Tests', () => {
  it('should render React component cleanly without errors', () => {
    render(<SanityBadge title="HelPhone Quality Pipeline Active" />)
    const element = screen.getByTestId('sanity-badge')
    expect(element).toBeDefined()
    expect(element.textContent).toContain('HelPhone Quality Pipeline Active')
  })

  it('should verify JavaScript & TypeScript execution environment', () => {
    const numbers = [1, 2, 3, 4, 5]
    const squared = numbers.map((n) => n * n)
    expect(squared).toEqual([1, 4, 9, 16, 25])
  })
})

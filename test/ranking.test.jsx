import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'

vi.mock('../src/lib/contract', () => ({
  getRanking: vi.fn(),
}))

import { getRanking } from '../src/lib/contract'
import Ranking from '../src/pages/Ranking.jsx'

function renderRanking() {
  return render(
    <MemoryRouter>
      <Ranking />
    </MemoryRouter>
  )
}

describe('Ranking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders loading skeleton initially', () => {
    getRanking.mockReturnValue(new Promise(() => {})) // never resolves
    renderRanking()
    expect(screen.getByText('RESPONDER')).toBeInTheDocument()
    expect(screen.getByText('ARRIVALS')).toBeInTheDocument()
  })

  it('renders leaderboard rows with mock data', async () => {
    getRanking.mockResolvedValue([
      { responder: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3', total_arrivals: 15 },
      { responder: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC', total_arrivals: 10 },
      { responder: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCD', total_arrivals: 5 },
    ])

    renderRanking()

    await waitFor(() => {
      expect(screen.getByText('15')).toBeInTheDocument()
      expect(screen.getByText('10')).toBeInTheDocument()
      expect(screen.getByText('5')).toBeInTheDocument()
    })
  })

  it('renders empty state when no responders', async () => {
    getRanking.mockResolvedValue([])

    renderRanking()

    await waitFor(() => {
      expect(screen.getByText('No responders yet')).toBeInTheDocument()
    })
  })

  it('renders empty state on error', async () => {
    getRanking.mockRejectedValue(new Error('network error'))

    renderRanking()

    await waitFor(() => {
      expect(screen.getByText('No responders yet')).toBeInTheDocument()
    })
  })

  it('shows period tab buttons', async () => {
    getRanking.mockResolvedValue([])
    renderRanking()

    expect(screen.getByText('This Week')).toBeInTheDocument()
    expect(screen.getByText('This Month')).toBeInTheDocument()
    expect(screen.getByText('All Time')).toBeInTheDocument()
  })

  it('displays truncated responder addresses', async () => {
    getRanking.mockResolvedValue([
      { responder: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3', total_arrivals: 1 },
    ])

    renderRanking()

    await waitFor(() => {
      expect(screen.getByText(/GAAAAAAA…AAA3/)).toBeInTheDocument()
    })
  })

  it('shows responder count', async () => {
    getRanking.mockResolvedValue([
      { responder: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3', total_arrivals: 1 },
    ])

    renderRanking()

    await waitFor(() => {
      expect(screen.getByText(/1 responders/)).toBeInTheDocument()
    })
  })
})

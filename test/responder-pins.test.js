import { describe, expect, it } from 'vitest'
import { collapseResponderPins } from '../src/lib/responderPins.ts'

const DID = 'GCRESPONDERAAAA'

describe('one map pin per responder DID (#922)', () => {
  it('collapses several contract slots for the same DID into one pin', () => {
    const pins = collapseResponderPins([
      { id: '7-0', responder: DID, lat: 6.5, lng: 3.4 },
      { id: '7-1', responder: DID, lat: 6.5, lng: 3.4 },
      { id: '7-2', responder: DID, lat: 6.5, lng: 3.4 },
    ])
    expect(pins).toHaveLength(1)
    expect(pins[0]).toMatchObject({ id: `resp-${DID}`, did: DID, kind: 'enroute' })
  })

  it('the newest record for a DID sets its position', () => {
    const pins = collapseResponderPins([
      { id: '7-0', responder: DID, lat: 6.5, lng: 3.4 },
      { id: '7-1', responder: DID, lat: 6.7, lng: 3.6 },
    ])
    expect(pins).toHaveLength(1)
    expect(pins[0]).toMatchObject({ lat: 6.7, lng: 3.6 })
  })

  it('keeps one pin per distinct DID', () => {
    const pins = collapseResponderPins([
      { id: '7-0', responder: DID, lat: 1, lng: 1 },
      { id: '7-1', responder: 'GCOTHERRESPONDERBBB', lat: 2, lng: 2 },
    ])
    expect(pins.map((p) => p.did)).toEqual([DID, 'GCOTHERRESPONDERBBB'])
  })

  it('treats DIDs that differ only by case or surrounding whitespace as the same responder', () => {
    const pins = collapseResponderPins([
      { id: '7-0', responder: DID.toLowerCase(), lat: 1, lng: 1 },
      { id: '7-1', responder: `  ${DID}  `, lat: 1, lng: 1 },
    ])
    expect(pins).toHaveLength(1)
    expect(pins[0].did).toBe(DID)
  })

  it('marks every pin resolved once the responder has arrived', () => {
    const pins = collapseResponderPins([{ id: '7-0', responder: DID, lat: 1, lng: 1 }], { arrived: true })
    expect(pins[0].kind).toBe('resolved')
  })

  it('drops records without finite coordinates and skips empty entries', () => {
    const pins = collapseResponderPins([
      null,
      undefined,
      { id: '7-0', responder: DID, lat: null, lng: 1 },
      { id: '7-1', responder: 'GCNOFIXAAAAAAAAA', lat: Number.NaN, lng: 1 },
      { id: '7-2', responder: DID, lat: 1, lng: 1 },
    ])
    expect(pins).toHaveLength(1)
    expect(pins[0].did).toBe(DID)
  })

  it('a record with no DID keeps its own pin and is not merged into another DID', () => {
    const pins = collapseResponderPins([
      { id: '9-0', lat: 1, lng: 1 },
      { id: '9-1', lat: 2, lng: 2 },
      { id: '9-2', responder: DID, lat: 3, lng: 3 },
    ])
    expect(pins.map((p) => p.id)).toEqual(['resp-9-0', 'resp-9-1', `resp-${DID}`])
  })

  it('returns no pins for an empty roster', () => {
    expect(collapseResponderPins([])).toEqual([])
  })
})

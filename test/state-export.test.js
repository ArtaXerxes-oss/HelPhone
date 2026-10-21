import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  SorobanStateExporter,
  exportContractState,
  loadLatestSnapshot,
} from '../server/indexer/exporter.js'

describe('Soroban Storage Inspection & State Snapshot Dumps', () => {
  const testOutputDir = './test-snapshots'

  beforeEach(() => {
    if (existsSync(testOutputDir)) {
      rmSync(testOutputDir, { recursive: true, force: true })
    }
    mkdirSync(testOutputDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testOutputDir)) {
      rmSync(testOutputDir, { recursive: true, force: true })
    }
  })

  it('should export contract state and format entries into structured JSON snapshots', async () => {
    const exporter = new SorobanStateExporter(
      'CC325F37QW7N2F5M3QGHL4A4O7J2K9L0M1N2O3P4Q5R6S7T8U9V0',
      'https://soroban-testnet.stellar.org',
      testOutputDir
    )

    const snapshot = await exporter.exportState()

    expect(snapshot).toBeDefined()
    expect(snapshot.contractId).toBe('CC325F37QW7N2F5M3QGHL4A4O7J2K9L0M1N2O3P4Q5R6S7T8U9V0')
    expect(typeof snapshot.ledgerSequence).toBe('number')
    expect(snapshot.ledgerSequence).toBeGreaterThan(0)
    expect(Array.isArray(snapshot.entries)).toBe(true)
    expect(snapshot.entries.length).toBeGreaterThan(0)
    expect(snapshot.metadata).toBeDefined()
    expect(snapshot.metadata.totalEntries).toBe(snapshot.entries.length)
  }, 15000)

  it('should verify snapshot integrity correctly', () => {
    const exporter = new SorobanStateExporter('TEST_CONTRACT', 'http://localhost', testOutputDir)
    const validSnapshot = {
      ledgerSequence: 12345,
      contractId: 'TEST_CONTRACT',
      timestamp: new Date().toISOString(),
      entries: [
        { key: 'KEY_1', val: 'VAL_1', durability: 'persistent' },
        { key: 'KEY_2', val: 'VAL_2', durability: 'instance' },
      ],
      metadata: {
        exporterVersion: '1.0.0',
        totalEntries: 2,
        networkPassphrase: 'Test SDF Network',
        rpcUrl: 'http://localhost',
      },
    }

    expect(exporter.verifySnapshotIntegrity(validSnapshot)).toBe(true)

    const invalidSnapshot = { ...validSnapshot, metadata: { ...validSnapshot.metadata, totalEntries: 99 } }
    expect(exporter.verifySnapshotIntegrity(invalidSnapshot)).toBe(false)
  })

  it('should save snapshot to disk indexed by ledger sequence and load the latest', async () => {
    const exporter = new SorobanStateExporter('TEST_CONTRACT', 'http://localhost', testOutputDir)

    const snapshot1 = {
      ledgerSequence: 100,
      contractId: 'TEST_CONTRACT',
      timestamp: new Date().toISOString(),
      entries: [{ key: 'KEY_1', val: 1, durability: 'instance' }],
      metadata: { exporterVersion: '1.0.0', totalEntries: 1, networkPassphrase: 'Test', rpcUrl: 'http://localhost' },
    }

    const snapshot2 = {
      ledgerSequence: 200,
      contractId: 'TEST_CONTRACT',
      timestamp: new Date().toISOString(),
      entries: [{ key: 'KEY_1', val: 2, durability: 'instance' }],
      metadata: { exporterVersion: '1.0.0', totalEntries: 1, networkPassphrase: 'Test', rpcUrl: 'http://localhost' },
    }

    exporter.saveSnapshot(snapshot1)
    exporter.saveSnapshot(snapshot2)

    expect(existsSync(join(testOutputDir, 'snapshot-100.json'))).toBe(true)
    expect(existsSync(join(testOutputDir, 'snapshot-200.json'))).toBe(true)

    const latest = loadLatestSnapshot(testOutputDir)
    expect(latest).toBeDefined()
    expect(latest.ledgerSequence).toBe(200)
    expect(latest.entries[0].val).toBe(2)
  })

  it('exportContractState helper should return valid snapshot structure', async () => {
    const snapshot = await exportContractState()
    expect(snapshot.ledgerSequence).toBeGreaterThan(0)
    expect(snapshot.metadata.exporterVersion).toBe('1.0.0')
  }, 15000)
})

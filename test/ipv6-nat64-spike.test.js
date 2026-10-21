import { describe, expect, it } from 'vitest'
import {
  classifyEndpoint,
  extractHost,
  findLiteralEndpoints,
  parseDotenv,
} from '../scripts/security/endpoint_literals.js'

describe('IPv6-only / NAT64 endpoint literal check (#786)', () => {
  it('extracts hosts from URLs, bracketed IPv6 and host:port', () => {
    expect(extractHost('https://api.mapbox.com/v4')).toBe('api.mapbox.com')
    expect(extractHost('http://[2001:db8::1]:8000/rpc')).toBe('2001:db8::1')
    expect(extractHost('redis.internal:6379')).toBe('redis.internal')
    expect(extractHost('postgresql://u:p@db.example.com:5432/helphone')).toBe('db.example.com')
    expect(extractHost('/zk')).toBeNull()
    expect(extractHost('')).toBeNull()
  })

  it('classifies hostnames, IPv4 literals, IPv6 literals and loopback', () => {
    expect(classifyEndpoint('https://soroban-testnet.stellar.org')).toBe('hostname')
    expect(classifyEndpoint('http://203.0.113.10:8000')).toBe('ipv4-literal')
    expect(classifyEndpoint('http://[2001:db8::1]:8000')).toBe('ipv6-literal')
    expect(classifyEndpoint('http://localhost:3001')).toBe('loopback')
    expect(classifyEndpoint('http://127.0.0.1:3001')).toBe('loopback')
    expect(classifyEndpoint('http://[::1]:3001')).toBe('loopback')
  })

  it('does not treat non-endpoint values as endpoints', () => {
    expect(classifyEndpoint('testnet')).toBe('hostname')
    expect(classifyEndpoint('1.2.3')).toBe('hostname')
    expect(classifyEndpoint(undefined)).toBeNull()
  })

  it('flags only literal and loopback endpoints in an env map', () => {
    const env = parseDotenv([
      '# comment',
      'VITE_STELLAR_RPC=http://203.0.113.10:8000',
      'VITE_SUPABASE_URL="https://x.supabase.co"',
      'PASSKEY_ORIGIN=http://localhost:3000',
      'REDIS_URL=redis://[2001:db8::5]:6379',
    ].join('\n'))
    expect(findLiteralEndpoints(env)).toEqual([
      { key: 'VITE_STELLAR_RPC', value: 'http://203.0.113.10:8000', kind: 'ipv4-literal' },
      { key: 'PASSKEY_ORIGIN', value: 'http://localhost:3000', kind: 'loopback' },
      { key: 'REDIS_URL', value: 'redis://[2001:db8::5]:6379', kind: 'ipv6-literal' },
    ])
  })
})

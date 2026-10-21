export interface SessionClaims {
  sub: string
  username?: string
  iat?: number
  exp: number
  jti: string
}

export function issueSession(userId: string, username?: string, opts?: { ttlSeconds?: number; jti?: string }): Promise<string>
export function verifySessionToken(token: string): Promise<SessionClaims | null>
export function revokeSession(jti: string, exp?: number): Promise<void>
export function isSessionRevoked(jti: string): Promise<boolean>
export function renewSessionIfNeeded(token: string, claims: SessionClaims): Promise<{ token: string; previousToken: string } | null>
export function __resetSessionsForTests(): Promise<void>

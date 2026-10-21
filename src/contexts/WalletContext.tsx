import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import type { WalletState } from '../types/index.js'
import { generateEd25519Keypair, encryptAESGCM, decryptAESGCM } from '../lib/crypto.js'

interface WalletContextValue {
  walletState: WalletState
  connectWallet: (walletType?: string) => Promise<void>
  disconnectWallet: () => void
  generateEncryptedSessionKey: (passcode: string) => Promise<string>
  decryptSessionKey: (encryptedHex: string, passcode: string) => Promise<string>
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined)

export const WalletProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [walletState, setWalletState] = useState<WalletState>({
    address: null,
    network: 'TESTNET',
    isConnected: false,
    walletType: null,
    passkeyEnabled: true,
  })

  const connectWallet = async (walletType = 'freighter') => {
    // Simulated connection / SWK kit integration
    const mockAddress = 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY5BKGOWTGWCTWMCWHAZ5W6FED'
    setWalletState((prev) => ({
      ...prev,
      address: mockAddress,
      isConnected: true,
      walletType,
    }))
  }

  const disconnectWallet = () => {
    setWalletState((prev) => ({
      ...prev,
      address: null,
      isConnected: false,
      walletType: null,
    }))
  }

  const generateEncryptedSessionKey = async (passcode: string): Promise<string> => {
    const keypair = generateEd25519Keypair()
    const encrypted = await encryptAESGCM(keypair.secretKey, passcode)
    return JSON.stringify(encrypted)
  }

  const decryptSessionKey = async (encryptedJson: string, passcode: string): Promise<string> => {
    const encrypted = JSON.parse(encryptedJson)
    return decryptAESGCM(encrypted, passcode)
  }

  return (
    <WalletContext.Provider
      value={{
        walletState,
        connectWallet,
        disconnectWallet,
        generateEncryptedSessionKey,
        decryptSessionKey,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider')
  }
  return context
}

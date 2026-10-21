import { createContext, useContext } from 'react';

export const WalletStateContext = createContext(null);

export function useWalletState() {
  const context = useContext(WalletStateContext);
  if (!context) {
    throw new Error('useWalletState must be used within WalletStateProvider');
  }
  return context;
}

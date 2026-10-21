import { createContext, useContext } from 'react';

export const WalletActionContext = createContext(null);

export function useWalletActions() {
  const context = useContext(WalletActionContext);
  if (!context) {
    throw new Error('useWalletActions must be used within WalletActionProvider');
  }
  return context;
}

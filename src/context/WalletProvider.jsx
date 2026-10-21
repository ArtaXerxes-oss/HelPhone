import { useState, useCallback, useMemo } from 'react';
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk';
import { KitEventType } from '@creit-tech/stellar-wallets-kit/types';
import { WalletStateContext } from './WalletStateContext';
import { WalletActionContext } from './WalletActionContext';

export function WalletProvider({ children }) {
  const [walletAddress, setWalletAddress] = useState('');
  const [isWalletConnected, setIsWalletConnected] = useState(false);
  const [isNetworkHealthy, setIsNetworkHealthy] = useState(true);

  const walletState = useMemo(
    () => ({
      walletAddress,
      isWalletConnected,
      isNetworkHealthy,
    }),
    [walletAddress, isWalletConnected, isNetworkHealthy]
  );

  const handleConnect = useCallback((address) => {
    setWalletAddress(address);
    setIsWalletConnected(true);
  }, []);

  const handleDisconnect = useCallback(() => {
    setWalletAddress('');
    setIsWalletConnected(false);
  }, []);

  const updateNetworkHealth = useCallback((healthy) => {
    setIsNetworkHealthy(healthy);
  }, []);

  const walletActions = useMemo(
    () => ({
      handleConnect,
      handleDisconnect,
      updateNetworkHealth,
    }),
    [handleConnect, handleDisconnect, updateNetworkHealth]
  );

  StellarWalletsKit.on(KitEventType.CONNECT, (e) => {
    handleConnect(e.detail.address);
  });

  StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
    handleDisconnect();
  });

  return (
    <WalletStateContext.Provider value={walletState}>
      <WalletActionContext.Provider value={walletActions}>
        {children}
      </WalletActionContext.Provider>
    </WalletStateContext.Provider>
  );
}

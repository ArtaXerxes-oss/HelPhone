import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import {
  clearWalletAddress,
  getWalletBalances,
  loadWalletAddress,
  saveWalletAddress,
} from "../lib/contract";

export function sanitizeWalletAddress(raw) {
  if (typeof raw !== "string") return "";
  const addr = raw.trim();
  if (!/^G[A-Z2-7]{55}$/.test(addr)) return "";
  return addr;
}

export function createDebouncedSetter(setter, delay = 100) {
  let latest = "";
  let timer = null;

  const debouncedSet = (value) => {
    latest = value;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      setter(latest);
    }, delay);
  };

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      setter(latest);
    }
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { debouncedSet, flush, cancel };
}

export function computeWalletStatus(address) {
  const hasAddress = address !== "";
  const isValid = sanitizeWalletAddress(address) !== "";
  const isConnected = hasAddress && isValid;
  const displayAddress = isConnected
    ? `${address.slice(0, 8)}...${address.slice(-6)}`
    : "";
  return { isConnected, displayAddress };
}

export function cancellationToken() {
  let cancelled = false;

  return {
    get active() {
      return !cancelled;
    },
    cancel() {
      cancelled = true;
    },
    async wrap(promise) {
      if (cancelled) {
        promise.catch(() => {});
        return undefined;
      }
      try {
        const result = await promise;
        if (cancelled) return undefined;
        return result;
      } catch (err) {
        if (cancelled) return undefined;
        throw err;
      }
    },
  };
}

export function useWalletState({ setProfileOpen }) {
  const [walletAddress, setWalletAddress] = useState("");
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletBalances, setWalletBalances] = useState([]);
  const [walletBalanceStatus, setWalletBalanceStatus] = useState("idle");
  const walletConnectionInFlight = useRef(false);

  const activeWalletAddress =
    typeof walletAddress === "string" && walletAddress.trim().length > 0
      ? walletAddress.trim()
      : "";
  const { isConnected: isWalletConnected, displayAddress } = useMemo(
    () => computeWalletStatus(walletAddress),
    [walletAddress],
  );

  useEffect(() => {
    const token = cancellationToken();
    const {
      debouncedSet,
      flush: flushAddr,
      cancel: cancelAddr,
    } = createDebouncedSetter(setWalletAddress, 100);
    let offState = () => {};
    let offDisconnect = () => {};

    async function syncWallet() {
      try {
        const result = await token.wrap(StellarWalletsKit.getAddress());
        if (result === undefined || result === null) {
          const saved = loadWalletAddress();
          if (saved) {
            try {
              const reconnect = await token.wrap(StellarWalletsKit.getAddress());
              if (reconnect?.address) {
                debouncedSet(sanitizeWalletAddress(reconnect.address));
              } else {
                clearWalletAddress();
                debouncedSet("");
              }
            } catch {
              clearWalletAddress();
              debouncedSet("");
            }
          } else {
            debouncedSet("");
          }
        } else if (typeof result.address === "string") {
          const sanitized = sanitizeWalletAddress(result.address);
          debouncedSet(sanitized);
          if (sanitized) saveWalletAddress(sanitized);
        }
      } catch {
        if (token.active) debouncedSet("");
      } finally {
        if (token.active) setWalletLoading(false);
      }
    }

    syncWallet();
    offState = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
      if (!token.active) return;
      const sanitized = sanitizeWalletAddress(event?.payload?.address);
      debouncedSet(sanitized);
      if (sanitized) saveWalletAddress(sanitized);
      else clearWalletAddress();
    });
    offDisconnect = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
      try {
        if (token.active) debouncedSet("");
      } catch {}
      clearWalletAddress();
      setProfileOpen(false);
    });

    return () => {
      token.cancel();
      flushAddr();
      cancelAddr();
      offState();
      offDisconnect();
    };
  }, [setProfileOpen]);

  useEffect(() => {
    if (!activeWalletAddress) {
      setWalletBalances([]);
      setWalletBalanceStatus("idle");
      return;
    }

    const token = cancellationToken();
    setWalletBalanceStatus("loading");
    token
      .wrap(getWalletBalances(activeWalletAddress))
      .then((balances) => {
        if (!token.active || !balances) return;
        setWalletBalances(balances);
        setWalletBalanceStatus("ready");
      })
      .catch(() => {
        if (!token.active) return;
        setWalletBalances([]);
        setWalletBalanceStatus("error");
      });

    return () => token.cancel();
  }, [activeWalletAddress]);

  const promptWalletConnection = useCallback(async function promptWalletConnection() {
    if (walletConnectionInFlight.current) return "";
    walletConnectionInFlight.current = true;
    setWalletConnecting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { address: raw } = await StellarWalletsKit.authModal();
      const address = sanitizeWalletAddress(raw);
      if (address) {
        setWalletAddress(address);
        return address;
      }
    } catch {
    } finally {
      walletConnectionInFlight.current = false;
      setWalletConnecting(false);
    }
    return "";
  }, []);

  return {
    walletAddress,
    setWalletAddress,
    walletLoading,
    walletConnecting,
    walletBalances,
    walletBalanceStatus,
    activeWalletAddress,
    isWalletConnected,
    displayAddress,
    promptWalletConnection,
  };
}

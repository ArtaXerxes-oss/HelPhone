import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import useDocumentTitle from "../lib/useDocumentTitle";
import {
  getAegisAdmin,
  getAegisPayoutAmount,
  setAegisPayoutAmount,
  upgradeAegisVault,
  getPendingOwner,
  proposeTransfer,
  acceptTransfer,
  revokeTransfer,
  createAdminProposal,
  approveAdminProposal,
  executeAdminProposal,
  getAdminProposal,
  getDaoProposal,
  queueDaoProposal,
  executeDaoProposal,
  approveDaoCancellation,
  cancelQueuedDaoProposal,
  configureDaoSecurityMultisig,
} from "../lib/contract";

function sanitizeAddress(raw) {
  if (typeof raw !== "string") return "";
  const addr = raw.trim();
  if (!/^G[A-Z2-7]{55}$/.test(addr)) return "";
  return addr;
}

function variantName(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" ? Object.keys(value)[0] || "Unknown" : "Unknown";
}

export default function Admin() {
  useDocumentTitle("Admin");

  const [walletAddress, setWalletAddress] = useState("");
  const [contractAdmin, setContractAdmin] = useState(null);
  const [payoutAmount, setPayoutAmount] = useState(null);
  const [newPayout, setNewPayout] = useState("");
  const [wasmHash, setWasmHash] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");

  // ── Ownership transfer state ────────────────────────────────────────────
  const [pendingOwner, setPendingOwner] = useState(null);
  const [transferTarget, setTransferTarget] = useState("");
  const [proposalTarget, setProposalTarget] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [proposal, setProposal] = useState(null);
  const [daoProposalId, setDaoProposalId] = useState("");
  const [daoProposal, setDaoProposal] = useState(null);
  const [guardianInput, setGuardianInput] = useState("");
  const [guardianThreshold, setGuardianThreshold] = useState("1");
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));

  const isOwner =
    walletAddress &&
    contractAdmin &&
    walletAddress.trim() === contractAdmin.trim();
  const daoStatus = variantName(daoProposal?.status);
  const executeAfter = Number(daoProposal?.timelock?.execute_after || 0);
  const votingEnds = Number(daoProposal?.voting_ends || 0);
  const secondsRemaining = Math.max(0, executeAfter - clock);

  useEffect(() => {
    if (!daoProposal) return undefined;
    const timer = window.setInterval(() => setClock(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [daoProposal]);

  useEffect(() => {
    let cancelled = false;
    async function sync() {
      try {
        const result = await StellarWalletsKit.getAddress();
        if (cancelled) return;
        if (result?.address) setWalletAddress(sanitizeAddress(result.address));
      } catch {}
    }
    sync();
    const off = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (e) => {
      if (!cancelled) setWalletAddress(sanitizeAddress(e?.payload?.address));
    });
    const offDisc = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
      if (!cancelled) setWalletAddress("");
    });
    return () => {
      cancelled = true;
      off();
      offDisc();
    };
  }, []);

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const [admin, payout, pending] = await Promise.all([
        getAegisAdmin(),
        getAegisPayoutAmount(),
        getPendingOwner(),
      ]);
      setContractAdmin(admin);
      setPayoutAmount(payout);
      setPendingOwner(pending);
    } catch (err) {
      setMessage("Failed to load admin data: " + err.message);
      setMessageType("error");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  async function handleConnectWallet() {
    try {
      const { address } = await StellarWalletsKit.authModal();
      const sanitized = sanitizeAddress(address);
      if (sanitized) setWalletAddress(sanitized);
    } catch {}
  }

  // ── Ownership transfer handlers ──────────────────────────────────────────

  async function handleProposeTransfer() {
    const target = sanitizeAddress(transferTarget);
    if (!target) {
      setMessage("Enter a valid Stellar address (G…).");
      setMessageType("error");
      return;
    }
    if (target === walletAddress) {
      setMessage("New owner must be a different address.");
      setMessageType("error");
      return;
    }
    setActionLoading(true);
    setMessage("");
    try {
      await proposeTransfer(walletAddress, target, StellarWalletsKit);
      setPendingOwner(target);
      setTransferTarget("");
      setMessage(
        `Transfer proposed to ${target.slice(0, 8)}…  ` +
          "The new owner must connect their wallet and accept.",
      );
      setMessageType("success");
    } catch (err) {
      setMessage("Propose failed: " + err.message);
      setMessageType("error");
    }
    setActionLoading(false);
  }

  async function handleAcceptTransfer() {
    setActionLoading(true);
    setMessage("");
    try {
      await acceptTransfer(walletAddress, StellarWalletsKit);
      setContractAdmin(walletAddress);
      setPendingOwner(null);
      setMessage("Ownership accepted. You are now the contract admin.");
      setMessageType("success");
    } catch (err) {
      setMessage("Accept failed: " + err.message);
      setMessageType("error");
    }
    setActionLoading(false);
  }

  async function handleRevokeTransfer() {
    setActionLoading(true);
    setMessage("");
    try {
      await revokeTransfer(walletAddress, StellarWalletsKit);
      setPendingOwner(null);
      setTransferTarget("");
      setMessage("Pending ownership transfer has been cancelled.");
      setMessageType("info");
    } catch (err) {
      setMessage("Revoke failed: " + err.message);
      setMessageType("error");
    }
    setActionLoading(false);
  }

  async function handleCreateProposal() {
    const target = sanitizeAddress(proposalTarget);
    if (!target) { setMessage("Enter a valid proposed admin address."); setMessageType("error"); return; }
    setActionLoading(true);
    try {
      await createAdminProposal(walletAddress, target, StellarWalletsKit);
      setMessage("Multisig proposal submitted. Enter its on-chain ID to track approvals.");
      setMessageType("success");
      setProposalTarget("");
    } catch (err) { setMessage("Proposal failed: " + err.message); setMessageType("error"); }
    setActionLoading(false);
  }

  async function handleProposalAction(action) {
    const id = Number(proposalId);
    if (!Number.isSafeInteger(id) || id < 1) { setMessage("Enter a valid proposal ID."); setMessageType("error"); return; }
    setActionLoading(true);
    try {
      if (action === "approve") await approveAdminProposal(id, walletAddress, StellarWalletsKit);
      if (action === "execute") await executeAdminProposal(id, walletAddress, StellarWalletsKit);
      setProposal(await getAdminProposal(id));
      setMessage(action === "load" ? "Proposal loaded." : "Proposal " + action + " submitted.");
      setMessageType("success");
    } catch (err) { setMessage("Multisig action failed: " + err.message); setMessageType("error"); }
    setActionLoading(false);
  }

  async function handleDaoAction(action) {
    if (action === "configure") {
      const guardians = guardianInput.split(/[\s,]+/).map(sanitizeAddress).filter(Boolean);
      const threshold = Number(guardianThreshold);
      if (!guardians.length || new Set(guardians).size !== guardians.length ||
          !Number.isSafeInteger(threshold) || threshold < 1 || threshold > guardians.length) {
        setMessage("Enter unique guardian Stellar addresses and a reachable positive threshold.");
        setMessageType("error");
        return;
      }
      setActionLoading(true);
      try {
        await configureDaoSecurityMultisig(walletAddress, guardians, threshold, StellarWalletsKit);
        setMessage("DAO security multisig updated.");
        setMessageType("success");
      } catch (err) {
        setMessage(`DAO security multisig update failed: ${err.message}`);
        setMessageType("error");
      } finally {
        setActionLoading(false);
      }
      return;
    }
    const id = Number(daoProposalId);
    if (!Number.isSafeInteger(id) || id < 1) {
      setMessage("Enter a valid DAO proposal ID.");
      setMessageType("error");
      return;
    }
    setActionLoading(true);
    try {
      if (action === "load") {
        const loaded = await getDaoProposal(id);
        if (!loaded) throw new Error("DAO proposal not found.");
        setDaoProposal(loaded);
      } else {
        if (action === "queue") await queueDaoProposal(id, walletAddress, StellarWalletsKit);
        if (action === "execute") await executeDaoProposal(id, walletAddress, StellarWalletsKit);
        if (action === "approve") await approveDaoCancellation(id, walletAddress, StellarWalletsKit);
        if (action === "cancel") await cancelQueuedDaoProposal(id, walletAddress, StellarWalletsKit);
        setDaoProposal(await getDaoProposal(id));
      }
      setMessage(action === "load" ? "DAO proposal loaded." : `DAO proposal ${action} submitted.`);
      setMessageType("success");
    } catch (err) {
      setMessage(`DAO proposal ${action} failed: ${err.message}`);
      setMessageType("error");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSetPayout() {
    const amt = Number(newPayout);
    if (!Number.isFinite(amt) || amt <= 0) {
      setMessage("Enter a valid positive amount.");
      setMessageType("error");
      return;
    }
    setActionLoading(true);
    setMessage("");
    try {
      const result = await setAegisPayoutAmount(
        walletAddress,
        amt,
        StellarWalletsKit,
      );
      setMessage(`Payout updated to ${amt}. TX: ${result.hash || "submitted"}`);
      setMessageType("success");
      setNewPayout("");
      const updated = await getAegisPayoutAmount();
      setPayoutAmount(updated);
    } catch (err) {
      setMessage("Failed to set payout: " + err.message);
      setMessageType("error");
    }
    setActionLoading(false);
  }

  async function handleUpgrade() {
    if (!wasmHash.trim()) {
      setMessage("Enter a valid WASM hash.");
      setMessageType("error");
      return;
    }
    setActionLoading(true);
    setMessage("");
    try {
      const result = await upgradeAegisVault(
        wasmHash.trim(),
        StellarWalletsKit,
      );
      setMessage(`Contract upgraded. TX: ${result.hash || "submitted"}`);
      setMessageType("success");
      setWasmHash("");
    } catch (err) {
      setMessage("Failed to upgrade: " + err.message);
      setMessageType("error");
    }
    setActionLoading(false);
  }

  const cardStyle = {
    background: "#1c2c24",
    borderRadius: "16px",
    border: "1px solid rgba(255,255,255,0.08)",
    padding: "24px",
    marginBottom: "16px",
  };

  const inputStyle = {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.05)",
    color: "#F4ECDC",
    fontSize: "14px",
    fontFamily: "'Courier New', monospace",
    outline: "none",
  };

  const btnPrimary = {
    padding: "12px 20px",
    borderRadius: "10px",
    border: "none",
    background: actionLoading ? "rgba(115,87,255,0.4)" : "#7357FF",
    color: "#fff",
    fontSize: "14px",
    fontWeight: 700,
    cursor: actionLoading ? "not-allowed" : "pointer",
    minHeight: "44px",
  };

  const btnDanger = {
    ...btnPrimary,
    background: actionLoading ? "rgba(255,122,107,0.4)" : "#FF7A6B",
  };

  if (!walletAddress) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0f1a16",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px",
          fontFamily: "Inter, Helvetica Neue, sans-serif",
        }}
      >
        <Link
          to="/help"
          style={{
            position: "absolute",
            top: "20px",
            left: "20px",
            color: "#7fb8ba",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
          }}
        >
          ← Back to HelPhone
        </Link>
        <div style={{ textAlign: "center" }}>
          <h1
            style={{
              color: "#F4ECDC",
              fontFamily: "'Instrument Serif',serif",
              fontSize: "32px",
              fontWeight: 400,
              margin: "0 0 12px",
            }}
          >
            Admin Access
          </h1>
          <p
            style={{
              color: "rgba(242,236,220,0.5)",
              fontSize: "14px",
              marginBottom: "24px",
              maxWidth: "360px",
            }}
          >
            Connect your Stellar wallet to access the admin dashboard.
          </p>
          <button
            type="button"
            onClick={handleConnectWallet}
            style={{
              ...btnPrimary,
              fontSize: "15px",
              padding: "14px 32px",
            }}
          >
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  if (!isOwner && !loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0f1a16",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px",
          fontFamily: "Inter, Helvetica Neue, sans-serif",
        }}
      >
        <Link
          to="/help"
          style={{
            position: "absolute",
            top: "20px",
            left: "20px",
            color: "#7fb8ba",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
          }}
        >
          ← Back to HelPhone
        </Link>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: "64px",
              height: "64px",
              borderRadius: "50%",
              background: "rgba(255,122,107,0.12)",
              border: "1px solid rgba(255,122,107,0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
              color: "#FF7A6B",
              fontSize: "28px",
            }}
          >
            🔒
          </div>
          <h1
            style={{
              color: "#F4ECDC",
              fontFamily: "'Instrument Serif',serif",
              fontSize: "28px",
              fontWeight: 400,
              margin: "0 0 8px",
            }}
          >
            Access Denied
          </h1>
          <p
            style={{
              color: "rgba(242,236,220,0.45)",
              fontSize: "13px",
              marginBottom: "8px",
            }}
          >
            Connected wallet:
          </p>
          <p
            style={{
              color: "#7fb8ba",
              fontSize: "12px",
              fontFamily: "'Courier New', monospace",
              marginBottom: "20px",
              wordBreak: "break-all",
            }}
          >
            {walletAddress}
          </p>
          {contractAdmin && (
            <>
              <p
                style={{
                  color: "rgba(242,236,220,0.45)",
                  fontSize: "13px",
                  marginBottom: "8px",
                }}
              >
                Contract owner:
              </p>
              <p
                style={{
                  color: "#FF7A6B",
                  fontSize: "12px",
                  fontFamily: "'Courier New', monospace",
                  marginBottom: "24px",
                  wordBreak: "break-all",
                }}
              >
                {contractAdmin}
              </p>
            </>
          )}
          <p
            style={{
              color: "rgba(242,236,220,0.72)",
              fontSize: "12px",
              maxWidth: "380px",
              lineHeight: 1.6,
            }}
          >
            Only the contract owner can access the admin dashboard. Connect the
            wallet that deployed the Aegis Vault contract.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0f1a16",
        padding: "20px",
        fontFamily: "Inter, Helvetica Neue, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: "680px",
          margin: "0 auto",
          paddingTop: "20px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "24px",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <Link
              to="/help"
              style={{
                color: "#7fb8ba",
                textDecoration: "none",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              ← HelPhone
            </Link>
            <h1
              style={{
                color: "#F4ECDC",
                fontFamily: "'Instrument Serif',serif",
                fontSize: "28px",
                fontWeight: 400,
                margin: "6px 0 0",
              }}
            >
              Admin Dashboard
            </h1>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: "#3F8487",
              }}
            />
            <span
              style={{
                fontSize: "11px",
                color: "#3F8487",
                fontWeight: 700,
                letterSpacing: "1px",
              }}
            >
              OWNER
            </span>
          </div>
        </div>

        {message && (
          <div
            style={{
              padding: "12px 16px",
              borderRadius: "10px",
              marginBottom: "16px",
              fontSize: "13px",
              fontWeight: 600,
              background:
                messageType === "success"
                  ? "rgba(63,132,135,0.15)"
                  : messageType === "error"
                    ? "rgba(255,122,107,0.15)"
                    : "rgba(127,184,186,0.15)",
              color:
                messageType === "success"
                  ? "#3F8487"
                  : messageType === "error"
                    ? "#FF7A6B"
                    : "#7fb8ba",
              border: `1px solid ${
                messageType === "success"
                  ? "rgba(63,132,135,0.3)"
                  : messageType === "error"
                    ? "rgba(255,122,107,0.3)"
                    : "rgba(127,184,186,0.3)"
              }`,
            }}
          >
            {message}
          </div>
        )}

        {/* Contract Overview */}
        <div style={cardStyle}>
          <div
            style={{
              fontSize: "10px",
              letterSpacing: "1.5px",
              color: "#7fb8ba",
              fontWeight: 900,
              marginBottom: "16px",
            }}
          >
            CONTRACT OVERVIEW
          </div>
          {loading ? (
            <p style={{ color: "rgba(242,236,220,0.4)", fontSize: "13px" }}>
              Loading contract state...
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
              }}
            >
              <div
                style={{
                  padding: "12px",
                  borderRadius: "10px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div
                  style={{
                    fontSize: "9px",
                    letterSpacing: "1px",
                    color: "rgba(242,236,220,0.72)",
                    marginBottom: "6px",
                  }}
                >
                  CONTRACT ADMIN
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "#F4ECDC",
                    fontFamily: "'Courier New', monospace",
                    wordBreak: "break-all",
                  }}
                >
                  {contractAdmin
                    ? `${contractAdmin.slice(0, 12)}...${contractAdmin.slice(-6)}`
                    : "Not set"}
                </div>
              </div>
              <div
                style={{
                  padding: "12px",
                  borderRadius: "10px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div
                  style={{
                    fontSize: "9px",
                    letterSpacing: "1px",
                    color: "rgba(242,236,220,0.72)",
                    marginBottom: "6px",
                  }}
                >
                  CURRENT PAYOUT
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "#FF7A6B",
                    fontWeight: 700,
                  }}
                >
                  {payoutAmount != null
                    ? `${(payoutAmount / 10_000_000).toFixed(2)} USDC`
                    : "—"}
                </div>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={loadAdminData}
            style={{
              marginTop: "12px",
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "rgba(242,236,220,0.6)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>

        {/* M-of-N Governance */}
        <div style={cardStyle}>
          <div style={{ fontSize: "10px", letterSpacing: "1.5px", color: "#7fb8ba", fontWeight: 900, marginBottom: "12px" }}>MULTISIG GOVERNANCE</div>
          <p style={{ color: "rgba(242,236,220,0.55)", fontSize: "12px", lineHeight: 1.6 }}>Privileged admin transfers execute only after the configured M-of-N threshold is reached.</p>
          <input aria-label="Proposed admin address" value={proposalTarget} onChange={(e) => setProposalTarget(e.target.value)} placeholder="New admin G…" style={inputStyle} />
          <button type="button" disabled={actionLoading} onClick={handleCreateProposal} style={{ ...btnPrimary, marginTop: "10px" }}>Create proposal</button>
          <div style={{ display: "flex", gap: "8px", marginTop: "14px", flexWrap: "wrap" }}>
            <input aria-label="Proposal ID" value={proposalId} onChange={(e) => setProposalId(e.target.value)} placeholder="Proposal ID" inputMode="numeric" style={{ ...inputStyle, width: "160px" }} />
            <button type="button" disabled={actionLoading} onClick={() => handleProposalAction("load")} style={btnPrimary}>Load</button>
            <button type="button" disabled={actionLoading} onClick={() => handleProposalAction("approve")} style={btnPrimary}>Approve</button>
            <button type="button" disabled={actionLoading} onClick={() => handleProposalAction("execute")} style={btnDanger}>Execute</button>
          </div>
          {proposal && <p data-testid="multisig-count" style={{ color: "#F4ECDC", fontSize: "13px" }}>Approvals: {String(proposal.approvals)} · {proposal.executed ? "Executed" : "Pending"}</p>}
        </div>

        {/* Update Payout Amount */}
        <div style={cardStyle}>
          <div
            style={{
              fontSize: "10px",
              letterSpacing: "1.5px",
              color: "#7fb8ba",
              fontWeight: 900,
              marginBottom: "16px",
            }}
          >
            UPDATE PAYOUT AMOUNT
          </div>
          <p
            style={{
              color: "rgba(242,236,220,0.45)",
              fontSize: "12px",
              lineHeight: 1.6,
              marginBottom: "14px",
            }}
          >
            Set the USDC amount each verified claimant receives per campaign.
            Current:{" "}
            <span style={{ color: "#FF7A6B", fontWeight: 700 }}>
              {payoutAmount != null
                ? `${(payoutAmount / 10_000_000).toFixed(2)}`
                : "—"}
            </span>{" "}
            USDC (base units: {payoutAmount ?? "—"}).
          </p>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <input
              type="number"
              value={newPayout}
              onChange={(e) => setNewPayout(e.target.value)}
              placeholder="New payout (USDC)"
              min="0"
              step="0.01"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              onClick={handleSetPayout}
              disabled={actionLoading || !newPayout}
              style={btnPrimary}
            >
              {actionLoading ? "Updating..." : "Update"}
            </button>
          </div>
        </div>

        {/* Upgrade Contract WASM */}
        <div style={cardStyle}>
          <div
            style={{
              fontSize: "10px",
              letterSpacing: "1.5px",
              color: "#7fb8ba",
              fontWeight: 900,
              marginBottom: "16px",
            }}
          >
            UPGRADE CONTRACT VERIFICATION KEY
          </div>
          <p
            style={{
              color: "rgba(242,236,220,0.45)",
              fontSize: "12px",
              lineHeight: 1.6,
              marginBottom: "14px",
            }}
          >
            Replace the contract's WASM bytecode with a new version. The new
            WASM hash must be deployed on Stellar first. Existing storage
            (campaign balances, spent nullifiers) is preserved across upgrades.
          </p>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <input
              type="text"
              value={wasmHash}
              onChange={(e) => setWasmHash(e.target.value)}
              placeholder="New WASM hash (hex)"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              onClick={handleUpgrade}
              disabled={actionLoading || !wasmHash.trim()}
              style={btnDanger}
            >
              {actionLoading ? "Upgrading..." : "Upgrade"}
            </button>
          </div>
        </div>

        {/* Ownership Transfer — Two-Step */}
        <div style={cardStyle}>
          <div
            style={{
              fontSize: "10px",
              letterSpacing: "1.5px",
              color: "#7fb8ba",
              fontWeight: 900,
              marginBottom: "16px",
            }}
          >
            OWNERSHIP TRANSFER
          </div>
          <p
            style={{
              color: "rgba(242,236,220,0.45)",
              fontSize: "12px",
              lineHeight: 1.6,
              marginBottom: "14px",
            }}
          >
            Two-step handoff: propose a new owner, then the recipient accepts
            from their own wallet. Either party can revoke before acceptance.
          </p>

          {/* Current pending transfer banner */}
          {pendingOwner && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
                background: "rgba(255,122,107,0.10)",
                border: "1px solid rgba(255,122,107,0.30)",
                borderRadius: "10px",
                padding: "10px 14px",
                marginBottom: "14px",
              }}
            >
              <span style={{ fontSize: "15px", lineHeight: 1 }}>⏳</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "#FF7A6B",
                    marginBottom: "2px",
                  }}
                >
                  Transfer pending
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "rgba(242,236,220,0.55)",
                    wordBreak: "break-all",
                    fontFamily: "'Courier New', monospace",
                  }}
                >
                  {pendingOwner}
                </div>
              </div>
            </div>
          )}

          {/* Propose new owner — only current admin sees this */}
          {isOwner && !pendingOwner && (
            <div style={{ marginBottom: "10px" }}>
              <div
                style={{
                  fontSize: "11px",
                  color: "rgba(242,236,220,0.45)",
                  marginBottom: "6px",
                }}
              >
                Propose transfer to
              </div>
              <div
                style={{ display: "flex", gap: "10px", alignItems: "center" }}
              >
                <input
                  type="text"
                  value={transferTarget}
                  onChange={(e) => setTransferTarget(e.target.value.trim())}
                  placeholder="New owner address (G…)"
                  aria-label="New owner Stellar address"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={handleProposeTransfer}
                  disabled={actionLoading || !transferTarget}
                  style={{
                    ...btnPrimary,
                    background:
                      actionLoading || !transferTarget
                        ? "rgba(115,87,255,0.35)"
                        : "#7357FF",
                  }}
                >
                  {actionLoading ? "Proposing…" : "Propose"}
                </button>
              </div>
            </div>
          )}

          {/* Accept — shown when connected wallet is the pending new owner */}
          {pendingOwner &&
            walletAddress &&
            walletAddress.trim() === pendingOwner.trim() && (
              <div style={{ marginBottom: "10px" }}>
                <p
                  style={{
                    fontSize: "12px",
                    color: "rgba(242,236,220,0.55)",
                    marginBottom: "10px",
                  }}
                >
                  You have been nominated as the new contract owner. Accept to
                  complete the transfer.
                </p>
                <button
                  type="button"
                  onClick={handleAcceptTransfer}
                  disabled={actionLoading}
                  style={{ ...btnPrimary, width: "100%" }}
                >
                  {actionLoading ? "Accepting…" : "Accept Ownership"}
                </button>
              </div>
            )}

          {/* Revoke — admin cancels proposal, or pending owner declines */}
          {pendingOwner &&
            walletAddress &&
            (walletAddress.trim() === contractAdmin?.trim() ||
              walletAddress.trim() === pendingOwner.trim()) && (
              <button
                type="button"
                onClick={handleRevokeTransfer}
                disabled={actionLoading}
                style={{
                  ...btnDanger,
                  marginTop: "6px",
                  width: "100%",
                  opacity: actionLoading ? 0.6 : 1,
                }}
              >
                {actionLoading ? "Revoking…" : "Revoke Transfer"}
              </button>
            )}
        </div>

        <section style={cardStyle} aria-labelledby="dao-timelock-heading">
          <h2 id="dao-timelock-heading" style={{ color: "#F4ECDC", fontSize: "16px", margin: "0 0 8px" }}>
            DAO proposal timelock
          </h2>
          <p style={{ color: "rgba(242,236,220,0.62)", fontSize: "12px", lineHeight: 1.5 }}>
            Passed proposals must be queued and wait 48 hours before permissionless execution. Security guardians can approve emergency cancellation.
          </p>
          <div style={{ display: "grid", gap: "8px", marginBottom: "14px" }}>
            <label htmlFor="dao-security-guardians" style={{ color: "#F4ECDC", fontSize: "12px" }}>Security guardian addresses</label>
            <textarea
              id="dao-security-guardians"
              value={guardianInput}
              onChange={(event) => setGuardianInput(event.target.value)}
              placeholder="One G... address per line"
              rows={3}
              style={{ ...inputStyle, width: "100%", resize: "vertical" }}
            />
            <label htmlFor="dao-security-threshold" style={{ color: "#F4ECDC", fontSize: "12px" }}>Approval threshold</label>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input
                id="dao-security-threshold"
                type="number"
                min="1"
                max={guardianInput.split(/[\s,]+/).filter(Boolean).length || 1}
                value={guardianThreshold}
                onChange={(event) => setGuardianThreshold(event.target.value)}
                style={{ ...inputStyle, width: "100px" }}
              />
              <button type="button" disabled={actionLoading || !guardianInput.trim()} onClick={() => handleDaoAction("configure")} style={btnPrimary}>
                Configure security multisig
              </button>
            </div>
          </div>
          <label htmlFor="dao-proposal-id" style={{ display: "block", color: "#F4ECDC", fontSize: "12px", marginBottom: "6px" }}>
            Proposal ID
          </label>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <input
              id="dao-proposal-id"
              inputMode="numeric"
              value={daoProposalId}
              onChange={(event) => setDaoProposalId(event.target.value)}
              style={{ ...inputStyle, flex: "1 1 160px" }}
            />
            <button type="button" disabled={actionLoading || !daoProposalId} onClick={() => handleDaoAction("load")} style={btnPrimary}>
              Load
            </button>
          </div>
          {daoProposal && (
            <div style={{ marginTop: "14px", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "12px" }}>
              <p style={{ color: "#F4ECDC", fontSize: "13px", margin: "0 0 8px" }}>
                Status: <strong>{daoStatus}</strong>
              </p>
              {daoStatus === "Queued" && (
                <p role="timer" aria-live="polite" style={{ color: secondsRemaining ? "#7fb8ba" : "#3F8487", fontSize: "13px" }}>
                  {secondsRemaining
                    ? `Execution available in ${Math.floor(secondsRemaining / 3600)}h ${Math.floor((secondsRemaining % 3600) / 60)}m ${secondsRemaining % 60}s`
                    : "Timelock expired; execution is available."}
                </p>
              )}
              <p style={{ color: "rgba(242,236,220,0.62)", fontSize: "12px" }}>
                Emergency approvals: {daoProposal.cancellationApprovals}/{daoProposal.cancellationThreshold}
              </p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {(daoStatus === "Passed" || (daoStatus === "Active" && votingEnds > 0 && clock > votingEnds)) && <button type="button" disabled={actionLoading} onClick={() => handleDaoAction("queue")} style={btnPrimary}>Finalize and queue 48-hour delay</button>}
                {daoStatus === "Queued" && secondsRemaining === 0 && <button type="button" disabled={actionLoading} onClick={() => handleDaoAction("execute")} style={btnPrimary}>Execute</button>}
                {daoStatus === "Queued" && <>
                  <button type="button" disabled={actionLoading} onClick={() => handleDaoAction("approve")} style={btnPrimary}>Approve emergency cancellation</button>
                  <button type="button" disabled={actionLoading || daoProposal.cancellationApprovals < daoProposal.cancellationThreshold} onClick={() => handleDaoAction("cancel")} style={btnDanger}>Cancel queued proposal</button>
                </>}
              </div>
            </div>
          )}
        </section>

        {/* Quick Actions */}
        <div style={cardStyle}>
          <div
            style={{
              fontSize: "10px",
              letterSpacing: "1.5px",
              color: "#7fb8ba",
              fontWeight: 900,
              marginBottom: "16px",
            }}
          >
            QUICK ACTIONS
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "10px",
            }}
          >
            <Link
              to="/help"
              style={{
                padding: "14px",
                borderRadius: "10px",
                background: "rgba(115,87,255,0.1)",
                border: "1px solid rgba(115,87,255,0.25)",
                color: "#B3A6FF",
                fontSize: "13px",
                fontWeight: 700,
                textDecoration: "none",
                textAlign: "center",
              }}
            >
              Open App
            </Link>
            <button
              type="button"
              onClick={handleConnectWallet}
              style={{
                padding: "14px",
                borderRadius: "10px",
                background: "rgba(63,132,135,0.1)",
                border: "1px solid rgba(63,132,135,0.25)",
                color: "#7fb8ba",
                fontSize: "13px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Reconnect Wallet
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

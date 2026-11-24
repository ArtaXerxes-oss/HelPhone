import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { verifyProvenance } from "../utils/verifyProvenance";

const COLORS = {
  checking: "#6f857c",
  verified: "#8fc3c2",
  unverified: "#FF7A6B",
  peer_asserted: "#7357FF",
  tampered: "#FF7A6B",
};

export default function ProvenanceBadge({
  status: propStatus,
  originInstance,
  custodyMarker,
  reason,
  commit,
  label: propLabel,
} = {}) {
  const { t } = useTranslation("common");
  const [result, setResult] = useState({ status: "checking" });

  useEffect(() => {
    if (propStatus || custodyMarker) return;
    let mounted = true;
    verifyProvenance().then((r) => mounted && setResult(r));
    return () => {
      mounted = false;
    };
  }, [propStatus, custodyMarker]);

  const currentStatus =
    propStatus ||
    (custodyMarker === "peer_asserted" ? "peer_asserted" : null) ||
    result.status;

  const isPeer = currentStatus === "peer_asserted";
  const isTampered = currentStatus === "tampered";

  let labelText = propLabel;
  if (!labelText) {
    if (isPeer) {
      labelText = originInstance
        ? `Asserted by peer [${originInstance}]`
        : "Asserted by peer instance";
    } else if (isTampered) {
      labelText = "Tamper detected / unverified peer assertion";
    } else {
      labelText = {
        checking: t("footer.provenanceChecking", "Checking…"),
        verified: t("footer.provenanceVerified", "Verified by DAO"),
        unverified: t("footer.provenanceUnverified", "Unverified"),
      }[currentStatus] || currentStatus;
    }
  }

  const icon = isPeer ? "⇄" : isTampered ? "⚠" : currentStatus === "verified" ? "✓" : currentStatus === "checking" ? "…" : "!";
  const badgeColor = COLORS[currentStatus] || COLORS.unverified;

  return (
    <span
      data-testid={isPeer ? "peer-provenance-badge" : "provenance-badge"}
      role="status"
      title={
        isPeer
          ? `Asserted by peer instance: ${originInstance || "remote"} (not in local DAO custody)`
          : commit
          ? `commit ${commit}`
          : reason || result.reason
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        color: badgeColor,
        border: `1px solid ${badgeColor}`,
        backgroundColor: isPeer ? "rgba(115, 87, 255, 0.08)" : "transparent",
        borderRadius: "999px",
        padding: "3px 10px",
      }}
    >
      <span aria-hidden="true">{icon}</span>
      {labelText}
    </span>
  );
}

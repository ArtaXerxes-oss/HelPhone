import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { verifyProvenance } from "../utils/verifyProvenance";

const COLORS = {
  checking: "#6f857c",
  verified: "#8fc3c2",
  unverified: "#FF7A6B",
};

export default function ProvenanceBadge() {
  const { t } = useTranslation("common");
  const [result, setResult] = useState({ status: "checking" });

  useEffect(() => {
    let mounted = true;
    verifyProvenance().then((r) => mounted && setResult(r));
    return () => {
      mounted = false;
    };
  }, []);

  const label = {
    checking: t("footer.provenanceChecking"),
    verified: t("footer.provenanceVerified"),
    unverified: t("footer.provenanceUnverified"),
  }[result.status];

  return (
    <span
      data-testid="provenance-badge"
      role="status"
      title={result.commit ? `commit ${result.commit}` : result.reason}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        color: COLORS[result.status],
        border: `1px solid ${COLORS[result.status]}`,
        borderRadius: "999px",
        padding: "3px 10px",
      }}
    >
      <span aria-hidden="true">
        {result.status === "verified"
          ? "✓"
          : result.status === "checking"
            ? "…"
            : "!"}
      </span>
      {label}
    </span>
  );
}

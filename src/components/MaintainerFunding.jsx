import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getMaintainerFunding } from "../lib/contract";

const STROOPS = 10_000_000;

export default function MaintainerFunding() {
  const { t } = useTranslation("common");
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let mounted = true;
    getMaintainerFunding()
      .then((s) => mounted && setStats(s))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <span
      data-testid="maintainer-funding"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "12.5px",
        color: "#8fc3c2",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          backgroundColor: "#7357FF",
        }}
      />
      {stats
        ? t("footer.maintainerFunding", {
            bps: Number(stats.fee_bps) / 100,
            count: Number(stats.maintainers),
            paid: (Number(stats.total_disbursed) / STROOPS).toLocaleString(),
          })
        : t("footer.maintainerFundingPending")}
    </span>
  );
}

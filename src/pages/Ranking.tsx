import { useState, useEffect } from "react";
import { getRanking } from "../lib/contract";
import type { RankingEntry } from "../types/index";
import MainLayout from "../components/layout/MainLayout";
import Badge from "../components/shared/Badge";
import styles from "./Ranking.module.css";
import { cx } from "../styles/cssModules";
import { annotateLeaderboard, type ReputationTier } from "../lib/rankingIntegrity";
import { useFeatureFlag } from "../lib/featureFlags.js";

const PERIODS = Object.freeze(["This Week", "This Month", "All Time"]);

const MEDALS = Object.freeze(["🥇", "🥈", "🥉"]);

type RankRow = RankingEntry & { tier?: ReputationTier; score?: number };

export default function Ranking() {
  const [rows, setRows] = useState<RankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("All Time");
  const reputationGated = useFeatureFlag("reputationGatedRanking");

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const entries = await getRanking();
        // Local integrity events are empty until the sync pipeline feeds them;
        // annotateLeaderboard still labels newcomers as probationary (#772).
        const annotated = annotateLeaderboard(entries, []);
        const sorted = annotated.slice(0, 20).map((row) => ({
          responder: row.responder,
          total_arrivals: row.total_arrivals,
          // Tier badges stay on when the integrity flag is enabled (#772).
          tier: reputationGated ? row.tier : undefined,
          score: row.score,
        }));
        setRows(sorted);
      } catch {
        setRows([]);
      }
      setLoading(false);
    }
    load();
  }, [period, reputationGated]);

  return (
    <MainLayout navbar="solid" footer={false}>
      <div className={styles["hp-ranking-content"]}>
        {/* Header */}
        <div className={styles["hp-ranking-header"]}>
          <div className={styles["hp-ranking-label"]}>HELPHONE NETWORK</div>
          <h1 className={styles["hp-ranking-title"]}>Community Responders</h1>
          <p className={styles["hp-ranking-subtitle"]}>
            The people who show up when it matters.
          </p>
        </div>

        {/* Period tabs */}
        <div className={styles["hp-ranking-tabs"]}>
          {Array.isArray(PERIODS) &&
            PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cx(styles["hp-ranking-tab"], period === p && styles["hp-ranking-tab--active"])}
              >
                {p}
              </button>
            ))}
        </div>

        {/* Table */}
        {loading ? (
          <div className={styles["hp-ranking-card"]}>
            <div className={styles["hp-ranking-card-header"]}>
              <span>#</span>
              <span>RESPONDER</span>
              <span style={{ textAlign: "center" }}>ARRIVALS</span>
            </div>
            <p
              style={{
                color: "var(--color-muted)",
                fontSize: "15px",
                padding: "20px",
                textAlign: "center",
                margin: 0,
              }}
            >
              Loading…
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className={styles["hp-ranking-card"]}>
            <div className={styles["hp-ranking-card-header"]}>
              <span>#</span>
              <span>RESPONDER</span>
              <span style={{ textAlign: "center" }}>ARRIVALS</span>
            </div>
            <p
              style={{
                padding: "20px",
                textAlign: "center",
                color: "var(--color-muted)",
                margin: 0,
              }}
            >
              No responders yet
            </p>
          </div>
        ) : (
          <div className={styles["hp-ranking-card"]}>
            {/* Header row */}
            <div className={styles["hp-ranking-card-header"]}>
              <span>#</span>
              <span>RESPONDER</span>
              <span style={{ textAlign: "center" }}>ARRIVALS</span>
            </div>

            {rows.map((row, i) => (
              <div
                key={row.responder}
                className={cx(styles["hp-ranking-row"], i % 2 === 1 && styles["hp-ranking-row--alt"])}
              >
                {/* Rank */}
                <span
                  className={styles["hp-ranking-rank"]}
                  style={{
                    color:
                      i < MEDALS.length
                        ? "var(--color-teal)"
                        : "var(--color-muted)",
                  }}
                >
                  {i < MEDALS.length ? MEDALS[i] : `${i + 1}`}
                </span>

                {/* Address */}
                <div
                  style={{ display: "flex", alignItems: "center", gap: "10px" }}
                >
                  <div
                    className={styles["hp-ranking-avatar"]}
                    style={{
                      background:
                        i < 3 ? "var(--color-teal)" : "var(--color-cream)",
                      color: i < 3 ? "#fff" : "var(--color-primary)",
                    }}
                  >
                    {row.responder[7]?.toUpperCase() || "?"}
                  </div>
                  <span className={styles["hp-ranking-address"]}>
                    {row.responder.slice(0, 8)}…{row.responder.slice(-4)}
                  </span>
                  {row.tier && (
                    <span
                      className={styles["hp-ranking-tier"]}
                      aria-label={
                        row.tier === "proven"
                          ? "Proven responder"
                          : "Probationary responder"
                      }
                      style={{
                        fontSize: "0.7rem",
                        padding: "0.15rem 0.45rem",
                        borderRadius: "999px",
                        background:
                          row.tier === "proven"
                            ? "var(--color-teal)"
                            : "var(--color-cream)",
                        color:
                          row.tier === "proven" ? "#fff" : "var(--color-primary)",
                      }}
                    >
                      {row.tier === "proven" ? "Proven" : "New"}
                    </span>
                  )}
                </div>

                {/* Arrivals — using shared Badge component */}
                <div style={{ textAlign: "center" }}>
                  <Badge variant="coral">{row.total_arrivals}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className={styles["hp-ranking-footnote"]}>
          On-chain leaderboard · {rows.length} responders
        </p>
      </div>
    </MainLayout>
  );
}

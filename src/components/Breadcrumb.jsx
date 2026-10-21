import { Link, useLocation } from "react-router-dom";

const ROUTE_LABELS = {
  "/": "Home",
  "/help": "Help",
  "/ranking": "Ranking",
};

export default function Breadcrumb() {
  const location = useLocation();
  const pathnames = location.pathname.split("/").filter((x) => x);

  if (pathnames.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        position: "fixed",
        top: "70px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 55,
        width: "min(1160px, calc(100% - 32px))",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "8px 14px",
        borderRadius: "10px",
        background: "rgba(18, 28, 20, 0.68)",
        backdropFilter: "blur(28px) saturate(1.4)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
        fontSize: "12px",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <Link
        to="/"
        style={{
          textDecoration: "none",
          color: "rgba(242, 236, 220, 0.55)",
          transition: "color 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "rgba(242, 236, 220, 0.9)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "rgba(242, 236, 220, 0.55)";
        }}
      >
        {ROUTE_LABELS["/"]}
      </Link>
      {pathnames.map((name, index) => {
        const routeTo = `/${pathnames.slice(0, index + 1).join("/")}`;
        const isLast = index === pathnames.length - 1;
        const label = ROUTE_LABELS[routeTo] || name;

        return (
          <span key={routeTo} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ color: "rgba(242, 236, 220, 0.72)" }}>/</span>
            {isLast ? (
              <span style={{ color: "rgba(242, 236, 220, 0.9)", fontWeight: 600 }}>
                {label}
              </span>
            ) : (
              <Link
                to={routeTo}
                style={{
                  textDecoration: "none",
                  color: "rgba(242, 236, 220, 0.55)",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "rgba(242, 236, 220, 0.9)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "rgba(242, 236, 220, 0.55)";
                }}
              >
                {label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

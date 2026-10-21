import { Link } from "react-router-dom";
import Button from "../ui/Button.jsx";
import "./Navbar.css";

/**
 * Navbar — HelPhone layout component
 * Variants: floating (landing) and solid (inner pages)
 */
export default function Navbar({
  variant = "floating",
  showNavLinks = true,
  showCta = true,
}) {
  const isFloating = variant === "floating";
  const navClass = isFloating ? "hp-navbar--floating" : "hp-navbar--solid";

  if (!isFloating) {
    return (
      <nav className={`hp-navbar ${navClass}`}>
        <Link to="/" className="hp-navbar__brand">
          <span className="hp-navbar__brand-hel hp-navbar__brand-hel--solid">
            Hel
          </span>
          <span className="hp-navbar__brand-phone hp-navbar__brand-phone--solid">
            Phone
          </span>
        </Link>
        <Link to="/" className="hp-navbar__link hp-navbar__link--back">
          ← Back to home
        </Link>
      </nav>
    );
  }

  return (
    <nav className={`hp-navbar ${navClass}`}>
      <a
        href="#top"
        className="hp-navbar__brand"
        style={{ textDecoration: "none" }}
      >
        <span className="hp-navbar__brand-hel">Hel</span>
        <span className="hp-navbar__brand-phone">Phone</span>
      </a>

      {showNavLinks && (
        <div className="hp-navbar__links">
          <a href="#how" className="hp-navbar__link">
            How it works
          </a>
          <a href="#trust" className="hp-navbar__link">
            Trust &amp; Safety
          </a>
          <a href="#coverage" className="hp-navbar__link">
            Coverage
          </a>
          <Link to="/ranking" className="hp-navbar__link">
            Ranking
          </Link>
          {showCta && (
            <Button to="/help" variant="nav" style={{ marginLeft: 6 }}>
              Request Help
            </Button>
          )}
        </div>
      )}
    </nav>
  );
}

import "./Footer.css";

export default function Footer() {
  return (
    <footer className="hp-footer">
      <div className="hp-footer__inner">
        <div className="hp-footer__top">
          <div className="hp-footer__brand">
            <div className="hp-footer__brand-row">
              <span className="hp-footer__dot" />
              <span className="hp-footer__logo">HelPhone</span>
            </div>
            <p className="hp-footer__tagline">
              A community help network where the nearest hand finds you on the
              map.
            </p>
          </div>

          <div className="hp-footer__links">
            <div className="hp-footer__col">
              <div className="hp-footer__col-label">PLATFORM</div>
              <a href="#how" className="hp-footer__link">
                How it works
              </a>
              <a href="#community" className="hp-footer__link">
                Live map
              </a>
              <a href="#coverage" className="hp-footer__link">
                Coverage
              </a>
            </div>
            <div className="hp-footer__col">
              <div className="hp-footer__col-label">TRUST</div>
              <a href="#trust" className="hp-footer__link">
                Safety
              </a>
              <a href="#trust" className="hp-footer__link">
                Privacy
              </a>
              <a href="#trust" className="hp-footer__link">
                Verification
              </a>
            </div>
          </div>
        </div>

        <div className="hp-footer__bottom">
          <span className="hp-footer__copy">
            © 2026 HelPhone · Built for neighbours
          </span>
          <span className="hp-footer__motto">
            ▤ help arrives through people
          </span>
        </div>
      </div>
    </footer>
  );
}

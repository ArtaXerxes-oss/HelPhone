import Navbar from "./Navbar.jsx";
import Footer from "./Footer.jsx";
import "./MainLayout.css";

/**
 * MainLayout — encapsulates page structure to reduce boilerplate.
 *
 * Props
 * - children: page content
 * - navbar: 'floating' | 'solid' | false — which navbar to show (false = none)
 * - footer: boolean — show footer
 * - background: optional override
 * - className: extra wrapper class
 */
export default function MainLayout({
  children,
  navbar = "floating",
  footer = true,
  background,
  className = "",
  style,
}) {
  const bgStyle = background ? { background } : undefined;
  const variantClass = navbar === "solid" ? "hp-layout--dark" : "";

  return (
    <div
      className={`hp-layout ${variantClass} ${className}`}
      style={{ ...bgStyle, ...style }}
    >
      {navbar && <Navbar variant={navbar} />}
      <main className="hp-layout__main">{children}</main>
      {footer && <Footer />}
    </div>
  );
}

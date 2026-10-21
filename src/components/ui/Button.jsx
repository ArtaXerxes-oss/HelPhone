import { Link } from "react-router-dom";
import "./Button.css";

/**
 * Button — HelPhone design system.
 *
 * Variants: primary (coral), teal, purple, muted, ghost, outline, nav
 * Sizes: sm, md, lg, rugged (56px glove target, ISP-131)
 * Polymorphic: renders as <Link> when `to` prop is provided, otherwise <button> or <a>
 */
export default function Button({
  children,
  variant = "primary",
  size = "md",
  to,
  href,
  type = "button",
  disabled,
  className = "",
  style,
  icon,
  iconPosition = "right",
  ...props
}) {
  const classes = ["hp-btn", `hp-btn--${variant}`, `hp-btn--${size}`, className]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      {icon && iconPosition === "left" && (
        <span className="hp-btn__icon">{icon}</span>
      )}
      {children}
      {icon && iconPosition === "right" && (
        <span className="hp-btn__icon">{icon}</span>
      )}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={classes} style={style} {...props}>
        {content}
      </Link>
    );
  }

  if (href) {
    return (
      <a href={href} className={classes} style={style} {...props}>
        {content}
      </a>
    );
  }

  return (
    <button
      type={type}
      disabled={disabled}
      className={classes}
      style={style}
      {...props}
    >
      {content}
    </button>
  );
}

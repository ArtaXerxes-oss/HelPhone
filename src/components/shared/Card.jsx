import "./Card.css";

export function Card({
  children,
  variant = "default",
  className = "",
  style,
  ...props
}) {
  const variantClass =
    variant === "dark"
      ? "hp-card--dark"
      : variant === "feature"
        ? "hp-card--feature"
        : "";
  return (
    <div
      className={`hp-card ${variantClass} ${className}`}
      style={style}
      {...props}
    >
      {children}
    </div>
  );
}

export function FeatureCard({
  iconColor = "#7357FF",
  title,
  desc,
  className = "",
  ...props
}) {
  return (
    <div className={`hp-card hp-card--feature ${className}`} {...props}>
      <span className="hp-card__icon-dot" style={{ background: iconColor }} />
      <div>
        <h3 className="hp-card__title">{title}</h3>
        <p className="hp-card__desc">{desc}</p>
      </div>
    </div>
  );
}

export default Card;

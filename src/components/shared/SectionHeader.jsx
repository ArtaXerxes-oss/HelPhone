import "./SectionHeader.css";

export default function SectionHeader({
  label,
  title,
  desc,
  align = "left",
  light = false,
  className = "",
  style,
  children,
}) {
  const alignClass = align === "center" ? "hp-section-header--center" : "";
  const labelClass = light ? "hp-section-header__label--light" : "";
  const titleClass = light ? "hp-section-header__title--light" : "";
  const descClass = light ? "hp-section-header__desc--light" : "";

  return (
    <div
      className={`hp-section-header ${alignClass} ${className}`}
      style={style}
    >
      {label && (
        <div className={`hp-section-header__label ${labelClass}`}>{label}</div>
      )}
      {title && (
        <h2 className={`hp-section-header__title ${titleClass}`}>{title}</h2>
      )}
      {desc && <p className={`hp-section-header__desc ${descClass}`}>{desc}</p>}
      {children}
    </div>
  );
}

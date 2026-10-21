import "./Badge.css";

export default function Badge({
  children,
  variant = "coral",
  className = "",
  style,
  ...props
}) {
  return (
    <span
      className={`hp-badge hp-badge--${variant} ${className}`}
      style={style}
      {...props}
    >
      {children}
    </span>
  );
}

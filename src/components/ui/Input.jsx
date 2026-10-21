import "./Input.css";

/**
 * Input — HelPhone design system.
 *
 * Variants: dark (default, for sidebars/dark sections) and light (for cream pages)
 */
export default function Input({
  label,
  hint,
  error,
  variant = "dark",
  id,
  className = "",
  wrapperClassName = "",
  wrapperStyle,
  style,
  ...props
}) {
  const inputId =
    id ||
    (label
      ? `hp-input-${label.toLowerCase().replace(/\s+/g, "-")}`
      : undefined);
  const variantClass = variant === "light" ? "hp-input--light" : "";
  const errorClass = error ? "hp-input--error" : "";

  return (
    <div className={`hp-input-group ${wrapperClassName}`} style={wrapperStyle}>
      {label && (
        <label
          htmlFor={inputId}
          className={`hp-input-label ${variant === "light" ? "hp-input-label--light" : ""}`}
        >
          {label}
        </label>
      )}
      <div className="hp-input-wrapper">
        <input
          id={inputId}
          className={`hp-input ${variantClass} ${errorClass} ${className}`}
          style={style}
          aria-invalid={!!error}
          aria-describedby={
            error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
          }
          {...props}
        />
      </div>
      {error && (
        <span id={`${inputId}-error`} className="hp-input-error" role="alert">
          {error}
        </span>
      )}
      {hint && !error && (
        <span
          id={`${inputId}-hint`}
          className={`hp-input-hint ${variant === "light" ? "hp-input-hint--light" : ""}`}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

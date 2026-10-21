import { useEffect, useRef } from "react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import "./Modal.css";

/**
 * Modal — HelPhone design system.
 *
 * Props
 * - open: boolean — controls visibility
 * - onClose: () => void — called on overlay click / Escape / close button
 * - title: string — optional header title
 * - size: 'sm' | 'md' | 'lg'
 * - variant: 'dark' | 'light'
 * - closeButton: boolean — show X button (default true)
 * - children: modal body
 * - footer: optional footer node
 */
export default function Modal({
  open,
  onClose,
  title,
  size = "md",
  variant = "dark",
  closeButton = true,
  children,
  footer,
  className = "",
  overlayStyle,
  style,
  ...props
}) {
  const dialogRef = useRef(null);
  useFocusTrap(open, dialogRef);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape" && onClose) onClose();
    }
    document.addEventListener("keydown", onKey);
    // Prevent background scroll
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const variantClass = variant === "light" ? "hp-modal--light" : "";
  const sizeClass = `hp-modal--${size}`;

  return (
    <div
      className="hp-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "hp-modal-title" : undefined}
      onClick={onClose}
      style={overlayStyle}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`hp-modal ${variantClass} ${sizeClass} ${className}`}
        onClick={(e) => e.stopPropagation()}
        style={style}
        {...props}
      >
        {(title || closeButton) && (
          <div className="hp-modal-header">
            {title ? (
              <h2
                id="hp-modal-title"
                className={`hp-modal-title ${variant === "light" ? "hp-modal-title--light" : ""}`}
              >
                {title}
              </h2>
            ) : (
              <span />
            )}
            {closeButton && (
              <button
                type="button"
                aria-label="Close"
                className="hp-modal-close"
                onClick={onClose}
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="hp-modal-body">{children}</div>
        {footer && <div className="hp-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

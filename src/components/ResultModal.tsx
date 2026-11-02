import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type ResultModalContent = {
  message: string;
  detail?: string;
};

type ResultModalProps = ResultModalContent & {
  onConfirm: () => void;
  confirmLabel?: string;
  onCancel?: () => void;
};

export function ResultModal({ message, detail, onConfirm, confirmLabel = "确认", onCancel }: ResultModalProps) {
  const titleId = useId();
  const detailId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusDefault = () => (cancelRef.current ?? confirmRef.current)?.focus();
    focusDefault();
    const keepFocus = (event: FocusEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) focusDefault();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Tab" && cancelRef.current) {
          (document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current)?.focus();
        } else focusDefault();
      }
    };
    document.addEventListener("focusin", keepFocus);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      window.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div className="modal-backdrop result-modal-backdrop" role="presentation">
      <section
        ref={cardRef}
        className="modal-card result-modal-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={detail ? detailId : undefined}
      >
        <h2 id={titleId}>{message}</h2>
        {detail && <p className="result-modal-detail" id={detailId}>{detail}</p>}
        <div className="modal-actions">
          {onCancel && <button ref={cancelRef} className="button-secondary" type="button" onClick={onCancel}>取消</button>}
          <button ref={confirmRef} className="button-primary" type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

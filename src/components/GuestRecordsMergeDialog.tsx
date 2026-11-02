import { useEffect, useRef, type KeyboardEvent } from "react";
import type { GuestMergeRequest } from "../sync/useRecordSync";

type GuestRecordsMergeDialogProps = {
  request: GuestMergeRequest;
  accountEmail?: string;
  onMerge: () => void | Promise<void>;
  onKeepGuest: () => void;
};

export function GuestRecordsMergeDialog({ request, accountEmail, onMerge, onKeepGuest }: GuestRecordsMergeDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const keepGuestRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    keepGuestRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (request.isMerging) dialogRef.current?.focus();
  }, [request.isMerging]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!request.isMerging) onKeepGuest();
    }
    if (event.key !== "Tab") return;
    const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    if (!buttons?.length) {
      event.preventDefault();
      return;
    }
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop guest-merge-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !request.isMerging) onKeepGuest();
    }}>
      <section
        ref={dialogRef}
        className="modal-card guest-merge-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="guest-merge-title"
        aria-describedby="guest-merge-description guest-merge-note"
        aria-busy={request.isMerging}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id="guest-merge-title">合并登录前的记录？</h2>
        {accountEmail && (
          <p className="guest-merge-account">当前账号：<span className="guest-merge-email">{accountEmail}</span></p>
        )}
        <p id="guest-merge-description">
          当前浏览器中有 {request.recordIds.length} 条登录前的记录。要把它们合并到当前账号，并同步到云端吗？
        </p>
        <p id="guest-merge-note">暂不合并的话，这些记录会留在当前浏览器，退出登录后仍能看到。</p>
        {request.errorMessage && <p className="sync-form-message" role="alert">{request.errorMessage}</p>}
        <div className="modal-actions">
          <button ref={keepGuestRef} className="button-secondary" type="button" disabled={request.isMerging} onClick={onKeepGuest}>暂不合并</button>
          <button className="button-primary" type="button" disabled={request.isMerging} onClick={() => void onMerge()}>
            {request.isMerging ? "正在合并…" : "合并到当前账号"}
          </button>
        </div>
      </section>
    </div>
  );
}

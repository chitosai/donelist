import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SyncState } from "../sync/useRecordSync";
import { useAuth } from "../auth/AuthProvider";
import { SyncStatus } from "./SyncStatus";
import { SyncIcon } from "./SyncIcon";

type PanelView = "summary" | "login" | "register" | "confirmation";

type SyncPanelProps = {
  syncState: SyncState;
  onSync: () => void | Promise<void>;
  onExport: () => void | Promise<void>;
  onImport: () => void;
};

function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : "操作失败，请稍后重试。";
  if (/invalid login credentials/i.test(message)) return "邮箱或密码不正确。";
  if (/user already registered/i.test(message)) return "这个邮箱已经注册过了。";
  if (/email rate limit/i.test(message)) return "邮件发送得太频繁，请稍后再试。";
  if (/password should be at least/i.test(message)) return "密码至少需要 6 个字符。";
  return message;
}

export function SyncPanel({ syncState, onSync, onExport, onImport }: SyncPanelProps) {
  const { user, isAuthReady, signIn, signUp, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<PanelView>("summary");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [isPasswordConfirmationTouched, setIsPasswordConfirmationTouched] = useState(false);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const passwordConfirmationRef = useRef<HTMLInputElement>(null);
  const authRequestIdRef = useRef(0);
  const isPasswordMismatch = view === "register" && isPasswordConfirmationTouched && password !== passwordConfirmation;

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (user) {
      setView("summary");
      setMessage("");
      setPassword("");
      setPasswordConfirmation("");
      setIsPasswordConfirmationTouched(false);
    }
  }, [user]);

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || password.length < 6 || isSubmitting) return;
    setMessage("");
    if (view === "register" && password !== passwordConfirmation) {
      setIsPasswordConfirmationTouched(true);
      passwordConfirmationRef.current?.focus();
      return;
    }
    setIsSubmitting(true);
    const requestId = ++authRequestIdRef.current;
    try {
      if (view === "login") {
        await signIn(email.trim(), password);
      } else {
        const result = await signUp(email.trim(), password);
        if (requestId !== authRequestIdRef.current) return;
        setMessage(
          result.isEmailConfirmationRequired
            ? "我们向您发送了一封确认邮件，请点击邮件中的链接完成注册。"
            : "注册成功，正在同步本地记录。",
        );
        if (result.isEmailConfirmationRequired) {
          setPassword("");
          setPasswordConfirmation("");
          setIsPasswordConfirmationTouched(false);
          setView("confirmation");
        }
      }
    } catch (error) {
      if (requestId === authRequestIdRef.current) setMessage(friendlyAuthError(error));
    } finally {
      if (requestId === authRequestIdRef.current) setIsSubmitting(false);
    }
  }

  async function handleSignOut() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      await signOut();
    } catch (error) {
      setMessage(friendlyAuthError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function openAuthView(nextView: "summary" | "login" | "register") {
    // Ignore abandoned requests' UI results; their SDK calls may still finish.
    authRequestIdRef.current += 1;
    setIsSubmitting(false);
    setView(nextView);
    setMessage("");
    setPassword("");
    setPasswordConfirmation("");
    setIsPasswordConfirmationTouched(false);
  }

  const hasSyncAttention = user && (syncState.phase === "error" || syncState.phase === "offline" || syncState.pendingChanges > 0);

  return (
    <div className="sync-menu" ref={containerRef}>
      <button
        className={`sync-menu-button${syncState.phase === "syncing" ? " is-syncing" : ""}`}
        type="button"
        aria-label={user ? "同步与账户" : "登录与数据同步"}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => {
          if (!isOpen && view === "confirmation") {
            openAuthView("summary");
          }
          setIsOpen((current) => !current);
        }}
      >
        <SyncIcon />
        {hasSyncAttention && <span className="sync-attention-dot" aria-hidden="true" />}
      </button>

      {isOpen && (
        <section className="sync-popover" role="dialog" aria-label="同步与账户">
          {!isAuthReady ? (
            <div className="sync-loading">正在读取登录状态…</div>
          ) : user ? (
            <>
              <div className="sync-popover-heading">
                <span>云端同步</span>
                <strong title={user.email}>{user.email}</strong>
              </div>
              <SyncStatus syncState={syncState} />
              {message && <p className="sync-form-message" role="status">{message}</p>}
              <div className="sync-primary-actions">
                <button
                  className="sync-main-action"
                  type="button"
                  disabled={syncState.phase === "syncing"}
                  onClick={() => void onSync()}
                >
                  {syncState.phase === "syncing" ? "同步中…" : "立即同步"}
                </button>
                <button type="button" disabled={isSubmitting} onClick={() => void handleSignOut()}>
                  {isSubmitting ? "正在退出…" : "退出登录"}
                </button>
              </div>
            </>
          ) : view === "confirmation" ? (
            <p className="sync-form-message is-success" role="status">{message}</p>
          ) : view === "summary" ? (
            <>
              <div className="sync-popover-heading">
                <span>尚未登录</span>
                <strong>数据仅保存在本地</strong>
              </div>
              <p className="sync-description">
                未登录时，记录只会保存在当前浏览器中。如果清除网站数据，记录也会一起消失噢。登录后，数据会自动保存到云端，并在不同设备间同步。
              </p>
              <div className="sync-primary-actions">
                <button className="sync-main-action" type="button" onClick={() => openAuthView("login")}>登录</button>
                <button type="button" onClick={() => openAuthView("register")}>注册</button>
              </div>
              <p className="sync-data-note">您可以随时导出自己的数据</p>
              <div className="sync-data-actions">
                <button type="button" onClick={() => void onExport()}>导出数据</button>
                <button type="button" onClick={onImport}>导入数据</button>
              </div>
            </>
          ) : (
            <>
              <button className="sync-back-button" type="button" onClick={() => openAuthView("summary")}>
                ← 返回
              </button>
              <div className="sync-popover-heading auth-heading">
                <span>{view === "login" ? "欢迎回来" : "开始云端同步"}</span>
                <strong>{view === "login" ? "登录" : "注册"}</strong>
              </div>
              <form className="sync-auth-form" onSubmit={submitAuth}>
                <label htmlFor="sync-email">邮箱</label>
                <input
                  id="sync-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoFocus
                />
                <label htmlFor="sync-password">密码</label>
                <input
                  id="sync-password"
                  type="password"
                  minLength={6}
                  autoComplete={view === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                {view === "register" && (
                  <>
                    <span className="sync-password-hint">至少 6 个字符</span>
                    <label htmlFor="sync-password-confirmation">确认密码</label>
                    <input
                      id="sync-password-confirmation"
                      ref={passwordConfirmationRef}
                      type="password"
                      autoComplete="new-password"
                      value={passwordConfirmation}
                      onChange={(event) => setPasswordConfirmation(event.target.value)}
                      onBlur={() => setIsPasswordConfirmationTouched(true)}
                      aria-invalid={isPasswordMismatch || undefined}
                      aria-describedby={isPasswordMismatch ? "sync-password-confirmation-error" : undefined}
                      required
                    />
                    {isPasswordMismatch && (
                      <p className="sync-field-error" id="sync-password-confirmation-error" role="alert">
                        两次输入的密码不一致，请再确认一下。
                      </p>
                    )}
                  </>
                )}
                {message && <p className="sync-form-message" role="status">{message}</p>}
                <button className="sync-main-action" type="submit" disabled={isSubmitting || !email.trim() || password.length < 6 || (view === "register" && !passwordConfirmation)}>
                  {isSubmitting ? "请稍候…" : view === "login" ? "登录" : "创建账户"}
                </button>
              </form>
            </>
          )}
        </section>
      )}
    </div>
  );
}

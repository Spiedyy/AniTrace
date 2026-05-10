"use client";

import { useCallback, useEffect, useRef } from "react";
import { motion } from "motion/react";

interface MalLoginButtonProps {
  isLoggedIn: boolean;
  onLogout: () => void;
  onLoginSuccess: () => void;
}

export default function MalLoginButton({
  isLoggedIn,
  onLogout,
  onLoginSuccess,
}: MalLoginButtonProps) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const handleLogin = useCallback(async () => {
    // Fetch the MAL OAuth URL from our server — it also sets the PKCE cookie.
    // We open the popup directly to MAL's domain so the browser never has to
    // redirect through localhost, which Chrome blocks from popup contexts.
    let malUrl: string;
    try {
      const res = await fetch("/api/auth/mal/url?popup=1");
      if (!res.ok) throw new Error("failed");
      ({ url: malUrl } = await res.json());
    } catch {
      // Network error — fall back to full-page redirect
      window.location.href = "/api/auth/mal";
      return;
    }

    const w = 500, h = 720;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);

    const popup = window.open(
      malUrl,
      "mal_auth",
      `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes`
    );

    if (!popup || popup.closed) {
      // Popup blocked — fall back to full-page redirect
      window.location.href = "/api/auth/mal";
      return;
    }

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== "mal_auth") return;
      cleanup();
      if (e.data.success) onLoginSuccess();
    };

    const poll = setInterval(() => {
      if (popup.closed) cleanup();
    }, 500);

    function cleanup() {
      clearInterval(poll);
      window.removeEventListener("message", onMessage);
      cleanupRef.current = null;
    }

    cleanupRef.current = cleanup;
    window.addEventListener("message", onMessage);
  }, [onLoginSuccess]);

  const buttonBase: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 14px",
    borderRadius: "10px",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "all 0.15s",
  };

  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "16px" }}>
      {isLoggedIn ? (
        <motion.button
          onClick={onLogout}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          style={{
            ...buttonBase,
            background: "var(--color-background-success)",
            color: "var(--color-text-success)",
            border: "1px solid transparent",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          MAL connected · Logout
        </motion.button>
      ) : (
        <motion.button
          onClick={handleLogin}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          style={{
            ...buttonBase,
            background: "var(--color-background-secondary)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-tertiary)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4l2 2" />
          </svg>
          Login with MAL
        </motion.button>
      )}
    </div>
  );
}

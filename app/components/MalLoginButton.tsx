"use client";

interface MalLoginButtonProps {
  isLoggedIn: boolean;
  onLogout: () => void;
}

export default function MalLoginButton({
  isLoggedIn,
  onLogout,
}: MalLoginButtonProps) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "16px" }}>
      {isLoggedIn ? (
        <button
          onClick={onLogout}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "6px 14px",
            borderRadius: "10px",
            background: "var(--color-background-success)",
            color: "var(--color-text-success)",
            fontSize: "12px",
            fontWeight: 500,
            border: "1px solid transparent",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          MAL connected · Logout
        </button>
      ) : (
        <a
          href="/api/auth/mal"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "6px 14px",
            borderRadius: "10px",
            background: "var(--color-background-secondary)",
            color: "var(--color-text-secondary)",
            fontSize: "12px",
            fontWeight: 500,
            border: "1px solid var(--color-border-tertiary)",
            textDecoration: "none",
            transition: "all 0.15s",
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4l2 2" />
          </svg>
          Login with MAL
        </a>
      )}
    </div>
  );
}

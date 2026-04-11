"use client";

interface ProgressBarProps {
  progress: number;
  label: string;
}

export default function ProgressBar({ progress, label }: ProgressBarProps) {
  return (
    <div style={{ marginTop: "24px" }}>
      <div
        style={{
          height: "4px",
          borderRadius: "2px",
          background: "var(--color-background-secondary)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            borderRadius: "2px",
            background: "linear-gradient(90deg, #6366f1, #a855f7)",
            width: `${progress}%`,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      <p
        style={{
          margin: "8px 0 0",
          fontSize: "13px",
          color: "var(--color-text-secondary)",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}
        >
          <path d="M21 12a9 9 0 11-6.219-8.56" />
        </svg>
        {label}
      </p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

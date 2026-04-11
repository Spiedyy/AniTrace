"use client";

interface ToastProps {
  message: string | null;
}

export default function Toast({ message }: ToastProps) {
  if (!message) return null;

  return (
    <>
      <div
        style={{
          position: "fixed",
          bottom: "24px",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "10px 20px",
          borderRadius: "12px",
          background: "var(--color-text-primary)",
          color: "var(--color-background-primary)",
          fontSize: "13px",
          fontWeight: 500,
          zIndex: 999,
          boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
          animation: "slideUp 0.3s ease",
          whiteSpace: "nowrap",
        }}
      >
        {message}
      </div>
      <style>{`
        @keyframes slideUp {
          from { transform: translateX(-50%) translateY(20px); opacity: 0; }
          to { transform: translateX(-50%) translateY(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}

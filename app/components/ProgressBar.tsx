"use client";

import { motion } from "motion/react";

interface ProgressBarProps {
  progress: number;
  label: string;
}

export default function ProgressBar({ progress, label }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, progress));

  return (
    <div style={{ marginTop: "24px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: "8px",
          gap: "12px",
        }}
      >
        <span
          style={{
            fontSize: "12px",
            fontWeight: 500,
            color: "var(--color-text-tertiary)",
            letterSpacing: "0.02em",
          }}
        >
          Identifying anime
        </span>
        <span
          style={{
            fontSize: "12px",
            fontVariantNumeric: "tabular-nums",
            color: "var(--color-text-tertiary)",
          }}
        >
          {clamped}%
        </span>
      </div>
      <div
        style={{
          height: "4px",
          borderRadius: "2px",
          background: "var(--color-background-secondary)",
          overflow: "hidden",
        }}
      >
        <motion.div
          style={{
            height: "100%",
            borderRadius: "2px",
            background: "linear-gradient(90deg, #6366f1, #a855f7)",
          }}
          animate={{ width: `${clamped}%` }}
          transition={{ duration: 0.35, ease: "easeOut" }}
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
        <motion.svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ flexShrink: 0 }}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
        >
          <path d="M21 12a9 9 0 11-6.219-8.56" />
        </motion.svg>
        <motion.span
          key={label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {label}
        </motion.span>
      </p>
    </div>
  );
}

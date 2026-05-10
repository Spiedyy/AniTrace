"use client";

import { motion, AnimatePresence } from "motion/react";

interface ToastProps {
  message: string | null;
}

export default function Toast({ message }: ToastProps) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          key="toast"
          initial={{ opacity: 0, x: 60 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 60 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          style={{
            position: "fixed",
            top: "24px",
            right: "24px",
            padding: "10px 20px",
            borderRadius: "12px",
            background: "var(--color-text-primary)",
            color: "var(--color-background-primary)",
            fontSize: "13px",
            fontWeight: 500,
            zIndex: 999,
            boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
            whiteSpace: "nowrap",
            maxWidth: "calc(100vw - 48px)",
          }}
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

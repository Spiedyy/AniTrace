"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";

interface SearchBarProps {
  url: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  isSearching: boolean;
}

const TIKTOK_URL_REGEX = /^https?:\/\/(www\.|vm\.|m\.)?tiktok\.com\/.+/;

export default function SearchBar({
  url,
  onChange,
  onSearch,
  isSearching,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isEmpty = !url.trim();
  const isInvalid = !isEmpty && !TIKTOK_URL_REGEX.test(url.trim());
  const isDisabled = isSearching || isEmpty;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;

      const target = event.target as HTMLElement | null;
      const isTypingContext =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (isTypingContext && target !== inputRef.current) return;

      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div>
      <motion.div
        style={{
          display: "flex",
          gap: "8px",
          background: "var(--color-background-primary)",
          border: "1px solid var(--color-border-tertiary)",
          borderRadius: "14px",
          padding: "6px",
        }}
        whileFocus={{ borderColor: "var(--color-border-secondary)" }}
        transition={{ duration: 0.2 }}
      >
        <input
          ref={inputRef}
          type="text"
          value={url}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isEmpty && !isSearching) onSearch();
          }}
          placeholder="https://www.tiktok.com/@user/video/..."
          style={{
            flex: 1,
            padding: "10px 12px",
            fontSize: "14px",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--color-text-primary)",
            borderRadius: "10px",
          }}
        />
        <motion.button
          onClick={onSearch}
          disabled={isDisabled}
          whileHover={isDisabled ? {} : { scale: 1.03 }}
          whileTap={isDisabled ? {} : { scale: 0.97 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          style={{
            padding: "10px 20px",
            borderRadius: "10px",
            background: isDisabled ? "var(--color-background-secondary)" : "#6366f1",
            color: isDisabled ? "var(--color-text-tertiary)" : "#fff",
            fontSize: "14px",
            fontWeight: 600,
            border: "none",
            cursor: isDisabled ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {isSearching ? "Searching..." : "Find anime"}
        </motion.button>
      </motion.div>
      <AnimatePresence>
        {isInvalid && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            style={{
              margin: "8px 0 0 6px",
              fontSize: "12px",
              color: "var(--color-text-warning)",
            }}
          >
            Enter a valid TikTok video URL (e.g. https://www.tiktok.com/@user/video/123)
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

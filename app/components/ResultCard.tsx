"use client";

import { motion, AnimatePresence } from "motion/react";
import type { AnimeResult } from "@/types";

interface ResultCardProps {
  anime: AnimeResult;
  isLoggedIn: boolean;
  onAddToList: (malId: number, title: string) => void;
  watchlistActionState?: "idle" | "saving" | "added" | "already_completed";
  onMarkIncorrect: (malId: number) => void;
  expanded: boolean;
  onToggle: () => void;
}

function StarRating({ score }: { score: number }) {
  const stars = Math.round(score / 2);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} width="14" height="14" viewBox="0 0 24 24">
          <path
            d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            fill={i <= stars ? "#F59E0B" : "var(--color-border-secondary)"}
          />
        </svg>
      ))}
      <span
        style={{
          marginLeft: "6px",
          fontSize: "13px",
          fontWeight: 500,
          color: "var(--color-text-primary)",
        }}
      >
        {score}
      </span>
    </div>
  );
}

function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "success" | "info" | "warning";
}) {
  const colors = {
    default: {
      bg: "var(--color-background-secondary)",
      text: "var(--color-text-secondary)",
      border: "var(--color-border-tertiary)",
    },
    success: {
      bg: "var(--color-background-success)",
      text: "var(--color-text-success)",
      border: "transparent",
    },
    info: {
      bg: "var(--color-background-info)",
      text: "var(--color-text-info)",
      border: "transparent",
    },
    warning: {
      bg: "var(--color-background-warning)",
      text: "var(--color-text-warning)",
      border: "transparent",
    },
  };
  const c = colors[variant];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "9999px",
        fontSize: "11px",
        fontWeight: 500,
        background: c.bg,
        color: c.text,
        border: `1px solid ${c.border}`,
        letterSpacing: "0.02em",
      }}
    >
      {children}
    </span>
  );
}

export default function ResultCard({
  anime,
  isLoggedIn,
  onAddToList,
  watchlistActionState = "idle",
  onMarkIncorrect,
  expanded,
  onToggle,
}: ResultCardProps) {
  const displayTitle = anime.titleEnglish || anime.title;
  const subTitle = anime.titleJapanese || anime.title;
  const isActionDisabled =
    watchlistActionState === "saving" ||
    watchlistActionState === "added" ||
    watchlistActionState === "already_completed";
  const addButtonLabel =
    watchlistActionState === "saving"
      ? "Adding..."
      : watchlistActionState === "added"
      ? "Added to plan to watch"
      : watchlistActionState === "already_completed"
      ? "Already completed"
      : "Add to plan to watch";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 28 }}
      whileHover={{ borderColor: "var(--color-border-secondary)" }}
      style={{
        background: "var(--color-background-primary)",
        border: "1px solid var(--color-border-tertiary)",
        borderRadius: "16px",
        overflow: "hidden",
        cursor: "pointer",
      }}
      onClick={onToggle}
    >
      {/* Card header */}
      <div style={{ display: "flex", gap: "16px", padding: "16px" }}>
        <div
          style={{
            width: "100px",
            minWidth: "100px",
            height: "142px",
            borderRadius: "10px",
            overflow: "hidden",
            background: "var(--color-background-secondary)",
            flexShrink: 0,
          }}
        >
          {anime.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={anime.imageUrl}
              alt={displayTitle}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                background:
                  "linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "28px",
                color: "#fff",
                fontWeight: 700,
              }}
            >
              {displayTitle.slice(0, 2)}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <div>
              <h3
                style={{
                  margin: 0,
                  fontSize: "17px",
                  fontWeight: 600,
                  color: "var(--color-text-primary)",
                  lineHeight: 1.3,
                }}
              >
                {displayTitle}
              </h3>
              <p
                style={{
                  margin: "2px 0 0",
                  fontSize: "12px",
                  color: "var(--color-text-tertiary)",
                }}
              >
                {subTitle}
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px", flexShrink: 0 }}>
              <Badge variant="success">
                {Math.round(anime.similarity * 100)}% match
              </Badge>
              <motion.button
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkIncorrect(anime.malId);
                }}
                whileHover={{ color: "var(--color-text-secondary)" }}
                style={{
                  background: "none",
                  border: "none",
                  padding: "0",
                  fontSize: "11px",
                  color: "var(--color-text-tertiary)",
                  cursor: "pointer",
                  textDecoration: "underline",
                  textUnderlineOffset: "2px",
                  whiteSpace: "nowrap",
                }}
              >
                Not this anime
              </motion.button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginTop: "8px",
              flexWrap: "wrap",
            }}
          >
            <StarRating score={anime.score} />
            <span
              style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}
            >
              {anime.year} · {anime.episodes ? `${anime.episodes} eps` : "? eps"}
            </span>
          </div>

          <div
            style={{
              display: "flex",
              gap: "4px",
              marginTop: "8px",
              flexWrap: "wrap",
            }}
          >
            {anime.genres.slice(0, 4).map((g) => (
              <Badge key={g}>{g}</Badge>
            ))}
          </div>
        </div>
      </div>

      {/* Expanded details */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="expanded"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            style={{ overflow: "hidden" }}
          >
            <div
              style={{
                padding: "0 16px 16px",
                borderTop: "1px solid var(--color-border-tertiary)",
              }}
            >
              {anime.synopsis && (
                <p
                  style={{
                    fontSize: "13px",
                    lineHeight: 1.6,
                    color: "var(--color-text-secondary)",
                    margin: "12px 0",
                  }}
                >
                  {anime.synopsis.length > 300
                    ? `${anime.synopsis.slice(0, 300)}…`
                    : anime.synopsis}
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  flexWrap: "wrap",
                  marginBottom: "12px",
                }}
              >
                <Badge variant="info">{anime.status}</Badge>
                {anime.season && anime.year && (
                  <Badge>
                    {anime.season} {anime.year}
                  </Badge>
                )}
                {anime.rating && <Badge>{anime.rating}</Badge>}
                {anime.studios.length > 0 && (
                  <Badge>{anime.studios.join(", ")}</Badge>
                )}
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <motion.a
                  href={anime.malUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  whileHover={{ opacity: 0.85 }}
                  whileTap={{ scale: 0.97 }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "8px 16px",
                    borderRadius: "10px",
                    background: "#2E51A2",
                    color: "#fff",
                    fontSize: "13px",
                    fontWeight: 500,
                    textDecoration: "none",
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  View on MyAnimeList
                </motion.a>

                {isLoggedIn && (
                  <motion.button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddToList(anime.malId, anime.titleEnglish || anime.title);
                    }}
                    disabled={isActionDisabled}
                    whileHover={isActionDisabled ? {} : { scale: 1.02 }}
                    whileTap={isActionDisabled ? {} : { scale: 0.97 }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "8px 16px",
                      borderRadius: "10px",
                      background: isActionDisabled
                        ? "var(--color-background-tertiary)"
                        : "var(--color-background-secondary)",
                      color: isActionDisabled
                        ? "var(--color-text-tertiary)"
                        : "var(--color-text-primary)",
                      fontSize: "13px",
                      fontWeight: 500,
                      border: "1px solid var(--color-border-tertiary)",
                      cursor: isActionDisabled ? "not-allowed" : "pointer",
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
                    </svg>
                    {addButtonLabel}
                  </motion.button>
                )}

                {anime.trailerUrl && (
                  <motion.a
                    href={anime.trailerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "8px 16px",
                      borderRadius: "10px",
                      background: "var(--color-background-secondary)",
                      color: "var(--color-text-secondary)",
                      fontSize: "13px",
                      fontWeight: 500,
                      border: "1px solid var(--color-border-tertiary)",
                      textDecoration: "none",
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Watch trailer
                  </motion.a>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

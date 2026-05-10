"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import SearchBar from "./components/SearchBar";
import ProgressBar from "./components/ProgressBar";
import ResultCard from "./components/ResultCard";
import MalLoginButton from "./components/MalLoginButton";
import Toast from "./components/Toast";
import type { AnimeResult } from "@/types";

type Phase = "idle" | "searching" | "results" | "error";
type WatchlistActionState = "idle" | "saving" | "added" | "already_completed";

const PROGRESS_STEPS = [
  { pct: 15, label: "Validating TikTok URL..." },
  { pct: 30, label: "Fetching video from TikWM..." },
  { pct: 50, label: "Extracting key frames..." },
  { pct: 70, label: "Searching trace.moe database..." },
  { pct: 85, label: "Fetching anime details from MAL..." },
  { pct: 95, label: "Processing results..." },
];

export default function Home() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [results, setResults] = useState<AnimeResult[]>([]);
  const [dismissedMalIds, setDismissedMalIds] = useState<Set<number>>(new Set());
  const [debugImages, setDebugImages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [watchlistStateByMalId, setWatchlistStateByMalId] = useState<Record<number, WatchlistActionState>>({});
  const pendingUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSearchIdRef = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Check login state and handle OAuth redirects on mount
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((data) => setIsLoggedIn(data.loggedIn))
      .catch(() => {});

    const params = new URLSearchParams(window.location.search);
    if (params.get("login") === "success") {
      setIsLoggedIn(true);
      showToast("Connected to MyAnimeList!");
      window.history.replaceState({}, "", "/");
    } else if (params.get("error")) {
      showToast("Failed to connect to MyAnimeList. Please try again.");
      window.history.replaceState({}, "", "/");
    }
  }, [showToast]);

  const handleLogout = useCallback(async () => {
    await fetch("/api/auth/mal/logout", { method: "POST" });
    setIsLoggedIn(false);
    showToast("Logged out from MyAnimeList");
  }, [showToast]);

  const runSearch = useCallback(async (searchUrl: string, excludeIds: number[] = []) => {
    activeSearchIdRef.current += 1;
    const searchId = activeSearchIdRef.current;

    // Cancel any delayed state update still pending from a previous search.
    // Without this, a stale setTimeout can fire mid-search, showing an old toast
    // or resetting phase back to "results" while the new request is still in flight.
    if (pendingUpdateRef.current !== null) {
      clearTimeout(pendingUpdateRef.current);
      pendingUpdateRef.current = null;
    }
    setPhase("searching");
    setProgress(0);
    setDebugImages([]);
    setError(null);
    setExpandedIdx(null);

    // Animate progress while the real request runs in parallel
    let stepIdx = 0;
    const stepInterval = setInterval(() => {
      if (stepIdx < PROGRESS_STEPS.length) {
        setProgress(PROGRESS_STEPS[stepIdx].pct);
        setProgressLabel(PROGRESS_STEPS[stepIdx].label);
        stepIdx++;
      } else {
        setProgress(95);
        setProgressLabel("Almost done...");
        clearInterval(stepInterval);
      }
    }, 900);

    try {
      const body: Record<string, unknown> = { url: searchUrl };
      if (excludeIds.length > 0) body.excludeMalIds = excludeIds;

      const response = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (searchId !== activeSearchIdRef.current) {
        clearInterval(stepInterval);
        return;
      }

      clearInterval(stepInterval);
      setProgress(100);
      setProgressLabel("Done!");

      const data = await response.json();

      pendingUpdateRef.current = setTimeout(() => {
        if (searchId !== activeSearchIdRef.current) return;
        pendingUpdateRef.current = null;
        if (data.debugImages?.length) setDebugImages(data.debugImages);
        if (data.success && data.results.length > 0) {
          // Merge new results with existing ones, avoiding duplicates
          setResults((prev) => {
            const existing = new Set(prev.map((r) => r.malId));
            const merged = [...prev, ...data.results.filter((r: AnimeResult) => !existing.has(r.malId))];
            return merged;
          });
          setPhase("results");
          setExpandedIdx(excludeIds.length > 0 ? null : 0);
        } else {
          if (excludeIds.length > 0) {
            // Retry with exclusions found nothing new — stay in results phase
            setPhase("results");
            showToast(data.error || "No additional matches found.");
          } else {
            setError(
              data.error ||
                "No results found. Try a different video or upload a screenshot."
            );
            setPhase("error");
          }
        }
      }, 400);
    } catch {
      if (searchId !== activeSearchIdRef.current) {
        clearInterval(stepInterval);
        return;
      }
      clearInterval(stepInterval);
      setError("Network error. Please check your connection and try again.");
      setPhase("error");
    }
  }, [showToast]);

  const handleSearch = useCallback(async () => {
    if (!url.trim() || phase === "searching") return;
    setResults([]);
    setDismissedMalIds(new Set());
    setWatchlistStateByMalId({});
    await runSearch(url.trim());
  }, [url, phase, runSearch]);

  const handleMarkIncorrect = useCallback((malId: number) => {
    setDismissedMalIds((prev) => new Set([...prev, malId]));
  }, []);

  const handleRetry = useCallback(() => {
    runSearch(url.trim(), [...dismissedMalIds]);
  }, [url, runSearch, dismissedMalIds]);

  const handleAddToList = useCallback(
    async (malId: number, title: string) => {
      if (watchlistStateByMalId[malId] === "saving") return;
      setWatchlistStateByMalId((prev) => ({ ...prev, [malId]: "saving" }));
      try {
        const response = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ malId }),
        });
        const data = await response.json().catch(() => null);
        if (response.ok) {
          if (data?.skipped && data?.reason === "already_completed") {
            setWatchlistStateByMalId((prev) => ({ ...prev, [malId]: "already_completed" }));
            showToast(`"${title}" is already completed on your MAL list.`);
          } else {
            setWatchlistStateByMalId((prev) => ({ ...prev, [malId]: "added" }));
            showToast(`"${title}" added to your plan to watch list!`);
          }
        } else if (response.status === 401) {
          setWatchlistStateByMalId((prev) => ({ ...prev, [malId]: "idle" }));
          showToast("Please log in with MyAnimeList first.");
        } else {
          setWatchlistStateByMalId((prev) => ({ ...prev, [malId]: "idle" }));
          showToast("Failed to add to watchlist. Please try again.");
        }
      } catch {
        setWatchlistStateByMalId((prev) => ({ ...prev, [malId]: "idle" }));
        showToast("Failed to add to watchlist. Please try again.");
      }
    },
    [showToast, watchlistStateByMalId]
  );

  return (
    <div
      style={{
        fontFamily: "var(--font-geist-sans), sans-serif",
        maxWidth: "640px",
        margin: "0 auto",
        padding: "40px 16px 80px",
      }}
    >
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "32px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            marginBottom: "6px",
          }}
        >
          <svg width="36" height="36" viewBox="0 0 48 48" fill="none">
            <defs>
              <linearGradient id="hg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
                <stop stopColor="#6366f1" />
                <stop offset="1" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            <rect width="48" height="48" rx="12" fill="url(#hg)" />
            {/* Outer ring */}
            <circle cx="24" cy="24" r="16" stroke="white" strokeOpacity="0.22" strokeWidth="1.5" fill="none" />
            {/* Inner lens ring */}
            <circle cx="24" cy="24" r="10.5" stroke="white" strokeOpacity="0.65" strokeWidth="1.5" fill="none" />
            {/* Crosshair ticks */}
            <line x1="24" y1="5" x2="24" y2="10" stroke="white" strokeOpacity="0.65" strokeWidth="2" strokeLinecap="round" />
            <line x1="24" y1="38" x2="24" y2="43" stroke="white" strokeOpacity="0.65" strokeWidth="2" strokeLinecap="round" />
            <line x1="5" y1="24" x2="10" y2="24" stroke="white" strokeOpacity="0.65" strokeWidth="2" strokeLinecap="round" />
            <line x1="38" y1="24" x2="43" y2="24" stroke="white" strokeOpacity="0.65" strokeWidth="2" strokeLinecap="round" />
            {/* Play triangle */}
            <polygon points="21,18 21,30 32,24" fill="white" />
          </svg>
          <h1
            style={{
              margin: 0,
              fontSize: "24px",
              fontWeight: 700,
              color: "var(--color-text-primary)",
              letterSpacing: "-0.5px",
            }}
          >
            AniTrace
          </h1>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "14px",
            color: "var(--color-text-secondary)",
          }}
        >
          Paste a TikTok link, find the anime
        </p>
      </div>

      {/* MAL Login */}
      <MalLoginButton
        isLoggedIn={isLoggedIn}
        onLogout={handleLogout}
        onLoginSuccess={() => {
          setIsLoggedIn(true);
          showToast("Connected to MyAnimeList!");
        }}
      />

      {/* Search input */}
      <SearchBar
        url={url}
        onChange={setUrl}
        onSearch={handleSearch}
        isSearching={phase === "searching"}
      />

      {/* Progress */}
      {phase === "searching" && (
        <ProgressBar progress={progress} label={progressLabel} />
      )}

      {/* Debug image strip — only shown in development when debugImages are present */}
      {debugImages.length > 0 && (
        <details style={{ marginTop: "24px" }}>
          <summary
            style={{
              cursor: "pointer",
              fontSize: "12px",
              color: "var(--color-text-tertiary)",
              userSelect: "none",
              marginBottom: "8px",
            }}
          >
            🔍 Debug — {debugImages.length} image{debugImages.length !== 1 ? "s" : ""} sent to trace.moe
          </summary>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {debugImages.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt={`Frame ${i + 1}`}
                style={{
                  height: "120px",
                  borderRadius: "8px",
                  border: "1px solid var(--color-border-tertiary)",
                  objectFit: "cover",
                }}
              />
            ))}
          </div>
        </details>
      )}

      {/* Error state */}
      <AnimatePresence>
        {phase === "error" && error && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            style={{
              marginTop: "24px",
              padding: "16px",
              borderRadius: "12px",
              background: "var(--color-background-warning)",
              color: "var(--color-text-warning)",
              fontSize: "14px",
              lineHeight: 1.5,
            }}
          >
            {error}
            <div style={{ marginTop: "12px" }}>
              <motion.button
                onClick={() => {
                  setPhase("idle");
                  setError(null);
                }}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                style={{
                  padding: "6px 14px",
                  borderRadius: "8px",
                  background: "var(--color-background-secondary)",
                  color: "var(--color-text-secondary)",
                  fontSize: "12px",
                  fontWeight: 500,
                  border: "1px solid var(--color-border-tertiary)",
                  cursor: "pointer",
                }}
              >
                Try again
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      {phase === "results" && results.length > 0 && (() => {
        const visibleResults = results.filter((r) => !dismissedMalIds.has(r.malId));
        const allDismissed = visibleResults.length === 0;
        return (
          <div style={{ marginTop: "24px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "12px",
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: "16px",
                  fontWeight: 600,
                  color: "var(--color-text-primary)",
                }}
              >
                Results
              </h2>
              <span
                style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}
              >
                {visibleResults.length} match{visibleResults.length !== 1 ? "es" : ""} found
              </span>
            </div>

            {allDismissed ? (
              <div
                style={{
                  padding: "24px 16px",
                  borderRadius: "12px",
                  background: "var(--color-background-secondary)",
                  textAlign: "center",
                }}
              >
                <p style={{ margin: "0 0 12px", fontSize: "14px", color: "var(--color-text-secondary)" }}>
                  None of these matched? Let us try other identification methods.
                </p>
                <button
                  onClick={handleRetry}
                  style={{
                    padding: "10px 20px",
                    borderRadius: "10px",
                    background: "var(--color-text-primary)",
                    color: "var(--color-background-primary)",
                    fontSize: "13px",
                    fontWeight: 500,
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Try other methods
                </button>
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "12px" }}
              >
                {visibleResults.map((anime, i) => (
                  <ResultCard
                    key={anime.malId}
                    anime={anime}
                    isLoggedIn={isLoggedIn}
                    onAddToList={handleAddToList}
                    watchlistActionState={watchlistStateByMalId[anime.malId] ?? "idle"}
                    onMarkIncorrect={handleMarkIncorrect}
                    expanded={expandedIdx === i}
                    onToggle={() =>
                      setExpandedIdx(expandedIdx === i ? null : i)
                    }
                  />
                ))}
              </div>
            )}

            <div
              style={{
                marginTop: "20px",
                padding: "14px 16px",
                background: "var(--color-background-secondary)",
                borderRadius: "12px",
                fontSize: "12px",
                color: "var(--color-text-tertiary)",
                lineHeight: 1.6,
              }}
            >
              <strong style={{ color: "var(--color-text-secondary)" }}>
                How it works:
              </strong>{" "}
              AniTrace downloads the TikTok video, extracts keyframes, and sends
              them to trace.moe&apos;s anime scene database. The best match is
              then looked up on MyAnimeList for full details.
            </div>
          </div>
        );
      })()}

      {/* Idle empty state */}
      {phase === "idle" && (
        <div
          style={{
            textAlign: "center",
            marginTop: "48px",
            color: "var(--color-text-tertiary)",
          }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            style={{ opacity: 0.4, marginBottom: "12px" }}
          >
            <circle
              cx="22"
              cy="22"
              r="14"
              stroke="currentColor"
              strokeWidth="2"
            />
            <line
              x1="32"
              y1="32"
              x2="42"
              y2="42"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <p style={{ margin: 0, fontSize: "14px" }}>
            Paste a TikTok URL above to identify the anime
          </p>
          <p style={{ margin: "4px 0 0", fontSize: "12px", opacity: 0.7 }}>
            Works with anime clips, edits, AMVs, and scene compilations
          </p>
        </div>
      )}

      <Toast message={toast} />
    </div>
  );
}

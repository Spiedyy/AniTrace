"use client";

import { useEffect, useState } from "react";

export default function ShareFromTikTokTip() {
  const [origin, setOrigin] = useState("https://your-app.vercel.app");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const shareUrl = `${origin}/?url=`;

  return (
    <details
      style={{
        marginTop: "16px",
        fontSize: "13px",
        color: "var(--color-text-secondary)",
        lineHeight: 1.5,
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          userSelect: "none",
          color: "var(--color-text-tertiary)",
        }}
      >
        Share from TikTok (no copy-paste)
      </summary>
      <div style={{ marginTop: "10px", paddingLeft: "4px" }}>
        <p style={{ margin: "0 0 10px" }}>
          iPhone does not list websites in TikTok&apos;s share menu. Use a one-time
          Shortcuts setup — then Share → your shortcut → AniTrace opens and searches.
        </p>
        <ol style={{ margin: 0, paddingLeft: "18px" }}>
          <li>Open the <strong>Shortcuts</strong> app → <strong>+</strong> → name it &quot;AniTrace&quot;.</li>
          <li>
            Tap <strong>ⓘ</strong> (Details) → turn on <strong>Show in Share Sheet</strong> →
            accept <strong>URLs</strong> and <strong>Text</strong> only.
          </li>
          <li>
            Add action <strong>Open URL</strong> and set the URL to your site plus the
            shared link, e.g. combine text <code style={{ fontSize: "12px" }}>{shareUrl}</code> with{" "}
            <strong>Shortcut Input</strong> (tap the URL field → select Shortcut Input).
          </li>
          <li>In TikTok: Share → scroll the app row → <strong>AniTrace</strong>.</li>
        </ol>
        <p style={{ margin: "10px 0 0", fontSize: "12px", color: "var(--color-text-tertiary)" }}>
          Android: install AniTrace to your home screen first; it can appear in Share after that.
        </p>
      </div>
    </details>
  );
}

"use client";

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
  const isEmpty = !url.trim();
  const isInvalid = !isEmpty && !TIKTOK_URL_REGEX.test(url.trim());

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: "8px",
          background: "var(--color-background-primary)",
          border: "1px solid var(--color-border-tertiary)",
          borderRadius: "14px",
          padding: "6px",
          transition: "border-color 0.2s",
        }}
      >
        <input
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
        <button
          onClick={onSearch}
          disabled={isSearching || isEmpty}
          style={{
            padding: "10px 20px",
            borderRadius: "10px",
            background:
              isEmpty || isSearching
                ? "var(--color-background-secondary)"
                : "#6366f1",
            color:
              isEmpty || isSearching ? "var(--color-text-tertiary)" : "#fff",
            fontSize: "14px",
            fontWeight: 600,
            border: "none",
            cursor: isEmpty || isSearching ? "not-allowed" : "pointer",
            transition: "all 0.15s",
            whiteSpace: "nowrap",
          }}
        >
          {isSearching ? "Searching..." : "Find anime"}
        </button>
      </div>
      {isInvalid && (
        <p
          style={{
            margin: "8px 0 0 6px",
            fontSize: "12px",
            color: "var(--color-text-warning)",
          }}
        >
          Enter a valid TikTok video URL (e.g. https://www.tiktok.com/@user/video/123)
        </p>
      )}
    </div>
  );
}

import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 180,
          borderRadius: 40,
          background: "linear-gradient(135deg, #6366f1 0%, #a855f7 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Outer ring */}
        <div
          style={{
            position: "absolute",
            width: 130,
            height: 130,
            borderRadius: "50%",
            border: "2.5px solid rgba(255,255,255,0.22)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        />
        {/* Inner ring (lens) */}
        <div
          style={{
            position: "absolute",
            width: 86,
            height: 86,
            borderRadius: "50%",
            border: "2.5px solid rgba(255,255,255,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        />
        {/* Play triangle via clip-path */}
        <div
          style={{
            width: 44,
            height: 50,
            background: "white",
            clipPath: "polygon(0 0, 100% 50%, 0 100%)",
            marginLeft: 8,
          }}
        />
      </div>
    ),
    { ...size }
  );
}

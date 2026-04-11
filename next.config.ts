import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.178.157"],
  // ffmpeg-static ships a platform binary — it must not be bundled.
  serverExternalPackages: ["ffmpeg-static"],
};

export default nextConfig;

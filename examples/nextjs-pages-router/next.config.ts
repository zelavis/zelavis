import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "zelavis",
    "@zelavis/auth",
    "@zelavis/database",
    "@zelavis/server",
  ],
  async rewrites() {
    return [
      {
        source: "/zelavis",
        destination: "/api/zelavis",
      },
      {
        source: "/zelavis/:path*",
        destination: "/api/zelavis/:path*",
      },
    ];
  },
};

export default nextConfig;

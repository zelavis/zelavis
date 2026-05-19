import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "zelavis",
    "@zelavis/auth",
    "@zelavis/db",
    "@zelavis/server",
  ],
};

export default nextConfig;

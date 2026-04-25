import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "zelavis",
    "@zelavis/auth",
    "@zelavis/database",
    "@zelavis/server",
  ],
};

export default nextConfig;

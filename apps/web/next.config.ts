import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @preflight/core ships TypeScript sources.
  transpilePackages: ["@preflight/core"],
};

export default nextConfig;

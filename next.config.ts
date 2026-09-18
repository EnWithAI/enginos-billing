import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The billing routes are an internal API, never a browser surface. Every
  // response must be computed per request — a cached balance is a wrong balance.
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@prisma/client", "@clickhouse/client"],
};

export default nextConfig;

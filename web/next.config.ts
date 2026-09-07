import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // Pin the workspace root: without it Turbopack walks up past the repo and
  // picks up an unrelated package-lock.json from the home directory.
  turbopack: { root: path.join(__dirname) },
};

export default nextConfig;

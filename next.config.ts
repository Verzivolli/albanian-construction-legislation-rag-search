import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite loads its WebAssembly + data files from its own package folder at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  outputFileTracingIncludes: { "/api/ask": ["./node_modules/@electric-sql/pglite/dist/**/*"] },
};

export default nextConfig;

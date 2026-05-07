import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@cesar-arb/shared'],
  // Anchor file tracing to the monorepo root so Next doesn't pick up
  // /Users/vaughanfawcett/package-lock.json as the workspace root.
  outputFileTracingRoot: resolve(__dirname, '../..'),
};

export default nextConfig;

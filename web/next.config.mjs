/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3000';

const nextConfig = {
  reactStrictMode: true,

  /**
   * Proxy the API through this origin.
   *
   * Not a convenience — a requirement. The refresh token is an httpOnly
   * cookie with SameSite=Strict scoped to /api/v1/auth. A browser on
   * localhost:3001 will not send that cookie to localhost:3000, so without
   * this rewrite silent refresh silently never works and every reload bounces
   * the user to the login screen.
   *
   * Proxying makes the API same-origin from the browser's point of view, which
   * is also how it should be deployed in production.
   */
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_ORIGIN}/api/v1/:path*` }];
  },

  // The build's job here is to catch type errors. Lint config comes later.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;

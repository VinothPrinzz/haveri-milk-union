/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // API calls proxy to the Fastify API in dev
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:3001/api/:path*",
      },
    ];
  },
};

export default nextConfig;

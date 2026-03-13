import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    /* config options here */
    typescript: {
        ignoreBuildErrors: true
    },
    async redirects() {
        return [
            {
                source: "/",
                destination: '/meetings',
                permanent: false
            }
        ]
    },
};

export default nextConfig;
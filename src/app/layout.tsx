import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TRPCReactProvider } from "@/trpc/client";

const inter = Inter({
    subsets:['latin'],
    variable:'--font-sans'
});

export const metadata: Metadata = {
    title: "Meet-AI | AI Meeting Assistant",
    description: "Meet-AI is an AI-powered meeting platform that enables video calls, automatic transcription, smart summaries, and an intelligent assistant to revisit and analyze conversations.",
    icons: {
        icon: "/images/logo.svg",
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <TRPCReactProvider>
            <html lang="en" className={cn("font-sans", inter.variable)}>
                <body
                className={`${inter.className} antialiased`}
                >
                    <TooltipProvider>
                        {children}
                    </TooltipProvider>
                </body>
            </html>
        </TRPCReactProvider>
    );
}
"use client";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const HomeView = () => {

    const router = useRouter();
  
    const { data: session } = authClient.useSession();

    useEffect(() => {
        if (!session) {
            router.push("/sign-in");
        }
    }, [session, router]);

    if (!session) return null;

    return (
        <div className="flex flex-col p-4 gap-y-4">
            <p>Logged In As {session.user.name}</p>
            <Button 
            onClick={() => authClient.signOut({
                fetchOptions: { 
                    onSuccess: () => router.push("/sign-in")
                }
            })}
            >
                Logout
            </Button>
        </div>
    );
}
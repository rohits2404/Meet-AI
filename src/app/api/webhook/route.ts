import OpenAI from "openai";
import { and, eq, not } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  MessageNewEvent,
  CallSessionParticipantLeftEvent,
  CallSessionStartedEvent,
  CallEndedEvent,
  CallTranscriptionReadyEvent,
  CallRecordingReadyEvent,
} from "@stream-io/node-sdk";
import { db } from "@/db";
import { agents, meetings } from "@/db/schema";
import { streamVideo } from "@/lib/stream-video";
import { inngest } from "@/inngest/client";
import { generateAvatarURI } from "@/lib/avatar";
import { streamChat } from "@/lib/stream-chat";

const groqClient = new OpenAI({
    apiKey: process.env.GROQ_API_KEY!,
    baseURL: "https://api.groq.com/openai/v1",
});

function verifySignatureWithSDK(body: string, signature: string): boolean {
  return streamVideo.verifyWebhook(body, signature);
}

export async function POST(req: NextRequest) {
    const signature = req.headers.get("x-signature");
    const apiKey = req.headers.get("x-api-key");

    if (!signature || !apiKey) {
        return NextResponse.json(
            { error: "Missing Signature Or API Key" },
            { status: 400 }
        );
    }

    const body = await req.text();

    if (!verifySignatureWithSDK(body, signature)) {
        return NextResponse.json({ error: "Invalid Signature" }, { status: 401 });
    }

    let payload: unknown;

    try {
        payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const eventType = (payload as Record<string, unknown>)?.type;

    // -----------------------------
    // CALL SESSION STARTED
    // -----------------------------
    if (eventType === "call.session_started") {
        const event = payload as CallSessionStartedEvent;
        const meetingId = event.call.custom?.meetingId;

        if (!meetingId) {
            return NextResponse.json({ error: "Missing MeetingId" }, { status: 400 });
        }

        const [existingMeeting] = await db
        .select()
        .from(meetings)
        .where(
            and(
                eq(meetings.id, meetingId),
                not(eq(meetings.status, "completed")),
                not(eq(meetings.status, "active")),
                not(eq(meetings.status, "cancelled")),
                not(eq(meetings.status, "processing"))
            )
        );

        if (!existingMeeting) {
            return NextResponse.json({ error: "Meeting Not Found" }, { status: 404 });
        }

        await db
        .update(meetings)
        .set({
            status: "active",
            startedAt: new Date(),
        })
        .where(eq(meetings.id, existingMeeting.id));
    }

    // -----------------------------
    // PARTICIPANT LEFT
    // -----------------------------
    else if (eventType === "call.session_participant_left") {
        const event = payload as CallSessionParticipantLeftEvent;

        const meetingId = event.call_cid.split(":")[1];

        const call = streamVideo.video.call("default", meetingId);

        await call.end();
    }

    // -----------------------------
    // CALL ENDED
    // -----------------------------
    else if (eventType === "call.session_ended") {
        const event = payload as CallEndedEvent;

        const meetingId = event.call.custom?.meetingId;

        await db
        .update(meetings)
        .set({
            status: "processing",
            endedAt: new Date(),
        })
        .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
    }

    // -----------------------------
    // TRANSCRIPT READY
    // -----------------------------
    else if (eventType === "call.transcription_ready") {
        const event = payload as CallTranscriptionReadyEvent;

        const meetingId = event.call_cid.split(":")[1];

        const [updatedMeeting] = await db
        .update(meetings)
        .set({
            transcriptUrl: event.call_transcription.url,
        })
        .where(eq(meetings.id, meetingId))
        .returning();

        if (!updatedMeeting) {
            return NextResponse.json({ error: "Meeting Not Found" }, { status: 404 });
        }

        await inngest.send({
            name: "meetings/processing",
            data: {
                meetingId: updatedMeeting.id,
                transcriptUrl: updatedMeeting.transcriptUrl,
            },
        });
    }

    // -----------------------------
    // RECORDING READY
    // -----------------------------
    else if (eventType === "call.recording_ready") {
        const event = payload as CallRecordingReadyEvent;

        const meetingId = event.call_cid.split(":")[1];

        await db
        .update(meetings)
        .set({
            recordingUrl: event.call_recording.url,
        })
        .where(eq(meetings.id, meetingId));
    }

    // -----------------------------
    // CHAT MESSAGE
    // -----------------------------
    else if (eventType === "message.new") {
        const event = payload as MessageNewEvent;

        const userId = event.user?.id;
        const channelId = event.channel_id;
        const text = event.message?.text;

        if (!userId || !channelId || !text) {
            return NextResponse.json(
                { error: "Missing required fields" },
                { status: 400 }
            );
        }

        const [existingMeeting] = await db
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, channelId), eq(meetings.status, "completed")));

        if (!existingMeeting) {
            return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
        }

        const [existingAgent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, existingMeeting.agentId));

        if (!existingAgent) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }

        if (userId !== existingAgent.id) {
            const instructions = `
            You are an AI assistant helping the user revisit a recently completed meeting.

            Meeting summary:
            ${existingMeeting.summary}

            Agent instructions:
            ${existingAgent.instructions}

            Answer user questions based on the meeting summary.
            Be concise and accurate.
            `;

            const channel = streamChat.channel("messaging", channelId);

            await channel.watch();

            const previousMessages = channel.state.messages
            .slice(-5)
            .filter((msg) => msg.text && msg.text.trim() !== "")
            .map<ChatCompletionMessageParam>((message) => ({
                role:
                    message.user?.id === existingAgent.id ? "assistant" : "user",
                content: message.text || "",
            }));

            const groqResponse = await groqClient.chat.completions.create({
                model: "openai/gpt-oss-20b",
                messages: [
                    { role: "system", content: instructions },
                    ...previousMessages,
                    { role: "user", content: text },
                ],
            });

            const aiText = groqResponse.choices[0]?.message?.content;

            if (!aiText) {
                return NextResponse.json(
                    { error: "No response from AI" },
                    { status: 400 }
                );
            }

            const avatarUrl = generateAvatarURI({
                seed: existingAgent.name,
                variant: "botttsNeutral",
            });

            await streamChat.upsertUser({
                id: existingAgent.id,
                name: existingAgent.name,
                image: avatarUrl,
            });

            await channel.sendMessage({
                text: aiText,
                user: {
                    id: existingAgent.id,
                    name: existingAgent.name,
                    image: avatarUrl,
                },
            });
        }
    }

    return NextResponse.json({ status: "ok" });
}
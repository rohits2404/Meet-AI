import { eq, inArray } from "drizzle-orm";
import JSONL from "jsonl-parse-stringify";
import { db } from "@/db";
import { agents, meetings, user } from "@/db/schema";
import { inngest } from "@/inngest/client";

import { StreamTranscriptItem } from "@/modules/meetings/types";

const SYSTEM_PROMPT = `
You are an expert summarizer. You write readable, concise, simple content. You are given a transcript of a meeting and you need to summarize it.

Use the following markdown structure for every output:

### Overview
Provide a detailed, engaging summary of the session's content. Focus on major features, user workflows, and any key takeaways. Write in a narrative style, using full sentences. Highlight unique or powerful aspects of the product, platform, or discussion.

### Notes
Break down key content into thematic sections with timestamp ranges. Each section should summarize key points, actions, or demos in bullet format.

Example:
#### Section Name
- Main point or demo shown here
- Another key insight or interaction
- Follow-up tool or explanation provided

#### Next Section
- Feature X automatically does Y
- Mention of integration with Z
`.trim();

export const meetingsProcessing = inngest.createFunction(
    { id: "meetings/processing" },
    { event: "meetings/processing" },
    async ({ event, step }) => {

        // ✅ Fetch and parse transcript inside step.run — replay-safe
        const transcript = await step.run("fetch-transcript", async () => {
            const response = await fetch(event.data.transcriptUrl);

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch transcript: ${response.status} ${response.statusText}`
                );
            }

            const text = await response.text();

            if (text.startsWith("<!DOCTYPE")) {
                throw new Error(`Expected JSONL but got HTML: ${text.slice(0, 200)}`);
            }

            return JSONL.parse<StreamTranscriptItem>(text);
        });

        // ✅ Add speakers
        const transcriptWithSpeakers = await step.run("add-speakers", async () => {
            const speakerIds = [
                ...new Set(transcript.map((item) => item.speaker_id)),
            ];

            const userSpeakers = await db
                .select()
                .from(user)
                .where(inArray(user.id, speakerIds))
                .then((users) => users.map((u) => ({ ...u })));

            const agentSpeakers = await db
                .select()
                .from(agents)
                .where(inArray(agents.id, speakerIds))
                .then((agentList) => agentList.map((a) => ({ ...a })));

            const speakers = [...userSpeakers, ...agentSpeakers];

            return transcript.map((item) => {
                const speaker = speakers.find((s) => s.id === item.speaker_id);
                return {
                    ...item,
                    user: {
                        name: speaker?.name ?? "Unknown",
                    },
                };
            });
        });

        // ✅ Use step.fetch to offload Groq API call to Inngest platform
        // This prevents Vercel timeout — your function doesn't sit waiting for the AI response
        const groqResponse = await step.fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                },
                body: JSON.stringify({
                    model: "openai/gpt-oss-20b",
                    messages: [
                        {
                            role: "system",
                            content: SYSTEM_PROMPT,
                        },
                        {
                            role: "user",
                            content:
                                "Summarize the following transcript: " +
                                JSON.stringify(transcriptWithSpeakers),
                        },
                    ],
                    max_tokens: 2000,
                }),
            }
        );

        const summary = await step.run("parse-summary", async () => {
            if (!groqResponse.ok) {
                const error = await groqResponse.text();
                throw new Error(`Groq API error: ${groqResponse.status} - ${error}`);
            }

            const data = await groqResponse.json();
            return data.choices[0].message.content as string;
        });

        // ✅ Save summary to DB
        await step.run("save-summary", async () => {
            await db
                .update(meetings)
                .set({
                    summary: summary,
                    status: "completed",
                })
                .where(eq(meetings.id, event.data.meetingId));
        });
    },
);
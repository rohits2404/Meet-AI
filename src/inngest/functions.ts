import { eq, inArray } from "drizzle-orm";
import JSONL from "jsonl-parse-stringify";
import { createAgent, openai, TextMessage } from "@inngest/agent-kit";
import { db } from "@/db";
import { agents, meetings, user } from "@/db/schema";
import { inngest } from "@/inngest/client";

import { StreamTranscriptItem } from "@/modules/meetings/types";

const summarizer = createAgent({
    name: "summarizer",
    system: `
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
  `.trim(),
    model: openai({
        model: "openai/gpt-oss-20b",
        apiKey: process.env.GROQ_API_KEY,
        baseUrl: "https://api.groq.com/openai/v1",
    }),
});

export const meetingsProcessing = inngest.createFunction(
    { id: "meetings/processing" },
    { event: "meetings/processing" },
    async ({ event, step }) => {

        // ✅ Fetch and parse inside step.run so it's durable and replay-safe
        const transcript = await step.run("fetch-transcript", async () => {
            const response = await fetch(event.data.transcriptUrl);

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch transcript: ${response.status} ${response.statusText}`
                );
            }

            const text = await response.text();

            if (text.startsWith("<!DOCTYPE")) {
                throw new Error(`Expected JSONL but got HTML: ${text.slice(0,200)}`);
            }
            
            return JSONL.parse<StreamTranscriptItem>(text);
        });

        // ✅ Add speakers — unchanged logic, but now replay-safe
        const transcriptWithSpeakers = await step.run("add-speakers", async () => {
            const speakerIds = [
                ...new Set(transcript.map((item) => item.speaker_id)),
            ];

            const userSpeakers = await db
                .select()
                .from(user)
                .where(inArray(user.id, speakerIds))
                .then((users) =>
                    users.map((u) => ({ ...u }))
                );

            const agentSpeakers = await db
                .select()
                .from(agents)
                .where(inArray(agents.id, speakerIds))
                .then((agentList) =>
                    agentList.map((a) => ({ ...a }))
                );

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

        // ✅ summarizer.run wrapped in step.run so AI call is durable
        const summary = await step.run("summarize", async () => {
            const { output } = await summarizer.run(
                "Summarize the following transcript: " +
                    JSON.stringify(transcriptWithSpeakers)
            );
            return (output[0] as TextMessage).content as string;
        });

        // ✅ Save summary
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
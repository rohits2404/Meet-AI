import { eq, inArray } from "drizzle-orm";
import JSONL from "jsonl-parse-stringify";
import { createAgent, openai, TextMessage } from "@inngest/agent-kit";
import { db } from "@/db";
import { agents, meetings, user } from "@/db/schema";
import { inngest } from "@/inngest/client";

import { StreamTranscriptItem } from "@/modules/meetings/types";

/**
 * AI Summarizer Agent
 */
const summarizer = createAgent({
  name: "summarizer",
  system: `
You are an expert meeting summarizer.

You write readable, concise, structured summaries.

Use the following markdown structure for every output:

### Overview
Provide a detailed narrative summary of the meeting.

### Notes
Break down key content into sections with bullet points.

### Action Items
List any tasks or follow-ups mentioned.

### Decisions
Important decisions made during the meeting.
`.trim(),

  model: openai({
    model: "openai/gpt-oss-20b",
    apiKey: process.env.GROQ_API_KEY,
    baseUrl: "https://api.groq.com/openai/v1",
  }),
});

/**
 * Split transcript into chunks
 */
function chunkTranscript(
  transcript: StreamTranscriptItem[],
  chunkSize = 20
) {
  const chunks: StreamTranscriptItem[][] = [];

  for (let i = 0; i < transcript.length; i += chunkSize) {
    chunks.push(transcript.slice(i, i + chunkSize));
  }

  return chunks;
}

export const meetingsProcessing = inngest.createFunction(
  { id: "meetings/processing" },
  { event: "meetings/processing" },

  async ({ event, step }) => {
    /**
     * Fetch transcript safely (CloudFront-safe headers)
     */
    const transcriptText = await step.run(
      "fetch-transcript",
      async () => {
        const res = await fetch(event.data.transcriptUrl, {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });

        const text = await res.text();

        if (!res.ok) {
          throw new Error(`Transcript fetch failed: ${text}`);
        }

        if (text.startsWith("<")) {
          throw new Error(
            `Expected JSONL but received HTML: ${text.slice(0, 200)}`
          );
        }

        return text;
      }
    );

    /**
     * Parse transcript JSONL
     */
    const transcript = await step.run(
      "parse-transcript",
      async () => {
        return JSONL.parse<StreamTranscriptItem>(transcriptText);
      }
    );

    /**
     * Attach speaker names
     */
    const transcriptWithSpeakers = await step.run(
      "add-speakers",
      async () => {
        const speakerIds = [
          ...new Set(transcript.map((item) => item.speaker_id)),
        ];

        const userSpeakers = await db
          .select()
          .from(user)
          .where(inArray(user.id, speakerIds));

        const agentSpeakers = await db
          .select()
          .from(agents)
          .where(inArray(agents.id, speakerIds));

        const speakers = [...userSpeakers, ...agentSpeakers];

        return transcript.map((item) => {
          const speaker = speakers.find(
            (s) => s.id === item.speaker_id
          );

          if (!speaker) {
            return {
              ...item,
              user: { name: "Unknown" },
            };
          }

          return {
            ...item,
            user: { name: speaker.name },
          };
        });
      }
    );

    /**
     * Chunk transcript
     */
    const chunks = await step.run(
      "chunk-transcript",
      async () => {
        return chunkTranscript(transcriptWithSpeakers);
      }
    );

    /**
     * Summarize chunks in parallel (faster)
     */
    const chunkSummaries = await step.run(
      "summarize-chunks",
      async () => {
        const summaries = await Promise.all(
          chunks.map(async (chunk) => {
            const { output } = await summarizer.run(
              "Summarize this meeting segment:\n" +
                JSON.stringify(chunk)
            );

            return (output[0] as TextMessage).content as string;
          })
        );

        return summaries;
      }
    );

    /**
     * Generate final summary
     */
    const finalSummary = await step.run(
      "final-summary",
      async () => {
        const { output } = await summarizer.run(`
Combine the following meeting summaries into one structured meeting report.

${chunkSummaries.join("\n\n")}
`);

        return (output[0] as TextMessage).content as string;
      }
    );

    /**
     * Save summary
     */
    await step.run("save-summary", async () => {
      await db
        .update(meetings)
        .set({
          summary: finalSummary,
          status: "completed",
        })
        .where(eq(meetings.id, event.data.meetingId));
    });
  }
);


import manual from "@/data/manual-chunks.json";
import { generateObject, streamText } from "ai";
import { z } from "zod";

const MAX_ATTEMPTS = 5;
const CONFIDENCE_THRESHOLD = 0.3;

type Level3Chunk = {
  id: string;
  title: string;
  summary: string;
  page: number;
  section: string;
  content: string;
};

type Level2Chunk = {
  id: string;
  title: string;
  summary: string;
  page: number;
  level3: Level3Chunk[];
};

type Level1Chunk = {
  id: string;
  title: string;
  summary: string;
  page: number;
  level2: Level2Chunk[];
};

const selectionSchema = z.object({
  selectedChunkId: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const finalAnswerSchema = z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  sourceChunkId: z.string(),
  reasoning: z.string(),
});

export async function POST(req: Request) {
  const { messages } = (await req.json()) as {
    messages: Array<{ role: string; content?: Array<{ text: string }> }>;
  };

  const lastUser = [...(messages ?? [])]
    .reverse()
    .find((m) => m.role === "user");
  const userText = lastUser?.content?.map((c) => c.text).join(" ") ?? "";

  const trail: Array<{ level: number; id: string; title: string; confidence: number }>=[];
  let attempts = 0;

  const selectLevel = async <T extends { id: string; title: string; summary: string }>(
    level: number,
    options: T[],
    parentTitles: string[],
  ) => {
    attempts += 1;

    const optionText = options
      .map((o) => `${o.id}: ${o.title} — ${o.summary}`)
      .join("\n");

    const { object } = await generateObject({
      model: "google/gemini-2.0-flash",
      schema: selectionSchema,
      system:
        "You must pick exactly one option id. If none are relevant, pick the closest and lower confidence. Use only the provided options.",
      prompt: `User question: ${userText}\nParent path: ${parentTitles.join(" > ") || "(root)"}\nOptions:\n${optionText}`,
    });

    return object;
  };

  const l1 = manual as { level1: Level1Chunk[] };
  if (!l1.level1?.length) {
    return new Response("No manual data", { status: 500 });
  }

  // Level 1 selection
  const l1Pick = await selectLevel(1, l1.level1, []);
  const chosenL1 = l1.level1.find((c) => c.id === l1Pick.selectedChunkId);
  if (!chosenL1) {
    return Response.json({ message: "Could not map level 1 selection" }, { status: 400 });
  }
  trail.push({ level: 1, id: chosenL1.id, title: chosenL1.title, confidence: l1Pick.confidence });

  if (l1Pick.confidence < CONFIDENCE_THRESHOLD && attempts >= MAX_ATTEMPTS) {
    return fallback(trail, userText);
  }

  // Level 2 selection
  const l2Pick = await selectLevel(2, chosenL1.level2, [chosenL1.title]);
  const chosenL2 = chosenL1.level2.find((c) => c.id === l2Pick.selectedChunkId);
  trail.push({ level: 2, id: l2Pick.selectedChunkId, title: chosenL2?.title ?? "", confidence: l2Pick.confidence });

  if (!chosenL2 || l2Pick.confidence < CONFIDENCE_THRESHOLD) {
    if (attempts >= MAX_ATTEMPTS) return fallback(trail, userText);
  }

  // Level 3 selection (answer)
  const l3Options = chosenL2?.level3 ?? [];
  if (!l3Options.length) {
    return fallback(trail, userText);
  }

  attempts += 1;
  const l3OptionText = l3Options
    .map((o) => `${o.id}: ${o.title} — ${o.summary}`)
    .join("\n");

  const { object: finalPick } = await generateObject({
    model: "google/gemini-2.0-flash",
    schema: finalAnswerSchema,
    system:
      "Answer ONLY using the provided chunks. Do not invent info. Include the chosen sourceChunkId.",
    prompt: `User question: ${userText}\nPath: ${chosenL1.title} > ${chosenL2?.title ?? ""}\nAvailable chunks:\n${l3OptionText}`,
  });

  const chosenL3 = l3Options.find((c) => c.id === finalPick.sourceChunkId) ?? l3Options[0];
  trail.push({ level: 3, id: chosenL3.id, title: chosenL3.title, confidence: finalPick.confidence });

  const stream = streamText({
    model: "google/gemini-2.0-flash",
    messages: [
      {
        role: "system",
        content: `You are a helper. Use only the provided chunk. Always show progress lines first.
Progress format:
Step 1: Selected ${chosenL1.title}
Step 2: Selected ${chosenL2?.title ?? ""}
Step 3: Answering with ${chosenL3.title}

Then output:
Answer: <short answer>
Confidence: <0-1>
Source: ${chosenL1.title} > ${chosenL2?.title ?? ""} > ${chosenL3.title}
Link: manual.pdf#page=${chosenL3.page}
`,
      },
      {
        role: "user",
        content: `User question: ${userText}\nChunk content:\n${chosenL3.content}`,
      },
    ],
  });

  return stream.toAIStreamResponse();
}

function fallback(
  trail: Array<{ level: number; id: string; title: string; confidence: number }>,
  userText: string,
) {
  const attempted = trail
    .map((t) => `Level ${t.level}: ${t.title || t.id} (confidence ${t.confidence.toFixed(2)})`)
    .join("\n");

  return Response.json({
    answer: "I could not find a confident answer in the manual. Please ask a manual-related question or provide the correct guidance.",
    attempted,
    userText,
  });
}import { createResource } from "@/lib/actions/resources";
//import { findRelevantContent } from "@/lib/ai/embedding";
import {
  convertToModelMessages,
  generateObject,
  stepCountIs,
  streamText,
  tool,
  UIMessage,
} from "ai";
import { z } from "zod";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: "google/gemini-2.0-flash",
    messages: convertToModelMessages(messages),
    system: `This is where information goes in in general.
`,
    stopWhen: stepCountIs(5),
    tools: {
      addResource: tool({
        description: `add a resource to your knowledge base.
          If the user provides a random piece of knowledge unprompted, use this tool without asking for confirmation.`,
        inputSchema: z.object({
          content: z
            .string()
            .describe("the content or resource to add to the knowledge base"),
        }),
        execute: async ({ content }) => createResource({ content }),
      }),
      /*
      getInformation: tool({
        description: `get information from your knowledge base to answer questions.`,
        inputSchema: z.object({
          question: z.string().describe("the users question"),
          similarQuestions: z.array(z.string()).describe("keywords to search"),
        }),
        execute: async ({ similarQuestions }) => {
          const results = await Promise.all(
            similarQuestions.map(
              //async (question) => await findRelevantContent(question),
            ),
          );
          // Flatten the array of arrays and remove duplicates based on 'name'
          const uniqueResults = Array.from(
            new Map(results.flat().map((item) => [item?.name, item])).values(),
          );
          return uniqueResults;
        },
      }),
      */

      understandQuery: tool({
        description: `understand the users query. use this tool on every prompt.`,
        inputSchema: z.object({
          query: z.string().describe("the users query"),
          toolsToCallInOrder: z
            .array(z.string())
            .describe(
              "these are the tools you need to call in the order necessary to respond to the users query",
            ),
        }),
        execute: async ({ query }) => {
          const { object } = await generateObject({
            model: "google/gemini-2.0-flash",
            system:
              "You are a query understanding assistant. Analyze the user query and generate similar questions.",
            schema: z.object({
              questions: z
                .array(z.string())
                .max(3)
                .describe("similar questions to the user's query. be concise."),
            }),
            prompt: `Analyze this query: "${query}". Provide the following:
                    3 similar questions that could help answer the user's query`,
          });
          return object.questions;
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}

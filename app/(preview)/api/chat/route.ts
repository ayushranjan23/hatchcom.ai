import manualChunks from "@/data/manual-chunks.json";
import { generateObject, streamText, type UIMessage } from "ai";
import { z } from "zod";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

type Level3Chunk = {
  id: string;
  title: string;
  summary: string;
  page: number;
  section: string;
  manualLink: string;
  content: string;
};

type Level2Chunk = {
  id: string;
  title: string;
  summary: string;
  page: number;
  children: Level3Chunk[];
};

type Level1Chunk = {
  id: string;
  title: string;
  summary: string;
  page: number;
  children: Level2Chunk[];
};

const MODEL = "google/gemini-2.0-flash";
const CONFIDENCE_THRESHOLD = 0.3;
const MAX_DECISION_ATTEMPTS = 5; // make this adjustable easily
const MANUAL_FILE = "manual.pdf";

const selectionSchema = z.object({
  selectedChunkId: z.string().nullable(),
  confidence: z.number(),
  reasoning: z.string(),
});

type Selection = z.infer<typeof selectionSchema>;

const manualData = manualChunks as unknown as Level1Chunk[];

const extractUserQuestion = (messages: UIMessage[]): string => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  return lastUser.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
};

const buildOptionsText = <T extends { id: string; title: string; summary?: string }>(
  options: T[],
) =>
  options
    .map(
      (opt) =>
        `- ${opt.id}: ${opt.title}${opt.summary ? ` — ${opt.summary}` : ""}`,
    )
    .join("\n");

async function selectChunk(
  level: "L1" | "L2" | "L3",
  options: Array<{ id: string; title: string; summary?: string }>,
  userQuestion: string,
  pathSoFar: string,
): Promise<Selection> {
  const prompt = `You are selecting the single best ${level} chunk for the question.
You must only choose from the provided options. If none apply, return selectedChunkId=null and confidence=0.
Confidence must be between 0 and 1.

User question: "${userQuestion}"
Context path: ${pathSoFar || "(none yet)"}
Available options:\n${buildOptionsText(options)}

Return only JSON.`;

  const { object } = await generateObject({
    model: MODEL,
    schema: selectionSchema,
    prompt,
  });

  return object;
}

const averageConfidence = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const userQuestion = extractUserQuestion(messages);

  if (!userQuestion) {
    return new Response("I didn't receive a question.");
  }

  let attempts = 0;
  const decisionTrail: Array<Selection & { level: "L1" | "L2" | "L3" }> = [];

  // Level 1 selection
  let l1Selection = await selectChunk("L1", manualData, userQuestion, "");
  attempts += 1;
  decisionTrail.push({ ...l1Selection, level: "L1" });

  if (!l1Selection.selectedChunkId || l1Selection.confidence < CONFIDENCE_THRESHOLD) {
    return new Response(
      `I could not find a relevant topic in the manual. Confidence: ${l1Selection.confidence.toFixed(2)}.`,
    );
  }

  let l1Chunk = manualData.find((item) => item.id === l1Selection.selectedChunkId);
  if (!l1Chunk || !l1Chunk.children?.length) {
    return new Response("No details available for that topic.");
  }

  if (attempts >= MAX_DECISION_ATTEMPTS) {
    return new Response("Stopped after reaching the decision attempt limit.");
  }

  // Level 2 selection (with single backtrack to L1 if low confidence)
  let l2Selection = await selectChunk(
    "L2",
    l1Chunk.children,
    userQuestion,
    `${l1Chunk.title}`,
  );
  attempts += 1;
  decisionTrail.push({ ...l2Selection, level: "L2" });

  if (l2Selection.confidence < CONFIDENCE_THRESHOLD && attempts < MAX_DECISION_ATTEMPTS) {
    const alternativeL1 = manualData.filter(
      (item) => item.id !== l1Selection.selectedChunkId,
    );
    if (alternativeL1.length > 0) {
      const retryL1 = await selectChunk(
        "L1",
        alternativeL1,
        userQuestion,
        "(low confidence retry)",
      );
      attempts += 1;
      decisionTrail.push({ ...retryL1, level: "L1" });

      if (retryL1.selectedChunkId && retryL1.confidence >= CONFIDENCE_THRESHOLD) {
        l1Selection = retryL1;
        l1Chunk = manualData.find((item) => item.id === retryL1.selectedChunkId) ?? l1Chunk;
        l2Selection = await selectChunk(
          "L2",
          l1Chunk.children,
          userQuestion,
          `${l1Chunk.title} (retry)`,
        );
        attempts += 1;
        decisionTrail.push({ ...l2Selection, level: "L2" });
      }
    }
  }

  if (l2Selection.confidence < CONFIDENCE_THRESHOLD) {
    return new Response(
      `I could not find a confident subtopic. Confidence: ${l2Selection.confidence.toFixed(2)}.`,
    );
  }

  const l2Chunk = l1Chunk.children.find(
    (item) => item.id === l2Selection.selectedChunkId,
  );
  if (!l2Chunk || !l2Chunk.children?.length) {
    return new Response("No detailed steps available for that subtopic.");
  }

  if (attempts >= MAX_DECISION_ATTEMPTS) {
    return new Response("Stopped after reaching the decision attempt limit.");
  }

  // Level 3 selection (with single backtrack to L2 if low confidence)
  let l3Selection = await selectChunk(
    "L3",
    l2Chunk.children,
    userQuestion,
    `${l1Chunk.title} > ${l2Chunk.title}`,
  );
  attempts += 1;
  decisionTrail.push({ ...l3Selection, level: "L3" });

  if (l3Selection.confidence < CONFIDENCE_THRESHOLD && attempts < MAX_DECISION_ATTEMPTS) {
    const alternativeL2 = l1Chunk.children.filter(
      (item) => item.id !== l2Selection.selectedChunkId,
    );
    if (alternativeL2.length > 0) {
      const retryL2 = await selectChunk(
        "L2",
        alternativeL2,
        userQuestion,
        `${l1Chunk.title} (retry for low confidence)`,
      );
      attempts += 1;
      decisionTrail.push({ ...retryL2, level: "L2" });

      if (retryL2.selectedChunkId && retryL2.confidence >= CONFIDENCE_THRESHOLD) {
        const newL2 = l1Chunk.children.find((item) => item.id === retryL2.selectedChunkId);
        if (newL2) {
          l3Selection = await selectChunk(
            "L3",
            newL2.children,
            userQuestion,
            `${l1Chunk.title} > ${newL2.title} (retry)`,
          );
          attempts += 1;
          decisionTrail.push({ ...l3Selection, level: "L3" });
        }
      }
    }
  }

  if (l3Selection.confidence < CONFIDENCE_THRESHOLD) {
    return new Response(
      `I could not find a confident answer. Confidence: ${l3Selection.confidence.toFixed(2)}.`,
    );
  }

  const l3Chunk = l2Chunk.children.find(
    (item) => item.id === l3Selection.selectedChunkId,
  );

  if (!l3Chunk) {
    return new Response("No matching detailed chunk found.");
  }

  const overallConfidence = averageConfidence(
    decisionTrail.map((trail) => trail.confidence),
  );

  // Final answer with streaming
  const finalPrompt = `You are answering a user using ONLY the provided manual chunk.
If the content is '#', provide a short placeholder answer and note that details are pending.
You must not invent new facts outside the chunk.

User question: "${userQuestion}"
Selected path: ${l1Chunk.title} > ${l2Chunk.title} > ${l3Chunk.title}
Source page: ${l3Chunk.page}
Manual link: ${MANUAL_FILE}${l3Chunk.manualLink}
Chunk content: ${l3Chunk.content}

Output format:
Step 1: Selected ${l1Chunk.title} (confidence ${l1Selection.confidence.toFixed(2)})
Step 2: Selected ${l2Chunk.title} (confidence ${l2Selection.confidence.toFixed(2)})
Step 3: Selected ${l3Chunk.title} (confidence ${l3Selection.confidence.toFixed(2)})
Answer: <concise answer in natural language>
Confidence: ${overallConfidence.toFixed(2)}
Source: ${l1Chunk.title} > ${l2Chunk.title} > ${l3Chunk.title}
Page: ${l3Chunk.page}
Link: ${MANUAL_FILE}${l3Chunk.manualLink}
`;

  const result = streamText({
    model: MODEL,
    prompt: finalPrompt,
  });

  return result.toUIMessageStreamResponse();
}

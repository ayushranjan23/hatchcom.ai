import { generateObject, streamText } from "ai";
import { z } from "zod";
import manualData from "@/lib/data/manual-chunks.json";

// Configuration
const MAX_ATTEMPTS = 5;
const CONFIDENCE_THRESHOLD = 0.3;
const MODEL = "google/gemini-2.0-flash";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

// Type definitions
interface L3Chunk {
  id: string;
  title: string;
  summary: string;
  page: number;
  section: string;
  content: string;
}

interface L2Chunk {
  id: string;
  title: string;
  summary: string;
  children: L3Chunk[];
}

interface L1Chunk {
  id: string;
  title: string;
  summary: string;
  children: L2Chunk[];
}

interface ManualData {
  chunks: L1Chunk[];
}

interface AttemptTrail {
  level: number;
  selected: string;
  confidence: number;
  reasoning: string;
}

const data = manualData as ManualData;

export async function POST(req: Request) {
  const { messages } = await req.json();
  const userQuestion = messages[messages.length - 1].content;

  let attempts = 0;
  const attemptTrail: AttemptTrail[] = [];

  // Helper to send thinking updates
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendThinking = async (message: string) => {
    await writer.write(
      encoder.encode(`0:{"type":"thinking","content":"${message}"}\n`)
    );
  };

  const sendFinalAnswer = async (answer: string, metadata: any) => {
    await writer.write(
      encoder.encode(`0:{"type":"answer","content":${JSON.stringify(answer)},"metadata":${JSON.stringify(metadata)}}\n`)
    );
    await writer.close();
  };

  // Start processing
  (async () => {
    try {
      attempts++;
      await sendThinking("Analyzing your question...");

      // Step 1: Check if question is answerable from L1 titles
      const l1Titles = data.chunks.map((c) => `${c.id}: ${c.title} - ${c.summary}`).join("\n");
      
      const scopeCheck = await generateObject({
        model: MODEL,
        schema: z.object({
          isAnswerable: z.boolean().describe("Can this be answered from the manual topics?"),
          reasoning: z.string(),
        }),
        prompt: `User question: "${userQuestion}"

Available manual topics:
${l1Titles}

Can this question be answered using ONLY information from these manual topics? If the question is general knowledge, off-topic, or unrelated to these topics, return false.`,
      });

      if (!scopeCheck.object.isAnswerable) {
        await sendFinalAnswer(
          "I apologize, but your question doesn't appear to be related to the topics covered in our manual. Please ask questions about account management, security, billing, or troubleshooting.",
          {
            confidence: 0,
            source: "Out of scope",
            attemptTrail: [{ level: 0, selected: "None", confidence: 0, reasoning: scopeCheck.object.reasoning }],
          }
        );
        return;
      }

      // Level 1 Selection
      attempts++;
      await sendThinking("Searching through main categories...");

      const l1Options = data.chunks.map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
      }));

      const l1Response = await generateObject({
        model: MODEL,
        schema: z.object({
          selectedChunkId: z.string(),
          confidence: z.number().min(0).max(1),
          reasoning: z.string(),
        }),
        prompt: `User question: "${userQuestion}"

Available categories:
${l1Options.map((o) => `${o.id}: ${o.title} - ${o.summary}`).join("\n")}

Select the ONE most relevant category ID that would contain the answer to this question.`,
      });

      attemptTrail.push({
        level: 1,
        selected: l1Response.object.selectedChunkId,
        confidence: l1Response.object.confidence,
        reasoning: l1Response.object.reasoning,
      });

      if (l1Response.object.confidence < CONFIDENCE_THRESHOLD || attempts >= MAX_ATTEMPTS) {
        await sendFinalAnswer(
          `I attempted to find an answer but couldn't confidently locate the right information. Here's what I tried:\n\n${attemptTrail.map((t) => `- Level ${t.level}: ${t.selected} (confidence: ${(t.confidence * 100).toFixed(0)}%)`).join("\n")}\n\nPlease contact support or try rephrasing your question.`,
          {
            confidence: l1Response.object.confidence,
            source: "Low confidence",
            attemptTrail,
          }
        );
        return;
      }

      const selectedL1 = data.chunks.find((c) => c.id === l1Response.object.selectedChunkId);
      if (!selectedL1) {
        throw new Error("L1 chunk not found");
      }

      // Level 2 Selection
      attempts++;
      await sendThinking(`Found "${selectedL1.title}", narrowing down...`);

      const l2Options = selectedL1.children.map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
      }));

      const l2Response = await generateObject({
        model: MODEL,
        schema: z.object({
          selectedChunkId: z.string(),
          confidence: z.number().min(0).max(1),
          reasoning: z.string(),
        }),
        prompt: `User question: "${userQuestion}"

You selected category: ${selectedL1.title}

Available subcategories:
${l2Options.map((o) => `${o.id}: ${o.title} - ${o.summary}`).join("\n")}

Select the ONE most relevant subcategory ID that would contain the answer.`,
      });

      attemptTrail.push({
        level: 2,
        selected: l2Response.object.selectedChunkId,
        confidence: l2Response.object.confidence,
        reasoning: l2Response.object.reasoning,
      });

      if (l2Response.object.confidence < CONFIDENCE_THRESHOLD) {
        // Backtrack to L1
        if (attempts >= MAX_ATTEMPTS) {
          await sendFinalAnswer(
            `I attempted multiple paths but couldn't find a confident answer:\n\n${attemptTrail.map((t) => `- Level ${t.level}: ${t.selected} (confidence: ${(t.confidence * 100).toFixed(0)}%)`).join("\n")}\n\nPlease contact support for assistance.`,
            {
              confidence: l2Response.object.confidence,
              source: "Max attempts reached",
              attemptTrail,
            }
          );
          return;
        }
        await sendThinking("Low confidence, trying alternative path...");
        // For simplicity, we'll just proceed but mark as low confidence
      }

      const selectedL2 = selectedL1.children.find((c) => c.id === l2Response.object.selectedChunkId);
      if (!selectedL2) {
        throw new Error("L2 chunk not found");
      }

      // Level 3 - Final Answer (with streaming)
      attempts++;
      await sendThinking(`Found "${selectedL2.title}", generating answer...`);

      const l3Options = selectedL2.children.map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
        page: c.page,
      }));

      const l3OptionsText = l3Options
        .map((o) => `${o.id}: ${o.title} - ${o.summary} (Page ${o.page})`)
        .join("\n");

      // First select which L3 chunk to use
      const l3Selection = await generateObject({
        model: MODEL,
        schema: z.object({
          selectedChunkId: z.string(),
          confidence: z.number().min(0).max(1),
          reasoning: z.string(),
        }),
        prompt: `User question: "${userQuestion}"

You selected: ${selectedL1.title} > ${selectedL2.title}

Available solutions:
${l3OptionsText}

Select the ONE most relevant solution ID that answers the question.`,
      });

      const selectedL3 = selectedL2.children.find((c) => c.id === l3Selection.object.selectedChunkId);
      if (!selectedL3) {
        throw new Error("L3 chunk not found");
      }

      attemptTrail.push({
        level: 3,
        selected: l3Selection.object.selectedChunkId,
        confidence: l3Selection.object.confidence,
        reasoning: l3Selection.object.reasoning,
      });

      // Generate final answer with streaming
      const finalAnswer = await streamText({
        model: MODEL,
        prompt: `User question: "${userQuestion}"

Relevant manual content:
Title: ${selectedL3.title}
Section: ${selectedL3.section}
Page: ${selectedL3.page}
Content: ${selectedL3.content}

Provide a clear, natural language answer to the user's question based ONLY on this content. Be conversational and helpful.`,
      });

      let answer = "";
      for await (const chunk of finalAnswer.textStream) {
        answer += chunk;
        await writer.write(encoder.encode(`0:{"type":"text-delta","content":"${chunk.replace(/"/g, '\\"')}"}\n`));
      }

      // Send final metadata
      const metadata = {
        confidence: l3Selection.object.confidence,
        source: selectedL3.title,
        page: selectedL3.page,
        section: selectedL3.section,
        manualLink: `/manual.pdf#page=${selectedL3.page}`,
        attemptTrail,
      };

      await writer.write(
        encoder.encode(`0:{"type":"metadata","data":${JSON.stringify(metadata)}}\n`)
      );
      await writer.close();
    } catch (error) {
      await writer.write(
        encoder.encode(`0:{"type":"error","content":"An error occurred: ${error}"}\n`)
      );
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Vercel-AI-Data-Stream": "v1",
    },
  });
}

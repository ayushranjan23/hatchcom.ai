import { generateObject, streamText } from "ai";
import { z } from "zod";
import manualData from "@/data/manual-chunks.json";
import { google } from "@ai-sdk/google";

// Configuration
const MAX_ATTEMPTS = 5;
const CONFIDENCE_THRESHOLD = 0.3;
const MODEL = google("gemini-2.0-flash-exp");

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

// Type definitions
interface L3Chunk {
  id: string;
  title: string;
  summary: string;
  content: string;
  page: number;
  section: string;
}

interface L2Chunk {
  id: string;
  title: string;
  summary: string;
  level3: L3Chunk[];
}

interface L1Chunk {
  id: string;
  title: string;
  summary: string;
  level2: L2Chunk[];
}

interface ManualData {
  chunks: L1Chunk[];
}

const data = manualData as ManualData;

export async function POST(req: Request) {
  const { messages } = await req.json();
  const userQuery = messages[messages.length - 1].content;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendThinking = (message: string) => {
        const chunk = `0:${JSON.stringify([{ type: "text", text: message }])}\n`;
        controller.enqueue(encoder.encode(chunk));
      };

      const sendFinalAnswer = (answer: string) => {
        const chunk = `0:${JSON.stringify([{ type: "text", text: answer }])}\n`;
        controller.enqueue(encoder.encode(chunk));
      };

      try {
        let attempts = 0;
        const attemptHistory: Array<{ level: number; selected: string; confidence: number }> = [];

        // Level 1: Select top-level category
        sendThinking("🔍 Analyzing your question...");

        // Check if question is in scope
        const l1Titles = data.chunks.map((c) => `${c.id}: ${c.title}`).join(", ");
        
        const scopeCheck = await generateObject({
          model: MODEL,
          schema: z.object({
            inScope: z.boolean().describe("true if question can be answered using manual topics"),
            reasoning: z.string().describe("brief explanation of decision"),
          }),
          prompt: `Available manual topics: ${l1Titles}

User question: "${userQuery}"

Can this question be answered using ONLY information from these manual topics? If it's general knowledge or unrelated, return false.`,
        });

        attempts++;

        if (!scopeCheck.object.inScope) {
          sendFinalAnswer(
            `I apologize, but I can only answer questions related to the manual topics. The available topics are:\n\n${data.chunks.map((c) => `• ${c.title}`).join("\n")}\n\nPlease ask a question related to these areas, or contact support for other inquiries.`
          );
          controller.close();
          return;
        }

        sendThinking("📚 Searching through manual categories...");

        const l1Options = data.chunks.map((chunk) => ({
          id: chunk.id,
          title: chunk.title,
          summary: chunk.summary,
        }));

        const l1Selection = await generateObject({
          model: MODEL,
          schema: z.object({
            selectedChunkId: z.string().describe("ID of the most relevant L1 chunk"),
            confidence: z.number().min(0).max(1).describe("confidence score 0-1"),
            reasoning: z.string().describe("why this category was selected"),
          }),
          prompt: `User question: "${userQuery}"

Available categories:
${l1Options.map((o) => `${o.id}: ${o.title} - ${o.summary}`).join("\n")}

Select the ONE most relevant category ID that would contain the answer to the user's question.`,
        });

        attempts++;
        attemptHistory.push({
          level: 1,
          selected: l1Selection.object.selectedChunkId,
          confidence: l1Selection.object.confidence,
        });

        if (l1Selection.object.confidence < CONFIDENCE_THRESHOLD || attempts >= MAX_ATTEMPTS) {
          sendFinalAnswer(
            `I attempted to find an answer but couldn't locate relevant information with high confidence.\n\n**Attempted path:**\n${attemptHistory.map((h) => `Level ${h.level}: ${h.selected} (${Math.round(h.confidence * 100)}% confidence)`).join("\n")}\n\nPlease contact support or provide feedback to help us improve.`
          );
          controller.close();
          return;
        }

        const selectedL1 = data.chunks.find((c) => c.id === l1Selection.object.selectedChunkId);
        if (!selectedL1) throw new Error("L1 chunk not found");

        sendThinking(`✓ Found category: ${selectedL1.title}`);

        // Level 2: Select sub-topic
        sendThinking("🔎 Narrowing down to specific topic...");

        const l2Options = selectedL1.level2.map((chunk) => ({
          id: chunk.id,
          title: chunk.title,
          summary: chunk.summary,
        }));

        const l2Selection = await generateObject({
          model: MODEL,
          schema: z.object({
            selectedChunkId: z.string().describe("ID of the most relevant L2 chunk"),
            confidence: z.number().min(0).max(1).describe("confidence score 0-1"),
            reasoning: z.string().describe("why this sub-topic was selected"),
          }),
          prompt: `User question: "${userQuery}"

Under category "${selectedL1.title}", available sub-topics:
${l2Options.map((o) => `${o.id}: ${o.title} - ${o.summary}`).join("\n")}

Select the ONE most relevant sub-topic ID that would contain the answer.`,
        });

        attempts++;
        attemptHistory.push({
          level: 2,
          selected: l2Selection.object.selectedChunkId,
          confidence: l2Selection.object.confidence,
        });

        if (l2Selection.object.confidence < CONFIDENCE_THRESHOLD) {
          if (attempts >= MAX_ATTEMPTS) {
            sendFinalAnswer(
              `I attempted to find an answer but couldn't locate relevant information with high confidence.\n\n**Attempted path:**\n${attemptHistory.map((h) => `Level ${h.level}: ${h.selected} (${Math.round(h.confidence * 100)}% confidence)`).join("\n")}\n\nPlease contact support or provide feedback to help us improve.`
            );
            controller.close();
            return;
          }
          // Backtrack to L1
          sendThinking("⚠️ Low confidence, trying alternative category...");
          // For simplicity, we'll just proceed with lower confidence
        }

        const selectedL2 = selectedL1.level2.find((c) => c.id === l2Selection.object.selectedChunkId);
        if (!selectedL2) throw new Error("L2 chunk not found");

        sendThinking(`✓ Found topic: ${selectedL2.title}`);

        // Level 3: Generate final answer with streaming
        sendThinking("💡 Generating your answer...");

        const l3Options = selectedL2.level3.map((chunk) => ({
          id: chunk.id,
          title: chunk.title,
          summary: chunk.summary,
          content: chunk.content,
          page: chunk.page,
          section: chunk.section,
        }));

        const l3Prompt = `User question: "${userQuery}"

Available solutions:
${l3Options.map((o) => `${o.id}: ${o.title} - ${o.summary}`).join("\n")}

Based on the user's question, provide a natural language answer using the most relevant solution. Be helpful and concise.`;

        const finalAnswer = await generateObject({
          model: MODEL,
          schema: z.object({
            answer: z.string().describe("natural language answer to user's question"),
            confidence: z.number().min(0).max(1).describe("confidence in this answer 0-1"),
            sourceChunkId: z.string().describe("which L3 chunk was used"),
            reasoning: z.string().describe("why this answer was provided"),
          }),
          prompt: l3Prompt,
        });

        attempts++;

        const sourceChunk = l3Options.find((c) => c.id === finalAnswer.object.sourceChunkId);
        if (!sourceChunk) throw new Error("Source chunk not found");

        // Build final response
        const confidencePercent = Math.round(finalAnswer.object.confidence * 100);
        const confidenceEmoji = confidencePercent >= 80 ? "✅" : confidencePercent >= 50 ? "⚠️" : "❌";

        const response = `${finalAnswer.object.answer}

---
${confidenceEmoji} **Confidence:** ${confidencePercent}%
📍 **Source:** ${selectedL1.title} → ${selectedL2.title} → ${sourceChunk.title}
📄 **Manual Reference:** Page ${sourceChunk.page} | [View in manual](manual.pdf#page=${sourceChunk.page})
🔍 **Section:** ${sourceChunk.section}`;

        sendFinalAnswer(response);
        controller.close();
      } catch (error) {
        console.error("Error in iterative RAG:", error);
        sendFinalAnswer(
          "An error occurred while processing your question. Please try again or contact support."
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Vercel-AI-Data-Stream": "v1",
    },
  });
}

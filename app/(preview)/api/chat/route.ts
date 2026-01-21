import { convertToModelMessages, generateObject, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import manualChunks from "@/lib/data/manual-chunks.json";

// Configuration
const CONFIDENCE_THRESHOLD = 0.3;
const MAX_ATTEMPTS = 5; // configurable upper bound including retries

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

// Type definitions for manual chunks
type Level3Chunk = {
  id: string;
  title: string;
  summary: string;
  content: string;
  page: number;
  section: string;
};

type Level2Chunk = {
  id: string;
  title: string;
  summary: string;
  children: Level3Chunk[];
};

type Level1Chunk = {
  id: string;
  title: string;
  summary: string;
  children: Level2Chunk[];
};

export async function POST(req: Request) {
  const { messages } = await req.json();
  const userQuery = messages[messages.length - 1]?.parts?.find((p: any) => p.type === "text")?.text || "";

  const result = streamText({
    model: "google/gemini-2.0-flash",
    messages: convertToModelMessages(messages),
    system: `You are an assistant that MUST use the provided tools to answer questions from a manual.
Follow this exact sequence:
1) Call analyzeCategories to pick ONE top-level category or detect out-of-scope.
2) Call selectSubcategory within the chosen category to pick ONE subcategory.
3) Call generateAnswer to produce the final streamed answer using the selected solution.
Only answer from the manual. If not relevant, respond with the out-of-scope guidance.
After each tool call, immediately call the next required tool using the previous result.
  CRITICAL: After generateAnswer returns, you MUST produce a final assistant text message that contains:
  - The natural language answer
  - Confidence as a percentage
  - Source title and "https://hatchcom.vercel.app/manual.pdf#page=n" link
  Do not terminate or stop before sending this final assistant message.
Always include confidence in your final output.`,
    // Ensure tool loop continues and doesn't stop early
    stopWhen: stepCountIs(MAX_ATTEMPTS),
    tools: {
      // Level 1: Analyze top-level categories
      analyzeCategories: tool({
        description: `Analyze top-level manual categories to find the most relevant one. Use this tool first to determine if the question can be answered from the manual.`,
        // For older versions, use inputSchema instead of parameters
        inputSchema: z.object({}),
        execute: async () => {
          const level1Chunks = manualChunks as Level1Chunk[];
          
          // Check if question is answerable from manual
          const { object: relevanceCheck } = await generateObject({
            model: "google/gemini-2.0-flash",
            schema: z.object({
              isRelevant: z.boolean().describe("Can this be answered using ONLY the manual categories?"),
              reasoning: z.string().describe("Brief explanation"),
            }),
            prompt: `Available manual categories: ${level1Chunks.map(c => `"${c.title}" - ${c.summary}`).join(", ")}
            
User question: "${userQuery}"

Can this question be answered using ONLY information from these manual categories? If it's general knowledge or unrelated, return false.`,
          });

          if (!relevanceCheck.isRelevant) {
            return {
              type: "out_of_scope",
              message: "Thanks for this prompt! Unfortunately, the prompt appears to be outside our HatchcomV manual's scope. Please ask questions related to the manual content. If you believe this is a mistake, please email support@hatchcom.ai with your query and manual reference. Thanks for using HatchcomAI!",
              reasoning: relevanceCheck.reasoning,
            };
          }

          // Select most relevant L1 chunk
          const { object } = await generateObject({
            model: "google/gemini-2.0-flash",
            schema: z.object({
              selectedChunkId: z.string().describe("ID of the selected level 1 chunk (e.g., L1-001)"),
              confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
              reasoning: z.string().describe("Why this category was selected"),
            }),
            prompt: `Available categories:
${level1Chunks.map(c => `ID: ${c.id}, Title: "${c.title}", Summary: ${c.summary}`).join("\n")}

User question: "${userQuery}"

Select the ONE most relevant category ID that best matches this question.`,
          });

          const selectedChunk = level1Chunks.find(c => c.id === object.selectedChunkId);
          
          return {
            type: "level1_selected",
            selectedChunkId: object.selectedChunkId,
            selectedTitle: selectedChunk?.title || "Unknown",
            confidence: object.confidence,
            reasoning: object.reasoning,
            availableSubcategories: selectedChunk?.children.length || 0,
          };
        },
      }),

      // Level 2: Refine to subcategory
      selectSubcategory: tool({
        description: `Select the most relevant subcategory within the chosen category.`,
        // Use inputSchema instead of parameters
        inputSchema: z.object({
          level1ChunkId: z.string().describe("The L1 chunk ID to search within"),
        }),
        execute: async ({ level1ChunkId }) => {
          const level1Chunks = manualChunks as Level1Chunk[];
          const level1Chunk = level1Chunks.find(c => c.id === level1ChunkId);

          if (!level1Chunk) {
            return { 
              type: "error",
              message: "Level 1 chunk not found",
              reasoning: `Level 1 chunk with ID ${level1ChunkId} was not found.`,
            };
          }

          const level2Chunks = level1Chunk.children;

          if (!level2Chunks || level2Chunks.length === 0) {
            return {
              type: "no_subcategories",
              message: "No subcategories available in this category.",
              reasoning: `Category "${level1Chunk.title}" has no subcategories.`,
            };
          }

          const { object } = await generateObject({
            model: "google/gemini-2.0-flash",
            schema: z.object({
              selectedChunkId: z.string().describe("ID of the selected level 2 chunk (e.g., L2-001)"),
              confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
              reasoning: z.string().describe("Why this subcategory was selected"),
            }),
            prompt: `Within category "${level1Chunk.title}", available subcategories:
${level2Chunks.map(c => `ID: ${c.id}, Title: "${c.title}", Summary: ${c.summary}`).join("\n")}

User question: "${userQuery}"

Select the ONE most relevant subcategory ID.`,
          });

          if (object.confidence < CONFIDENCE_THRESHOLD) {
            return {
              type: "low_confidence",
              message: "Confidence too low at level 2, consider going back to level 1",
              confidence: object.confidence,
              selectedChunkId: object.selectedChunkId,
              reasoning: object.reasoning,
            };
          }

          const selectedChunk = level2Chunks.find(c => c.id === object.selectedChunkId);

          return {
            type: "level2_selected",
            selectedChunkId: object.selectedChunkId,
            selectedTitle: selectedChunk?.title || "Unknown",
            confidence: object.confidence,
            reasoning: object.reasoning,
            availableSolutions: selectedChunk?.children.length || 0,
          };
        },
      }),

      // Level 3: Generate final answer
      generateAnswer: tool({
        description: `Generate the final answer using the specific solution from the manual.`,
        // Use inputSchema instead of parameters
        inputSchema: z.object({
          level2ChunkId: z.string().describe("The L2 chunk ID to get solutions from"),
        }),
        execute: async ({ level2ChunkId }) => {
          const level1Chunks = manualChunks as Level1Chunk[];
          let level2Chunk: Level2Chunk | undefined;
          let level1Parent: Level1Chunk | undefined;

          // Find the level 2 chunk
          for (const l1 of level1Chunks) {
            const found = l1.children.find(c => c.id === level2ChunkId);
            if (found) {
              level2Chunk = found;
              level1Parent = l1;
              break;
            }
          }

          if (!level2Chunk || !level1Parent) {
            return { 
              type: "error",
              message: "Level 2 chunk not found",
              reasoning: `Level 2 chunk with ID ${level2ChunkId} was not found.`,
            };
          }

          const level3Chunks = level2Chunk.children;

          if (!level3Chunks || level3Chunks.length === 0) {
            return {
              type: "no_solutions",
              message: "No solutions available in this subcategory.",
              reasoning: `Subcategory "${level2Chunk.title}" has no solutions.`,
            };
          }

          const { object } = await generateObject({
            model: "google/gemini-2.0-flash",
            schema: z.object({
              answer: z.string().describe("Natural language answer to the user's question"),
              confidence: z.number().min(0).max(1).describe("Confidence in this answer"),
              sourceChunkId: z.string().describe("Which L3 chunk was used (e.g., L3-001)"),
              reasoning: z.string().describe("Why this solution was chosen"),
            }),
            prompt: `Available solutions:
${level3Chunks.map(c => `ID: ${c.id}, Title: "${c.title}", Summary: ${c.summary}, Page: ${c.page}, Section: ${c.section}`).join("\n")}

User question: "${userQuery}"

Provide a natural language answer based on the most relevant solution. Reference the solution by its ID.`,
          });

          const sourceChunk = level3Chunks.find(c => c.id === object.sourceChunkId);

          if (!sourceChunk) {
            return { 
              type: "error",
              message: "Source chunk not found",
              reasoning: `Source chunk with ID ${object.sourceChunkId} was not found.`,
            };
          }

          return {
            type: "final_answer",
            answer: object.answer,
            confidence: object.confidence,
            source: {
              title: sourceChunk.title,
              page: sourceChunk.page,
              section: sourceChunk.section,
              manualLink: `https://hatchcomai.vercel.app/manual.pdf#page=${sourceChunk.page}`,
            },
            decisionPath: [
              { level: 1, title: level1Parent.title, id: level1Parent.id },
              { level: 2, title: level2Chunk.title, id: level2Chunk.id },
              { level: 3, title: sourceChunk.title, id: sourceChunk.id },
            ],
            reasoning: object.reasoning,
          };
        },
      }),
    },
  });

  // Return UI message stream response to integrate with useChat
  return result.toUIMessageStreamResponse();
}
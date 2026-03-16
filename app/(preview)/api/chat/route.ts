import { convertToModelMessages, generateObject, stepCountIs, streamText, tool } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import manualChunks from "@/lib/data/manual-chunks.json";

// Configuration
const CONFIDENCE_THRESHOLD = 0.1; // Lowered to allow more guesses with vague matches
const MAX_ATTEMPTS = 12; // give tool chain enough headroom before stopping

// Allow streaming responses up to 60 seconds
export const maxDuration = 60;

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
  const model = google("gemini-2.5-flash");

  const result = streamText({
    model,
    messages: convertToModelMessages(messages),
    system: `CRITICAL: You are an assistant that MUST use the provided tools to answer questions from a manual.
FOLLOW THIS EXACT SEQUENCE EVERY TIME:
1) ALWAYS call analyzeCategories first. You MUST ALWAYS select a top-level category from the manual. Even if the match seems vague or imperfect, you MUST PICK ONE based on the best available match. Use both title AND summary to make educated guesses.
2) ALWAYS call selectSubcategory within the chosen category. You MUST ALWAYS select a subcategory. Even if unsure, pick the most plausible one based on available information.
3) ALWAYS call generateAnswer to produce the final streamed answer using the selected solution.

IMPERATIVE RULES:
- YOU MUST ALWAYS PICK CATEGORIES AT L1 AND L2 LEVELS. DO NOT STOP OR SKIP TOOLS.
- When categories seem vague (e.g., "Introduction" with summary mentioning "hardware"), you MUST MAKE AN EDUCATED GUESS based on available information.
- You MUST use both title AND summary content for matching, not just exact keyword matches.
- After generateAnswer returns, you MUST produce a final assistant text message that contains:
  - The COMPLETE natural language answer that fully answers the user's question using the actual content from the Level 3 chunk.
  - Confidence as a percentage
  - Source title and "https://hatchcomai.vercel.app/manual.pdf#page=n" link

CRITICAL: YOUR FINAL ANSWER MUST:
1. ACTUALLY ANSWER THE QUESTION USING THE LEVEL 3 CONTENT. DO NOT TELL USER TO CHECK THE MANUAL.
2. PROVIDE A COMPLETE, USEFUL ANSWER AS IF YOU WERE DIRECTLY ANSWERING.
3. INCLUDE THE REFERENCE AT THE END FOR VERIFICATION.
4. DO NOT SAY "LX-XXX HAS THE ANSWER" - YOU ARE THE ONE ANSWERING!

EXAMPLE OF WHAT TO DO:
User: "What is the cable connector part number?"
Your answer: "The cable connector part number is XYZ-1234, which is a 24-pin connector used for... [rest of actual answer from content]"

Confidence: XX%
Source: Connector Specifications
Reference: https://hatchcomai.vercel.app/manual.pdf#page=42

IF THE USER IS JUST GREETING OR MAKING GENERAL CHAT, respond normally as a Hatchcom assistant without using tools.
DO NOT MENTION TOOLS, AI MODEL NAMES, OR INTERNAL PROCESSES IN FINAL ANSWER.`,
    // Ensure tool loop continues and doesn't stop early
    stopWhen: stepCountIs(MAX_ATTEMPTS),
    tools: {
      // Level 1: Analyze top-level categories
      analyzeCategories: tool({
        description: `Analyze top-level manual categories to find the most relevant one. Use this tool first.`,
        inputSchema: z.object({}),
        execute: async () => {
          const level1Chunks = manualChunks as Level1Chunk[];

          // ALWAYS proceed to selection, even if relevance is low
          // Select most relevant L1 chunk
          const { object } = await generateObject({
            model,
            schema: z.object({
              selectedChunkId: z.string().describe("ID of the selected level 1 chunk (e.g., L1-001)"),
              confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
              reasoning: z.string().describe("Why this category was selected based on title AND summary content"),
            }),
            prompt: `IMPERATIVE: YOU MUST SELECT A CATEGORY. Even with low confidence, pick the best available match.

Available categories:
${level1Chunks.map(c => `ID: ${c.id}, Title: "${c.title}", Summary: "${c.summary}"`).join("\n")}

User question: "${userQuery}"

SELECTION CRITERIA:
1. Look at BOTH title AND summary content
2. Consider conceptual relationships (e.g., "connector" might be in "Hardware" or "Introduction" if those summaries mention components)
3. Vague matches are acceptable - just pick the most plausible one
4. DO NOT skip - you MUST return a selectedChunkId

Select the ONE most relevant category ID.`,
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
            model,
            schema: z.object({
              selectedChunkId: z.string().describe("ID of the selected level 2 chunk (e.g., L2-001)"),
              confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
              reasoning: z.string().describe("Why this subcategory was selected based on title AND summary"),
            }),
            prompt: `IMPERATIVE: YOU MUST SELECT A SUBCATEGORY. Even with low confidence, pick the best available match.

Within category "${level1Chunk.title}", available subcategories:
${level2Chunks.map(c => `ID: ${c.id}, Title: "${c.title}", Summary: "${c.summary}"`).join("\n")}

User question: "${userQuery}"

SELECTION CRITERIA:
1. Look at BOTH title AND summary content
2. Consider the user's question in context of the parent category
3. Vague matches are acceptable - pick the most plausible path forward
4. DO NOT return low confidence as an error - just select something
5. YOU MUST return a selectedChunkId

Select the ONE most relevant subcategory ID.`,
          });

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
            model,
            schema: z.object({
              answer: z.string().describe("Complete natural language answer that directly answers the user's question using the content"),
              confidence: z.number().min(0).max(1).describe("Confidence in this answer"),
              sourceChunkId: z.string().describe("Which L3 chunk was used (e.g., L3-001)"),
              reasoning: z.string().describe("Why this solution was chosen"),
            }),
            prompt: `CRITICAL: You MUST create a COMPLETE answer that actually answers the user's question.

Available solutions in "${level2Chunk.title}":
${level3Chunks.map(c => `ID: ${c.id}, Title: "${c.title}", Summary: ${c.summary}, Content: ${c.content.substring(0, 200)}..., Page: ${c.page}, Section: ${c.section}`).join("\n\n")}

User question: "${userQuery}"

INSTRUCTIONS:
1. Read the ACTUAL CONTENT of each solution (not just title/summary)
2. Find the most relevant content that answers the user's question
3. Create a COMPLETE natural language answer using that content
4. Your answer should stand alone - the user should NOT need to check the manual
5. Reference the solution ID in your reasoning, but NOT in the final answer text
6. If multiple solutions are relevant, synthesize information from them

Provide a thorough answer based on the manual content.`,
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
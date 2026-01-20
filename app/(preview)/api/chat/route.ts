import {
  convertToModelMessages,
  generateObject,
  streamText,
  tool,
  UIMessage,
} from "ai";
import { z } from "zod";
import manualChunks from "@/lib/data/manual-chunks.json";

// Configuration
const MAX_ATTEMPTS = 5;
const CONFIDENCE_THRESHOLD = 0.3;

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

// Types for our nested JSON structure
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
  level3: Level3Chunk[];
};

type Level1Chunk = {
  id: string;
  title: string;
  summary: string;
  level2: Level2Chunk[];
};

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  
  const result = streamText({
    model: "google/gemini-2.0-flash",
    messages: convertToModelMessages(messages),
    system: `You are a helpful manual assistant that guides users through an iterative search process.
Follow the tool calls exactly and provide accurate responses based on the manual content.`,
    maxSteps: MAX_ATTEMPTS,
    tools: {
      // Level 1: Select main category
      selectLevel1: tool({
        description: `First step: Analyze available top-level categories and select the most relevant one.
Only use this tool if the question can be answered from the manual. If the question is completely unrelated to any category, indicate that.`,
        inputSchema: z.object({
          query: z.string().describe("the user's original question"),
        }),
        execute: async ({ query }) => {
          const level1Options = (manualChunks as Level1Chunk[]).map((chunk) => ({
            id: chunk.id,
            title: chunk.title,
            summary: chunk.summary,
          }));

          const { object } = await generateObject({
            model: "google/gemini-2.0-flash",
            system: `You are analyzing which top-level category best matches a user query.
If the question is completely unrelated to all categories (e.g., general knowledge, math, current events), set isRelevant to false.
Otherwise, select the ONE most relevant category.`,
            schema: z.object({
              selectedChunkId: z.string().describe("ID of selected level 1 chunk (e.g., 'L1-001')"),
              confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
              reasoning: z.string().describe("Why this category was selected"),
              isRelevant: z.boolean().describe("Whether question is answerable from manual"),
            }),
            prompt: `Available categories:
${level1Options.map((opt) => `- ${opt.id}: ${opt.title} - ${opt.summary}`).join("\n")}

User question: "${query}"

Select the most relevant category.`,
          });

          if (!object.isRelevant || object.confidence < CONFIDENCE_THRESHOLD) {
            return {
              success: false,
              message: "Question appears unrelated to manual content",
              ...object,
            };
          }

          const selectedChunk = (manualChunks as Level1Chunk[]).find(
            (c) => c.id === object.selectedChunkId
          );

          return {
            success: true,
            selected: selectedChunk,
            ...object,
          };
        },
      }),

      // Level 2: Select subcategory
      selectLevel2: tool({
        description: `Second step: From the selected category, choose the most relevant subcategory.`,
        inputSchema: z.object({
          query: z.string().describe("the user's original question"),
          level1Id: z.string().describe("ID of previously selected level 1 chunk"),
        }),
        execute: async ({ query, level1Id }) => {
          const level1Chunk = (manualChunks as Level1Chunk[]).find(
            (c) => c.id === level1Id
          );

          if (!level1Chunk) {
            return { success: false, message: "Level 1 chunk not found" };
          }

          const level2Options = level1Chunk.level2.map((chunk) => ({
            id: chunk.id,
            title: chunk.title,
            summary: chunk.summary,
          }));

          const { object } = await generateObject({
            model: "google/gemini-2.0-flash",
            system: `You are narrowing down to a subcategory within "${level1Chunk.title}".
Select the ONE most relevant subcategory.`,
            schema: z.object({
              selectedChunkId: z.string().describe("ID of selected level 2 chunk (e.g., 'L2-001')"),
              confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
              reasoning: z.string().describe("Why this subcategory was selected"),
            }),
            prompt: `You selected category: ${level1Chunk.title}

Available subcategories:
${level2Options.map((opt) => `- ${opt.id}: ${opt.title} - ${opt.summary}`).join("\n")}

User question: "${query}"

Select the most relevant subcategory.`,
          });

          if (object.confidence < CONFIDENCE_THRESHOLD) {
            return {
              success: false,
              message: "Low confidence, may need to go back to level 1",
              ...object,
            };
          }

          const selectedChunk = level1Chunk.level2.find(
            (c) => c.id === object.selectedChunkId
          );

          return {
            success: true,
            selected: selectedChunk,
            ...object,
          };
        },
      }),

      // Level 3: Generate final answer
      answerFromLevel3: tool({
        description: `Final step: Generate a natural language answer based on the most specific content.`,
        inputSchema: z.object({
          query: z.string().describe("the user's original question"),
          level2Id: z.string().describe("ID of previously selected level 2 chunk"),
          level1Id: z.string().describe("ID of previously selected level 1 chunk"),
        }),
        execute: async ({ query, level2Id, level1Id }) => {
          const level1Chunk = (manualChunks as Level1Chunk[]).find(
            (c) => c.id === level1Id
          );
          const level2Chunk = level1Chunk?.level2.find((c) => c.id === level2Id);

          if (!level2Chunk) {
            return { success: false, message: "Level 2 chunk not found" };
          }

          const level3Options = level2Chunk.level3.map((chunk) => ({
            id: chunk.id,
            title: chunk.title,
            summary: chunk.summary,
            page: chunk.page,
            section: chunk.section,
          }));

          // For final answer, use generateObject to get structured data
          const { object } = await generateObject({
            model: "google/gemini-2.0-flash",
            system: `You are providing a final answer from the manual.
Select the most relevant specific solution and provide a helpful natural language answer.`,
            schema: z.object({
              answer: z.string().describe("Natural language answer to the user's question"),
              sourceChunkId: z.string().describe("ID of the level 3 chunk used (e.g., 'L3-001')"),
              confidence: z.number().min(0).max(1).describe("Confidence in this answer 0-1"),
              reasoning: z.string().describe("Why this specific solution was chosen"),
            }),
            prompt: `Available solutions in "${level2Chunk.title}":
${level3Options.map((opt) => `- ${opt.id}: ${opt.title} - ${opt.summary} (Page ${opt.page})`).join("\n")}

User question: "${query}"

Provide a natural language answer based on the most relevant solution.`,
          });

          const sourceChunk = level2Chunk.level3.find(
            (c) => c.id === object.sourceChunkId
          );

          if (!sourceChunk) {
            return {
              success: false,
              message: "Source chunk not found",
            };
          }

          return {
            success: true,
            answer: object.answer,
            confidence: object.confidence,
            source: sourceChunk.title,
            page: sourceChunk.page,
            section: sourceChunk.section,
            manualLink: `/manual.pdf#page=${sourceChunk.page}`,
            decisionPath: {
              level1: level1Chunk?.title,
              level2: level2Chunk.title,
              level3: sourceChunk.title,
            },
            reasoning: object.reasoning,
          };
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}

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

// Type definitions
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
  children: Level3Chunk[];
};

type Level1Chunk = {
  id: string;
  title: string;
  summary: string;
  children: Level2Chunk[];
};

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: "google/gemini-2.0-flash",
    messages: convertToModelMessages(messages),
    system: `You are a helpful assistant that answers questions using information from a manual.
You have access to tools that help you navigate through the manual hierarchically.
IMPORTANT: Only answer questions that can be found in the manual chunks provided to you.
If a question is completely unrelated to the manual topics, use the appropriate tool to indicate this.`,
    maxSteps: MAX_ATTEMPTS,
    tools: {
      // Level 1: Check if question is in scope and select top-level category
      selectLevel1Category: tool({
        description: `Analyze the user's question and select the most relevant top-level category from the manual.
Use this tool first to determine if the question can be answered using the manual.`,
        inputSchema: z.object({
          userQuestion: z.string().describe("The user's original question"),
          availableCategories: z
            .array(
              z.object({
                id: z.string(),
                title: z.string(),
                summary: z.string(),
              })
            )
            .describe("Top-level categories available"),
          isInScope: z
            .boolean()
            .describe(
              "Whether the question can be answered using the available categories"
            ),
          selectedChunkId: z
            .string()
            .optional()
            .describe(
              "The ID of the selected category (only if isInScope is true)"
            ),
          confidence: z
            .number()
            .min(0)
            .max(1)
            .describe("Confidence level in the selection (0-1)"),
          reasoning: z
            .string()
            .describe("Brief explanation of why this category was chosen"),
        }),
        execute: async ({
          isInScope,
          selectedChunkId,
          confidence,
          reasoning,
        }) => {
          if (!isInScope) {
            return {
              status: "out_of_scope",
              message:
                "This question appears to be outside the scope of the manual.",
            };
          }

          if (confidence < CONFIDENCE_THRESHOLD) {
            return {
              status: "low_confidence",
              confidence,
              reasoning,
            };
          }

          const selectedChunk = (manualChunks as Level1Chunk[]).find(
            (chunk) => chunk.id === selectedChunkId
          );

          if (!selectedChunk) {
            return {
              status: "error",
              message: "Selected category not found",
            };
          }

          return {
            status: "success",
            selectedCategory: selectedChunk.title,
            confidence,
            reasoning,
            nextLevel: selectedChunk.children.map((child) => ({
              id: child.id,
              title: child.title,
              summary: child.summary,
            })),
          };
        },
      }),

      // Level 2: Select subcategory
      selectLevel2Subcategory: tool({
        description: `Select the most relevant subcategory from the previously selected top-level category.`,
        inputSchema: z.object({
          userQuestion: z.string().describe("The user's original question"),
          parentCategory: z.string().describe("The parent category selected"),
          availableSubcategories: z
            .array(
              z.object({
                id: z.string(),
                title: z.string(),
                summary: z.string(),
              })
            )
            .describe("Available subcategories"),
          selectedChunkId: z
            .string()
            .describe("The ID of the selected subcategory"),
          confidence: z
            .number()
            .min(0)
            .max(1)
            .describe("Confidence level in the selection (0-1)"),
          reasoning: z
            .string()
            .describe("Brief explanation of why this subcategory was chosen"),
        }),
        execute: async ({ selectedChunkId, confidence, reasoning }) => {
          if (confidence < CONFIDENCE_THRESHOLD) {
            return {
              status: "low_confidence",
              confidence,
              reasoning,
              suggestion: "backtrack_to_level1",
            };
          }

          // Find the selected L2 chunk across all L1 chunks
          let selectedChunk: Level2Chunk | undefined;
          for (const l1 of manualChunks as Level1Chunk[]) {
            selectedChunk = l1.children.find(
              (child) => child.id === selectedChunkId
            );
            if (selectedChunk) break;
          }

          if (!selectedChunk) {
            return {
              status: "error",
              message: "Selected subcategory not found",
            };
          }

          return {
            status: "success",
            selectedSubcategory: selectedChunk.title,
            confidence,
            reasoning,
            nextLevel: selectedChunk.children.map((child) => ({
              id: child.id,
              title: child.title,
              summary: child.summary,
              page: child.page,
            })),
          };
        },
      }),

      // Level 3: Generate final answer
      generateFinalAnswer: tool({
        description: `Generate a natural language answer to the user's question using the detailed content from the selected solution.
This is the final step - provide a comprehensive answer.`,
        inputSchema: z.object({
          userQuestion: z.string().describe("The user's original question"),
          availableSolutions: z
            .array(
              z.object({
                id: z.string(),
                title: z.string(),
                summary: z.string(),
                page: z.number(),
              })
            )
            .describe("Available detailed solutions"),
          selectedChunkId: z
            .string()
            .describe("The ID of the solution chunk to use for the answer"),
          confidence: z
            .number()
            .min(0)
            .max(1)
            .describe("Confidence level in this being the correct solution"),
          reasoning: z
            .string()
            .describe("Brief explanation of why this solution was chosen"),
        }),
        execute: async ({ selectedChunkId, confidence }) => {
          if (confidence < CONFIDENCE_THRESHOLD) {
            return {
              status: "low_confidence",
              confidence,
              suggestion: "backtrack_to_level2",
            };
          }

          // Find the selected L3 chunk
          let selectedChunk: Level3Chunk | undefined;
          for (const l1 of manualChunks as Level1Chunk[]) {
            for (const l2 of l1.children) {
              selectedChunk = l2.children.find(
                (child) => child.id === selectedChunkId
              );
              if (selectedChunk) break;
            }
            if (selectedChunk) break;
          }

          if (!selectedChunk) {
            return {
              status: "error",
              message: "Selected solution not found",
            };
          }

          return {
            status: "ready_to_answer",
            content: selectedChunk.content,
            page: selectedChunk.page,
            section: selectedChunk.section,
            title: selectedChunk.title,
            confidence,
            manualLink: `/manual.pdf#page=${selectedChunk.page}`,
          };
        },
      }),

      // Fallback tool when out of scope
      handleOutOfScope: tool({
        description: `Use this when the user's question is completely unrelated to the manual topics.`,
        inputSchema: z.object({
          userQuestion: z.string().describe("The user's question"),
          reason: z
            .string()
            .describe("Why this question is out of scope"),
        }),
        execute: async ({ reason }) => {
          return {
            status: "out_of_scope",
            message:
              "I can only answer questions related to the user manual. Please ask questions about account management, security & privacy, notifications, billing & payments, or troubleshooting.",
            reason,
          };
        },
      }),
    },
    onStepStart: ({ toolCall }) => {
      console.log(`Tool started: ${toolCall.toolName}`);
    },
  });

  return result.toUIMessageStreamResponse();
}

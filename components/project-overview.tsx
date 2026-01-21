import React from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { InformationIcon, VercelIcon } from "./icons";

const ProjectOverview = () => {
  return (
    <motion.div
      className="w-full max-w-[600px] my-4"
      initial={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 5 }}
    >
      <div className="border rounded-lg p-6 flex flex-col gap-4 text-neutral-500 text-sm dark:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900">
        <h3 className="flex flex-row justify-center gap-4 items-center text-neutral-900 dark:text-neutral-50">
          HatchcomAI
        </h3>
        <p>
          This bot uses the {" "}
          <Link
            href="https://hatchcomai.vercel.app/manual.pdf"
            className="text-blue-500"
          >
            Hatchcom5 manual
          </Link>{" "}
          along with{" "}
          <Link
            href="#"
            className="text-blue-500"
          >
            iterations
          </Link>{" "}
          for implementing a Retrieval-Augmented Generation (RAG) chatbot in a serverless method.
          To prompt the AI effectively, consider asking specific questions related to the manual content and avoid vague or overly broad queries. Ensure your questions are descriptive, concise and precise for the best results.
        </p>
        <p>
          Visit Jamesway's website{" "}
          <Link
            className="text-blue-500"
            href="https://jamesway.com"
            target="_blank"
          >
            here
          </Link>
          to learn more.
        </p>
      </div>
    </motion.div>
  );
};

export default ProjectOverview;

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
          for implementing a serverless AI chatbot.
          Please only only ask specific questions related to the manual content and avoid vague or overly broad queries. Example: What type of reports are available in Hatchcom5? rather than Tell me about Hatchcom5.
        </p>
      </div>
    </motion.div>
  );
};

export default ProjectOverview;

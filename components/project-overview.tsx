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
          Khao Hakka Assistant
        </h3>
        <p>
          Ask me anything about{" "}
          <Link
            href="https://khaohakka.com"
            className="text-blue-500"
          >
            Khao Hakka
          </Link>
          {" "}in downtown Toronto. I can help with hours, address, menu categories, popular dishes, lunch deals, halal notes, and ordering details.
          For best results, ask specific questions. Example: <em>What are the lunch hours?</em> rather than <em>Tell me about the restaurant.</em>
        </p>
      </div>
    </motion.div>
  );
};

export default ProjectOverview;

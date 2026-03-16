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
          Tueely AI Assistant
        </h3>
        <p>
          Ask me anything about{" "}
          <Link
            href="https://tueely.com"
            className="text-blue-500"
          >
            Tueely
          </Link>
          {" "}, MenuQR, or MenuGPT. I can help with setup, features, pricing, allergen tagging, QR code deployment, analytics, and more.
          For best results, ask specific questions. Example: <em>How do I update my menu after going live?</em> rather than <em>Tell me about Tueely.</em>
        </p>
      </div>
    </motion.div>
  );
};

export default ProjectOverview;

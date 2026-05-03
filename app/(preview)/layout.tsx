import type { Metadata } from "next";
import { Toaster } from "sonner";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://khaohakka.com"),
  title: "Khao Hakka Assistant",
  description:
    "Ask anything about Khao Hakka in downtown Toronto, including hours, location, menu categories, popular dishes, and ordering details.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Toaster } from "sonner";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://tueely.com"),
  title: "Tueely AI — MenuQR & MenuGPT Assistant",
  description:
    "Ask anything about Tueely, MenuQR, or MenuGPT. Get instant answers about setup, features, pricing, allergens, and more.",
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

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Curriculus",
  description: "Ajuste seu currículo para uma vaga específica.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}

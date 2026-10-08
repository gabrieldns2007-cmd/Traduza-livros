import type { Metadata, Viewport } from "next";
import { Newsreader, Instrument_Sans } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { PUBLIC_MODE } from "@/lib/mode";
import { PublicShell } from "@/components/public/public-shell";
import "./globals.css";

const newsreader = Newsreader({
  subsets: ["latin", "latin-ext"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-newsreader",
  display: "swap",
});

const instrument = Instrument_Sans({
  subsets: ["latin", "latin-ext"],
  variable: "--font-instrument",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Verso — traduza seu livro", template: "%s · Verso" },
  description: "Traduza livros inteiros, capítulo por capítulo, preservando a estrutura. Exporte em EPUB e PDF.",
  applicationName: "Verso",
  appleWebApp: { capable: true, title: "Verso", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf9f4" },
    { media: "(prefers-color-scheme: dark)", color: "#131210" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${newsreader.variable} ${instrument.variable}`}>
      <body className="min-h-dvh">
        {PUBLIC_MODE ? (
          <PublicShell>
            <SiteHeader />
            {children}
          </PublicShell>
        ) : (
          <>
            <SiteHeader />
            {children}
            <SiteFooter />
          </>
        )}
      </body>
    </html>
  );
}

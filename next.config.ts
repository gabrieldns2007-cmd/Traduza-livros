import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // servidor Node autônomo (ideal para Docker/VPS): `node .next/standalone/server.js`
  output: "standalone",
  // Bibliotecas Node pesadas ficam fora do bundle do servidor.
  serverExternalPackages: ["pdfkit", "unpdf", "jszip", "cheerio"],
  // Os arquivos de fonte usados pelo gerador de PDF precisam ir junto no build standalone.
  outputFileTracingIncludes: {
    "/api/books/[id]/export/[format]": ["./assets/fonts/**/*"],
  },
  // nunca empacotar os livros do usuário no build
  outputFileTracingExcludes: {
    "*": ["./data/**/*", "./tests/**/*"],
  },
  experimental: {
    // O proxy (proteção por senha) bufferiza o corpo da requisição; uploads de livros podem ser grandes.
    proxyClientMaxBodySize: "200mb",
  },
  poweredByHeader: false,
};

export default nextConfig;

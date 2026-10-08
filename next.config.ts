import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // servidor Node autônomo (ideal para Docker/VPS): `node .next/standalone/server.js`
  output: "standalone",
  // Bibliotecas Node pesadas ficam fora do bundle do servidor.
  serverExternalPackages: ["pdfkit", "unpdf", "jszip", "cheerio"],
  // Os arquivos de fonte usados pelo gerador de PDF precisam ir junto no build standalone.
  outputFileTracingIncludes: {
    "/api/books/[id]/export/[format]": ["./public/pdf-fonts/**/*"],
  },
  // nunca empacotar os livros do usuário no build
  outputFileTracingExcludes: {
    "*": ["./data/**/*", "./tests/**/*"],
  },
  experimental: {
    // O proxy (proteção por senha) bufferiza o corpo da requisição; uploads de livros podem ser grandes.
    proxyClientMaxBodySize: "200mb",
  },
  // A checagem de tipos roda em `npm run typecheck` e nos testes; pulá-la no build
  // economiza memória (máquinas pequenas, como o Codespace básico, podiam encerrar o build).
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  turbopack: {
    // Versão pública: o mesmo motor roda no navegador, com os módulos do Node
    // trocados por equivalentes (arquivos no IndexedDB, caminhos, ids).
    resolveAlias: {
      "node:fs": { browser: "./lib/browser/fs.ts" },
      "node:path": { browser: "path-browserify" },
      "node:path/posix": { browser: "path-browserify" },
    },
  },
};

export default nextConfig;

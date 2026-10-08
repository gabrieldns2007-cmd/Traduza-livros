/**
 * Liga a página ao service worker (versão pública do Verso).
 *
 * Só uma aba por vez — a “líder” — guarda os livros e roda as traduções;
 * pedidos feitos em outras abas são respondidos por ela. Quando a líder é
 * fechada, outra aba assume sozinha (Web Locks).
 */
import { handle } from "./backend";

let isLeader = false;
let listening = false;
let readyPromise: Promise<void> | null = null;

/** Pasta dos dados no aparelho, separada por conta. */
export function useDataDirFor(userId: string) {
  (globalThis as { __versoDataDir?: string }).__versoDataDir = `/u/${userId.replace(/[^\w-]/g, "")}/data`;
}

function listen() {
  if (listening) return;
  listening = true;
  navigator.serviceWorker.addEventListener("message", async (event: MessageEvent) => {
    const msg = event.data as { type?: string; url?: string; method?: string; headers?: [string, string][]; body?: ArrayBuffer | null };
    const port = event.ports[0];
    if (!port) return;
    if (msg.type === "verso-who-leads") {
      port.postMessage({ leader: isLeader });
      return;
    }
    if (msg.type !== "verso-api") return;
    try {
      if (!isLeader) {
        port.postMessage({ status: 503, headers: [["content-type", "application/json"]], body: JSON.stringify({ error: "Carregando o Verso…" }) });
        return;
      }
      const res = await handle(new Request(msg.url!, { method: msg.method, headers: msg.headers, body: msg.body ?? undefined }));
      const body = await res.arrayBuffer();
      port.postMessage({ status: res.status, headers: [...res.headers], body }, [body]);
    } catch (err) {
      console.error("[verso] falha ao responder pedido local", err);
      port.postMessage({ status: 500, headers: [["content-type", "application/json"]], body: JSON.stringify({ error: "Algo deu errado." }) });
    }
  });
}

/** Responde “não sou líder” enquanto a pessoa ainda não entrou (o SW pergunta a todas as abas). */
export function listenEarly() {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) listen();
}

/**
 * Registra o service worker, assume a liderança quando possível e resolve
 * quando a página já pode chamar /api/… normalmente.
 */
export function startLocalBackend(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!("serviceWorker" in navigator)) throw new Error("Este navegador não permite usar o Verso. Atualize-o ou use o Chrome.");
    listen();
    const leadership = new Promise<void>((resolve) => {
      if (!("locks" in navigator)) {
        isLeader = true;
        return resolve();
      }
      // a promessa nunca termina: a trava fica com esta aba até ela ser fechada
      void navigator.locks.request("verso-backend", () => {
        isLeader = true;
        resolve();
        return new Promise<void>(() => {});
      });
      // outra aba já é líder: esta só usa a dela
      setTimeout(resolve, 800);
    });
    await navigator.serviceWorker.register("/verso-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      });
    }
    await leadership;
    // pede ao navegador para não apagar os livros quando faltar espaço
    void navigator.storage?.persist?.().catch(() => false);
    if (isLeader) {
      // retoma traduções gratuitas que estavam em andamento quando a página foi fechada
      const { jobRunner } = await import("@/services/processing/job-runner");
      void jobRunner.init();
    }
  })();
  return readyPromise;
}

export function leader() {
  return isLeader;
}

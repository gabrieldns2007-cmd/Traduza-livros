/** Ao iniciar o servidor, retoma traduções que estavam em andamento. */
export async function register() {
  // na versão pública as traduções rodam no navegador de cada pessoa
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PUBLIC_VERSO_MODE !== "public") {
    const { jobRunner } = await import("./services/processing/job-runner");
    jobRunner.init().catch((err) => console.error("[verso] falha ao retomar traduções", err));
  }
}

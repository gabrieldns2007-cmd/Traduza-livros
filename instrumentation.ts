/** Ao iniciar o servidor, retoma traduções que estavam em andamento. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { jobRunner } = await import("./services/processing/job-runner");
    jobRunner.init().catch((err) => console.error("[verso] falha ao retomar traduções", err));
  }
}

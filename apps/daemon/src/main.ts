import { bootstrap } from "./bootstrap.ts";

const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
}

const daemon = await bootstrap();
await daemon.start(controller.signal);

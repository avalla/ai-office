export class OfficeDaemon {
  async start(signal: AbortSignal): Promise<void> {
    console.info("AI Office daemon started");

    while (!signal.aborted) {
      await Bun.sleep(500);
    }

    console.info("AI Office daemon stopped");
  }
}

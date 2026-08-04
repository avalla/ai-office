import { OfficeDaemon } from "./office-daemon.ts";

export async function bootstrap(): Promise<OfficeDaemon> {
  return new OfficeDaemon();
}

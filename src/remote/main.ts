import { loadConfig } from "./config.ts";
import { createApp } from "./server.ts";

const config = loadConfig();
const log = (line: string) => process.stdout.write(`${line}\n`);
const server = await createApp({ config, log });
server.listen(config.port, "127.0.0.1", () => {
  log(`anylist-mcp listening on 127.0.0.1:${config.port} as ${config.publicUrl.origin}`);
});

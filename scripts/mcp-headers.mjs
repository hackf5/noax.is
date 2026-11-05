import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

async function readCredentials() {
  try {
    return parseEnv(await readFile(new URL("../.local/mcp.env", import.meta.url), "utf8"));
  } catch {
    throw new Error("Cannot read Noax publishing credentials. Restore .local/mcp.env in this checkout.");
  }
}

export async function getMcpUrl() {
  const { NOAX_MCP_URL: value } = await readCredentials();
  if (!value) throw new Error("Set NOAX_MCP_URL in .local/mcp.env.");
  return new URL(value);
}

export async function getMcpHeaders() {
  const credentials = await readCredentials();
  const headers = {};
  for (const [header, variable] of [
    ["CF-Access-Client-Id", "NOAX_ACCESS_CLIENT_ID"],
    ["CF-Access-Client-Secret", "NOAX_ACCESS_CLIENT_SECRET"],
  ]) {
    const value = credentials[variable];
    if (!value || !/^[\x21-\x7e]+$/.test(value)) {
      throw new Error(`Set a valid ${variable} in .local/mcp.env.`);
    }
    headers[header] = value;
  }
  return headers;
}

// This entry point is for MCP clients; stdout must contain only their JSON headers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify(await getMcpHeaders()) + "\n");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

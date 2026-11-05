import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        PUBLIC_HOST: "blog.test",
        MCP_HOST: "mcp.blog.test",
        ACCESS_TEAM_DOMAIN: "https://test-noax.cloudflareaccess.com",
        ACCESS_AUD: "noax-test-audience",
        SITE_TITLE: "Test Blog",
        SITE_DESCRIPTION: "Notes for the test suite.",
        SITE_LOCALE: "en-GB",
        SITE_CONTENT_SIGNAL: "search=yes, ai-input=yes, ai-train=no",
      },
    },
  })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 },
});

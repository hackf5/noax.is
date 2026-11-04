import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        ACCESS_TEAM_DOMAIN: "https://test-noax.cloudflareaccess.com",
        ACCESS_AUD: "noax-test-audience",
      },
    },
  })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 },
});

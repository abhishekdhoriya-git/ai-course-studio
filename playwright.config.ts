import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests\\ui",
  timeout: 45000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: {
    browserName: "chromium",
    channel: "msedge",
    viewport: { width: 1440, height: 960 },
    headless: true,
    screenshot: "only-on-failure",
  },
});

import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
const brave="C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
export default defineConfig({
  testDir:"./tests/e2e", workers:1, timeout:60000,
  use:{baseURL:process.env.CV_TEST_ORIGIN||"http://127.0.0.1:3002",headless:true,viewport:{width:1280,height:900},
    launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(existsSync(brave)?brave:undefined),args:["--use-fake-device-for-media-stream","--use-angle=swiftshader","--enable-unsafe-swiftshader"]},
    screenshot:"only-on-failure",trace:"retain-on-failure"},
  webServer:{command:"npm run dev:yuvraj",url:"http://127.0.0.1:3002/rehab",reuseExistingServer:true,timeout:120000},
});

// WebdriverIO 설정 — `tauri-driver` (뒤에서 Edge WebDriver) 가 개발 빌드 앱을 띄운다. `npm run e2e` (run.ts) 가 시험 폴더 · 드라이버를 준비하고 이 설정으로 부른다.
import { APP_EXE } from "./lib/paths.ts";

const port = Number(process.env.E2E_DRIVER_PORT ?? "4474");

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port,
  path: "/",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [{ "tauri:options": { application: APP_EXE } }],
  logLevel: "warn",
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180_000 },
};

import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      // 화면 코드는 IPC 를 `src/lib/ipc.ts` 로만 부른다 (아래 예외 한 곳).
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@tauri-apps/api/core",
              message: "`src/lib/ipc.ts` 의 함수를 쓰세요. invoke 는 거기서만 부릅니다.",
            },
            {
              name: "@tauri-apps/api",
              message: "`src/lib/ipc.ts` 의 함수를 쓰세요. invoke 는 거기서만 부릅니다.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/ipc.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);

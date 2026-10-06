import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "src/generated/**", "drizzle/**", "node_modules/**", "spec/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", AbortSignal: "readonly", AbortController: "readonly", Response: "readonly", Request: "readonly", Headers: "readonly", TextEncoder: "readonly", TextDecoder: "readonly", ReadableStream: "readonly", URLSearchParams: "readonly" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "error",
      eqeqeq: ["error", "always"]
    }
  },
  { files: ["scripts/**", "test/**"], rules: { "no-console": "off" } }
);

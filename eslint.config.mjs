// ESLint v9 flat config. The repo ships TypeScript with `"type": "module"`
// and uses tsx at runtime, so we lint .ts via typescript-eslint's
// recommended rules. Kept minimal on purpose — this is a crawler with
// tight source scope, not an app; adding stylistic plugins would just
// create churn in PRs.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        // Node globals — crawler runs in Node, not the browser.
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
      },
    },
    rules: {
      // Allow `_unused` parameter names (common pattern for ignoring
      // args in callbacks) without triggering no-unused-vars.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The codebase leans on `any` in a few hot paths where upstream
      // types are too permissive to be useful (Supabase query result
      // shapes, Cheerio nodes). Warn so new uses are visible without
      // blocking the merge.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];

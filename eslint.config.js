import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      // The standalone pipeline has its own dependency tree and generated data.
      // The `lint` script runs a second pass over the Lake source files.
      "pipeline/**",
      "artifacts/**",
      // Generated deployment output, not source: the Lambda bundle is
      // assembled from built packages and vendored dependencies by
      // `just bundle`, and cdk.out is CloudFormation the CLI writes.
      "infra/bundle/**",
      "infra/cdk.out/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/*.config.js",
      "**/*.config.ts",
    ],
  },
  {
    // Node scripts under infra/ and scripts/ are ESM run directly by node, so
    // they need the node globals that the TypeScript packages get from their own
    // tsconfig.
    files: [
      "infra/**/*.mjs",
      "infra/**/*.ts",
      "scripts/**/*.mjs",
      "pipeline/**/*.mjs",
      "pipeline/**/*.ts",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx", "pipeline/**/*.ts"],
    rules: {
      // The engineering guidelines forbid `any` in LLM code; we forbid it everywhere.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },
  {
    // The demo recorder is a Node script that also ships function bodies into a
    // browser via page.evaluate, so it legitimately references both globals.
    files: ["packages/ui/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        document: "readonly",
        window: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
      },
    },
    rules: { "no-console": "off" },
  },
  prettier,
);

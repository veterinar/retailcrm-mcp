import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "**/*.test.ts", "tests"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The MCP tool registry intentionally bridges generic handler signatures.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);

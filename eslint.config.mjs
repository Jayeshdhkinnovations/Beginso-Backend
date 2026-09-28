import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Deliberately lenient: this project predates linting and uses `any` widely. The rules that stay
// on catch real bugs (undefined variables, unreachable code, unsafe regexes, floating braces);
// style and typing rules are off so lint stays quiet enough to keep running in CI.
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "src/config/firebase/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "no-prototype-builtins": "warn",
      "no-async-promise-executor": "warn",
    },
  },
);

// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output, dependencies, and coverage reports are never part of
    // this project's own source. Dot-directories are excluded generically
    // too (`.git`, an editor's own config folder, or any other local
    // working directory a contributor's own tooling creates) - lint has
    // no reason to look inside another tool's local state.
    ignores: ["dist/**", "node_modules/**", "coverage/**", ".*/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // TypeScript already checks this statically, and the vanilla rule
      // produces false positives against TS-only constructs.
      "no-undef": "off",
    },
  },
  {
    files: ["test/**/*.js", "scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
    },
  }
);

// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".wrangler/**",
      ".astro/**",
      "node_modules/**",
      "worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    // The one sanctioned structured-logging sink (src/server/log.ts) — pino's
    // browser-mode `write` callback is the only thing allowed to call
    // console.log directly; every other server module logs through `log`.
    files: ["src/server/log.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // CLAUDE.md NEVER block: "never let vault.get() be called outside
    // src/lib/drivers/**". Route/service code needs to import Vault to call
    // .rotate() (key-rotation write path), so a blanket import ban would
    // break that; this instead blocks the specific .get() call by the
    // project-wide naming convention of binding a Vault instance to a local
    // named `vault` — a heuristic, not a type-level guarantee, documented as
    // such in docs/DECISIONS.md's hardening entry.
    files: ["src/**/*.ts"],
    ignores: ["src/lib/drivers/**", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.object.name=/^vault$/i][callee.property.name='get']",
          message: "vault.get() may only be called from src/lib/drivers/** (CLAUDE.md NEVER block) — construct the driver there instead of decrypting the key at the call site.",
        },
      ],
    },
  },
);

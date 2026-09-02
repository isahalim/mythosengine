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
    // .tsx included deliberately: the six-stage app (src/app/**) is React,
    // and before 2026-08-31 this glob said "**/*.ts" only, which meant the
    // one .tsx file in the tree was linted by nothing but the recommended
    // presets. Every rule below is exactly the bar the rest of src/ is held
    // to, so the UI is held to it too.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // Node scripts, and the stub servers/binaries the driver contract tests
    // spawn as real subprocesses (src/lib/**/__fixtures__). Those are not
    // application code and never reach a bundle — they exist so a driver is
    // tested against a process that actually speaks its protocol.
    files: ["scripts/**/*.mjs", "src/lib/**/__fixtures__/*.mjs"],
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
    files: ["src/**/*.ts", "src/**/*.tsx"],
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

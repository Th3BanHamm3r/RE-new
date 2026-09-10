import js from "@eslint/js";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
    globalIgnores([
        "node_modules/**",
        "dist/**",
    ]),

    {
        files: [
            "background.js",
            "contentScript.js",
        ],

        ...js.configs.recommended,

        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "script",

            globals: {
                ...globals.browser,
                ...globals.webextensions,
            },
        },

        rules: {
            "no-empty": [
                "error",
                {
                    allowEmptyCatch: true,
                },
            ],

            "no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    caughtErrors: "none",
                },
            ],
        },
    },

    {
        files: [
            "scripts/**/*.js",
            "scripts/**/*.mjs",
            "eslint.config.mjs",
        ],

        ...js.configs.recommended,

        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",

            globals: {
                ...globals.node,
            },
        },

        rules: {
            "no-empty": [
                "error",
                {
                    allowEmptyCatch: true,
                },
            ],

            "no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    caughtErrors: "none",
                },
            ],
        },
    },
]);
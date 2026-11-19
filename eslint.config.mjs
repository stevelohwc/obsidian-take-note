// Obsidian's own lint rules (the same family its community-plugin review uses).
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	// Build output and Node-side scripts/tests are not plugin code.
	globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "scripts", "tests", "helper"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
			},
		},
	},
	{
		// The type-aware checks Obsidian's plugin review runs, so they fail here first.
		files: ["src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
			"@typescript-eslint/no-require-imports": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-deprecated": "error",
		},
	},
]);

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
]);

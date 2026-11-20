// esbuild embeds .cjs files as text (see esbuild.config.mjs).
declare module "*.cjs" {
	const source: string;
	export default source;
}

// Electron is provided by Obsidian at runtime; only the part we use is typed here.
declare module "electron" {
	export const webUtils: { getPathForFile?: (file: File) => string } | undefined;
}

// Electron's renderer puts Node's require() on window (desktop only; see node.ts).
interface Window {
	require: (id: string) => unknown;
}

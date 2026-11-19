// esbuild embeds .cjs files as text (see esbuild.config.mjs).
declare module "*.cjs" {
	const source: string;
	export default source;
}

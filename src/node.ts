// Node and Electron, loaded only in the desktop app. Phones and tablets have neither, so a
// plain `import * as fs from "fs"` would stop the plugin loading there. Code that uses these
// (recording, transcription, speakers) is only reachable on desktop; if it ever ran on a
// phone, the stand-in below says what went wrong instead of failing silently.
import { Platform } from "obsidian";

// The modules' types, named without an import statement: nothing here loads them.
export type FsModule = typeof import("fs");
export type OsModule = typeof import("os");
export type PathModule = typeof import("path");
export type ChildProcessModule = typeof import("child_process");
export type ChildProcess = import("child_process").ChildProcess;
type HttpModule = typeof import("http");
type HttpsModule = typeof import("https");
type ElectronModule = typeof import("electron");

/** True in the desktop app (also under its mobile emulation, where Node still exists). */
export const hasNode = Platform.isDesktopApp;

function unavailable<T>(name: string): T {
	return new Proxy(
		{},
		{
			get: (_target, key) => {
				throw new Error(`Take Note: ${name}.${String(key)} needs the Obsidian desktop app.`);
			},
		},
	) as T;
}

// Each require() sits right behind its own desktop check, as Obsidian's guidelines ask.
export const fs = Platform.isDesktopApp ? (window.require("fs") as FsModule) : unavailable<FsModule>("fs");
export const os = Platform.isDesktopApp ? (window.require("os") as OsModule) : unavailable<OsModule>("os");
export const path = Platform.isDesktopApp ? (window.require("path") as PathModule) : unavailable<PathModule>("path");
export const childProcess = Platform.isDesktopApp
	? (window.require("child_process") as ChildProcessModule)
	: unavailable<ChildProcessModule>("child_process");
export const http = Platform.isDesktopApp ? (window.require("http") as HttpModule) : unavailable<HttpModule>("http");
export const https = Platform.isDesktopApp ? (window.require("https") as HttpsModule) : unavailable<HttpsModule>("https");
export const electron = Platform.isDesktopApp
	? (window.require("electron") as ElectronModule)
	: unavailable<ElectronModule>("electron");

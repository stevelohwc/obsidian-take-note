// Node and Electron, loaded only in the desktop app. Phones and tablets have neither, so a
// plain `import * as fs from "fs"` would stop the plugin loading there. Code that uses these
// (recording, transcription, speakers) is only reachable on desktop; if it ever ran on a
// phone, the stand-in below says what went wrong instead of failing silently.
import { Platform } from "obsidian";
import type * as ChildProcessModule from "child_process";
import type * as ElectronModule from "electron";
import type * as FsModule from "fs";
import type * as HttpModule from "http";
import type * as HttpsModule from "https";
import type * as OsModule from "os";
import type * as PathModule from "path";

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
export const fs = Platform.isDesktopApp ? (window.require("fs") as typeof FsModule) : unavailable<typeof FsModule>("fs");
export const os = Platform.isDesktopApp ? (window.require("os") as typeof OsModule) : unavailable<typeof OsModule>("os");
export const path = Platform.isDesktopApp ? (window.require("path") as typeof PathModule) : unavailable<typeof PathModule>("path");
export const childProcess = Platform.isDesktopApp
	? (window.require("child_process") as typeof ChildProcessModule)
	: unavailable<typeof ChildProcessModule>("child_process");
export const http = Platform.isDesktopApp ? (window.require("http") as typeof HttpModule) : unavailable<typeof HttpModule>("http");
export const https = Platform.isDesktopApp ? (window.require("https") as typeof HttpsModule) : unavailable<typeof HttpsModule>("https");
export const electron = Platform.isDesktopApp
	? (window.require("electron") as typeof ElectronModule)
	: unavailable<typeof ElectronModule>("electron");

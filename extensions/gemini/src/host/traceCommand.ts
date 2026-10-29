/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The performance trace being recorded, if any. The recorder itself
// (traceRecorder.ts) loads only when Gemini: Record Performance Trace first
// runs, from a bundle of its own; the state stays here, in the extension's
// bundle, where the chat reads it.

let recordingFile: string | undefined;
let folder: string | undefined;

/** The folder traces are written to, set at activation; traces from before it moved there are in the home folder. */
export function traceFolders(): string[] {
	return folder ? [folder] : [];
}

/** Sets the folder traces are written to. */
export function setTraceFolder(dir: string): void {
	folder = dir;
}

/** The trace file the agent is writing to while a recording is on, for the chat's per-turn readout. */
export function currentTraceFile(): string | undefined {
	return recordingFile;
}

/** Sets the trace file being recorded; undefined when the recording stops. */
export function setTraceFile(file: string | undefined): void {
	recordingFile = file;
}

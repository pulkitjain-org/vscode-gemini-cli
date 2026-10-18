/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AuditEntry } from '../acp/auditLog';
import { errorMessage } from '../acp/errors';
import { PilotLog, pilotExport, recordPilot, setPilotSink } from '../acp/pilotLog';
import { configSection } from './configuration';
import type { TeamConnections } from './teamConnections';
import type { UsageMeter } from './usageMeter';

const recordSetting = 'pilot.record';
/** Home lists what was unfinished once startup has settled; the count is taken then too. */
const unfinishedDelayMs = 10_000;

/**
 * The pilot's counters (gemini/docs/AGENTIC-PLAN.md, section 6): recorded while `gemini.pilot.record`
 * is on, and written with the audit log to ~/geminicode-pilot/<date>.jsonl by Gemini: Export Pilot
 * Data, for the developer to hand over. Counts and timings only; nothing leaves the Mac on its own.
 */
export class Pilot implements vscode.Disposable {

	private readonly log: PilotLog;
	private readonly disposables: vscode.Disposable[] = [];
	private unfinishedTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(storageDir: string, private readonly team: TeamConnections, usage: UsageMeter) {
		this.log = new PilotLog(path.join(storageDir, 'pilot'));
		this.disposables.push(
			vscode.commands.registerCommand('gemini.pilot.export', () => this.export()),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.${recordSetting}`) && this.apply(false)),
			usage.onDidChange(quota => quota && recordPilot({ kind: 'usage', quota: quota.map(q => ({ model: q.model, used: q.used, ...q.resetTime ? { resetTime: q.resetTime } : {} })) })),
		);
		this.apply(true);
	}

	dispose(): void {
		clearTimeout(this.unfinishedTimer);
		setPilotSink(undefined);
		void this.log.flush();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** Starts or stops recording as the setting says; at launch, also records the launch and what was unfinished. */
	private apply(launch: boolean): void {
		const on = vscode.workspace.getConfiguration(configSection).get<boolean>(recordSetting, false);
		setPilotSink(on ? record => this.log.add(record) : undefined);
		if (on && launch) {
			recordPilot({ kind: 'launch' });
			this.unfinishedTimer = setTimeout(() => void this.recordUnfinished(), unfinishedDelayMs);
		}
	}

	private async recordUnfinished(): Promise<void> {
		const [flows, writes] = await Promise.all([this.team.flows.list(), this.team.audit.unfinished()]).catch(() => [[], []]);
		recordPilot({ kind: 'unfinished', flows: flows.length, writes: writes.length });
	}

	private async export(): Promise<void> {
		try {
			const records = await this.log.readAll();
			const audit: AuditEntry[] = [];
			for (const day of (await this.team.audit.days()).reverse()) {
				audit.push(...await this.team.audit.read(new Date(`${day}T00:00:00Z`)));
			}
			const dir = path.join(os.homedir(), 'geminicode-pilot');
			const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(file, pilotExport(records, audit));
			const reveal = vscode.l10n.t("Show in Finder");
			const recording = vscode.workspace.getConfiguration(configSection).get<boolean>(recordSetting, false);
			const message = records.length || recording
				? vscode.l10n.t("Wrote {0} pilot events and {1} audit records to {2}. Hand the geminicode-pilot folder over at the end of the pilot.", records.length, audit.length, file)
				: vscode.l10n.t("Wrote {0} audit records to {1}. No pilot events were recorded: turn on the gemini.pilot.record setting to count them.", audit.length, file);
			if (await vscode.window.showInformationMessage(message, reveal) === reveal) {
				await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
			}
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Couldn't export the pilot data: {0}", errorMessage(err)));
		}
	}
}

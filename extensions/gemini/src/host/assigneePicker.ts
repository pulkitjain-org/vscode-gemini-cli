/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Reassign's picker (teamFlows.ts), in dist/onDemand.js: loaded the first time
// a ticket is reassigned.

import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import type { JiraUser } from '../acp/jira';
import type { JiraSites } from '../acp/jiraSites';

/**
 * Who should have `ticket` (its key, or its link, which names its Jira site;
 * `label` is what the title calls it): Me, Unassigned, then the people the
 * project lets take it. Jira gives the first 50 at once; typing searches Jira
 * for everyone else, since a team's people are often not among the first 50.
 */
export async function pickAssignee(jira: Pick<JiraSites, 'myself' | 'assignableUsers'>, ticket: string, label = ticket): Promise<(vscode.QuickPickItem & { readonly accountId: string | null }) | undefined> {
	type Choice = vscode.QuickPickItem & { readonly accountId: string | null; readonly searchFailed?: boolean };
	const person = (u: JiraUser): Choice => ({ label: u.displayName, ...u.emailAddress ? { description: u.emailAddress } : {}, accountId: u.accountId });
	const pick = vscode.window.createQuickPick<Choice>();
	pick.title = vscode.l10n.t("Reassign {0}", label);
	pick.placeholder = vscode.l10n.t("Type a name or email to search everyone the project allows");
	pick.matchOnDescription = true;
	pick.busy = true;
	let me: JiraUser | undefined;
	let first: readonly JiraUser[] = [];
	/** What Jira found for the text typed, shown even when its names don't contain the text. */
	let found: readonly JiraUser[] = [];
	/** Why the search for the text typed failed. */
	let failed: string | undefined;
	/** The picker is busy while the first people load or a search for the text typed runs. */
	let loading = true;
	let searching = false;
	const busy = () => pick.busy = loading || searching;
	const draw = () => {
		const seen = new Set<string>(me ? [me.accountId] : []);
		const unique = (users: readonly JiraUser[]) => users.filter(u => !seen.has(u.accountId) && seen.add(u.accountId));
		const searched = unique(found).map(u => ({ ...person(u), alwaysShow: true }));
		pick.items = [
			...me ? [{ label: vscode.l10n.t("$(account) Me"), description: me.displayName, accountId: me.accountId }] : [],
			{ label: vscode.l10n.t("$(circle-slash) Unassigned"), accountId: null },
			{ label: '', kind: vscode.QuickPickItemKind.Separator, accountId: null },
			...failed ? [{ label: vscode.l10n.t("$(warning) Search failed"), detail: failed, accountId: null, alwaysShow: true, searchFailed: true }] : [],
			...searched,
			...unique(first).map(person),
		];
	};
	const searches = new Map<string, Promise<{ readonly users: readonly JiraUser[]; readonly error?: string }>>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let latest = '';
	pick.onDidChangeValue(value => {
		clearTimeout(timer);
		latest = value.trim();
		if (latest.length < 2) {
			found = [];
			failed = undefined;
			searching = false;
			busy();
			draw();
			return;
		}
		const query = latest;
		timer = setTimeout(() => {
			let search = searches.get(query);
			if (!search) {
				search = jira.assignableUsers(ticket, query).then(users => ({ users }), (err: unknown) => {
					// Not kept: typing the same text again searches again.
					searches.delete(query);
					return { users: [], error: errorMessage(err) };
				});
				searches.set(query, search);
			}
			searching = true;
			busy();
			void search.then(answer => {
				// Only the answer for what is typed now.
				if (query === latest) {
					found = answer.users;
					failed = answer.error;
					draw();
					searching = false;
					busy();
				}
			});
		}, 250);
	});
	draw();
	pick.show();
	void Promise.all([jira.myself(ticket), jira.assignableUsers(ticket)]).then(([self, people]) => {
		me = self;
		first = people;
		draw();
	}, err => {
		pick.hide();
		void vscode.window.showErrorMessage(vscode.l10n.t("Couldn't read who can take {0}: {1}", label, errorMessage(err)));
	}).finally(() => {
		loading = false;
		busy();
	});
	const chosen = await new Promise<Choice | undefined>(resolve => {
		pick.onDidAccept(() => {
			const item = pick.selectedItems[0];
			if (!item?.searchFailed) {
				resolve(item);
			}
		});
		pick.onDidHide(() => resolve(undefined));
	});
	clearTimeout(timer);
	pick.dispose();
	return chosen && chosen.kind !== vscode.QuickPickItemKind.Separator ? chosen : undefined;
}

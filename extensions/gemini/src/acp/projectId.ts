/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Resolves which Google Cloud project the agent bills to (plan Phase 1 "project-id").

export type ProjectIdSource = 'workspace' | 'user' | 'org' | 'env';

export interface ProjectIdInputs {
	/** `gemini.projectId` from workspace or folder settings. */
	readonly workspace?: string;
	/** `gemini.projectId` from user settings. */
	readonly user?: string;
	/** The organisation default shipped with the app. */
	readonly orgDefault?: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedProjectId {
	readonly projectId: string;
	readonly source: ProjectIdSource;
}

const envVars = ['GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID'] as const;

/** First non-empty value of: workspace setting, user setting, org default, environment. */
export function resolveProjectId(inputs: ProjectIdInputs): ResolvedProjectId | undefined {
	const candidates: [string | undefined, ProjectIdSource][] = [
		[inputs.workspace, 'workspace'],
		[inputs.user, 'user'],
		[inputs.orgDefault, 'org'],
		...envVars.map((name): [string | undefined, ProjectIdSource] => [inputs.env[name], 'env']),
	];
	for (const [value, source] of candidates) {
		const projectId = value?.trim();
		if (projectId) {
			return { projectId, source };
		}
	}
	return undefined;
}

export type ProjectIdProblem = 'numeric' | 'malformed';

// 6 to 30 characters: lowercase letters, digits and hyphens, starting with a letter
// and not ending with a hyphen. Legacy domain-scoped IDs look like `example.com:my-project`.
const projectIdPattern = /^(?:[a-z][a-z0-9.-]*\.[a-z]{2,}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * Catches what the CLI would reject later with a less helpful message.
 * The CLI itself only rejects purely numeric IDs (project numbers).
 */
export function validateProjectId(projectId: string): ProjectIdProblem | undefined {
	if (/^\d+$/.test(projectId)) {
		return 'numeric';
	}
	if (!projectIdPattern.test(projectId)) {
		return 'malformed';
	}
	return undefined;
}

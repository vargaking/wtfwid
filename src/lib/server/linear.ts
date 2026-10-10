import type { Issue } from '../model';

const QUERY = `
query Issues($filter: IssueFilter, $after: String) {
  issues(first: 100, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier title url createdAt startedAt completedAt canceledAt branchName
      state { name type }
      project { id name }
      projectMilestone { id name }
    }
  }
}`;

const MAX_PAGES = 20;

export function toIssue(n: any): Issue {
	return {
		id: n.identifier,
		title: n.title,
		url: n.url,
		createdAt: n.createdAt,
		startedAt: n.startedAt ?? null,
		completedAt: n.completedAt ?? null,
		canceledAt: n.canceledAt ?? null,
		stateName: n.state?.name ?? '',
		stateType: n.state?.type ?? '',
		branchName: n.branchName ?? '',
		project: n.project ? { id: n.project.id, name: n.project.name } : null,
		milestone: n.projectMilestone ? { id: n.projectMilestone.id, name: n.projectMilestone.name } : null
	};
}

/** All issues of one team, or of the whole workspace when no team is given (S-60). */
export async function fetchIssues(apiKey: string, team: string | null, fetcher: typeof fetch = fetch): Promise<Issue[]> {
	const filter = team ? { team: { key: { eq: team } } } : undefined;
	const issues: Issue[] = [];
	let after: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await fetcher('https://api.linear.app/graphql', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: apiKey },
			body: JSON.stringify({ query: QUERY, variables: { filter, after } })
		});
		const body: any = await res.json().catch(() => null);
		if (!res.ok || body?.errors) {
			throw new Error(body?.errors?.[0]?.message ?? `HTTP ${res.status}`);
		}
		const conn = body.data.issues;
		issues.push(...conn.nodes.map(toIssue));
		if (!conn.pageInfo.hasNextPage) break;
		after = conn.pageInfo.endCursor;
	}
	return issues;
}

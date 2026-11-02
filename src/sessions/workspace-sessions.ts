// Workspace session listing for the Feishu-side /resume command.
//
// Lists the HISTORICAL DSH sessions of one workspace (cwd) so a Feishu chat can
// pick one up again. Two layered sources (same discipline as doctor's export):
//
//   1. sessionPersistence service (preferred): headers carry createdAt, cwd,
//      agentPreset and origin — exact cwd equality, subagent children excluded.
//   2. filesystem scan (fallback): <DSH_HOME>/sessions/<projectKey(cwd)>/<encoded-id>/
//      <generation log>, decoded + mtime-sorted. The projectKey encoding is
//      ported VERBATIM from dsh-session-persistence-jsonl (lossy by design —
//      separators collapse, unsafe code units escape as ~XXXX) so the scan
//      lands in exactly the directory DSH writes.
//
// Generation log filename: dsh 0.1.x wrote a fixed `session.jsonl.zstd`
// (format v0 "suffix-only" name); dsh 0.2.x writes generation-versioned
// `session.v<N>.jsonl.zstd` (e.g. v4 on 0.2.1-rc.x). The scan accepts both
// and picks the highest generation present, so /resume keeps working across
// harness generations instead of silently listing nothing.
//
// Harness-agnostic: the service is injected as a narrow structural interface.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Header-like row of the DSH sessionPersistence service (structural slice). */
export interface SessionHeaderLike {
	id: string;
	createdAt: number;
	cwd?: string;
	agentPreset?: string;
	origin?: string;
	title?: string;
}

export interface WorkspaceSessionInfo {
	id: string;
	/** epoch ms — header createdAt (service) or log mtime (scan). */
	createdAt: number;
	/** stored agentPreset — present on the service source only. */
	preset?: string;
	/** Human-readable session title (if available). */
	title?: string;
	source: "service" | "scan";
}

export interface PersistenceListSource {
	list(signal?: AbortSignal): Promise<SessionHeaderLike[]>;
	inspect?(id: string, signal?: AbortSignal): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
	load?(id: string): Promise<{ header?: unknown; events?: readonly unknown[] } | undefined>;
	readFrom?(id: string, fromSeq: number): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
}


export interface ListWorkspaceSessionsDeps {
	/** DSH sessions root — <DSH_HOME>/sessions. */
	sessionsRoot: string;
	/** the workspace whose sessions to list. */
	cwd: string;
	/** live sessionPersistence service (optional — scan fallback otherwise). */
	persistence?: PersistenceListSource;
	/** Optional title resolver for session ids. */
	titleFor?: (sessionId: string) => string | undefined;
	/** ids to hide (e.g. this conversation's CURRENT session). */
	exclude?: string[];
	/** cap (default 10). */
	limit?: number;
}

/**
 * Extract a human-readable title from a session's events:
 * 1. session/title event (highest precedence)
 * 2. first user message text (deterministic fallback)
 */
export function extractTitleFromEvents(events: readonly unknown[]): string | undefined {
	if (!Array.isArray(events) || events.length === 0) return undefined;
	// 1. Look for explicit session/title event from the end
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i] as { type?: string; data?: { title?: string } };
		if (ev?.type === "session/title" && ev.data?.title) {
			const t = ev.data.title.trim();
			if (t) return t.slice(0, 36);
		}
	}
	// 2. Look for first human text-bearing user message
	for (let i = 0; i < events.length; i++) {
		const ev = events[i] as {
			type?: string;
			data?: {
				source?: { kind?: string };
				content?: Array<{ type?: string; text?: string }>;
			};
		};
		if (ev?.type === "user/message") {
			const text = (ev.data?.content ?? [])
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text?.trim())
				.filter(Boolean)
				.join(" ");
			if (text) {
				const clean = text.replace(/^\/[a-zA-Z0-9_-]+\s*/, "").trim();
				const candidate = clean || text;
				const oneLine = candidate.replace(/[\r\n\t]+/g, " ").trim();
				if (oneLine) return oneLine.slice(0, 36);
			}
		}
	}
	return undefined;
}

/**
 * Port of dsh-session-persistence-jsonl's projectKey: `/`, `\` and `:` become
 * `-` (consecutive runs collapse), safe `[A-Za-z0-9._-]` passes, everything
 * else escapes as `~XXXX` (uppercase hex code unit); wrapped `--…--` with the
 * readable part bounded to 251 chars and `root` when empty.
 */
export function projectKeyOf(cwd: string): string {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const ch = cwd[i] as string;
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Decode an encoded session dir name (`~003A` → `:` etc.). */
export function decodeSessionDirName(name: string): string {
	return name.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

/**
 * Canonical session log filename across harness generations: bare
 * `session.jsonl.zstd` (v0, dsh 0.1.x) or `session.v<N>.jsonl.zstd`
 * (generation N, dsh 0.2.x).
 */
export const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/**
 * Pick the highest-generation session log inside one session directory.
 * Returns the file name (not a path), or undefined when the session has no
 * materialized log (never written / mid-migration) and is not resumable.
 */
export function sessionLogFileName(sessionDir: string): string | undefined {
	let best: string | undefined;
	let bestGen = -1;
	for (const entry of readdirSync(sessionDir)) {
		const m = SESSION_LOG_RE.exec(entry);
		if (!m) continue;
		const gen = m[1] === undefined ? 0 : Number(m[1]);
		if (gen > bestGen) {
			bestGen = gen;
			best = entry;
		}
	}
	return best;
}

/** List historical sessions of one workspace, newest first, capped. */
export async function listWorkspaceSessions(
	deps: ListWorkspaceSessionsDeps,
): Promise<WorkspaceSessionInfo[]> {
	const limit = deps.limit ?? 10;
	const exclude = new Set(deps.exclude ?? []);
	let rows: WorkspaceSessionInfo[] = [];

	// Source 1: the persistence service — headers give exact cwd + origin.
	if (deps.persistence?.list) {
		try {
			const headers = await deps.persistence.list();
			rows = headers
				.filter(
					(h) =>
						h.cwd === deps.cwd &&
						h.origin !== "subagent" &&
						!exclude.has(h.id),
				)
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, limit)
				.map<WorkspaceSessionInfo>((h) => {
					const title = deps.titleFor?.(h.id) ?? h.title;
					return {
						id: h.id,
						createdAt: h.createdAt,
						...(h.agentPreset ? { preset: h.agentPreset } : {}),
						...(title ? { title } : {}),
						source: "service",
					};
				});
		} catch {
			// fall through to the filesystem scan
		}
	}

	// Source 2: filesystem scan of <sessionsRoot>/<projectKey(cwd)>/.
	if (rows.length === 0) {
		const dir = join(deps.sessionsRoot, projectKeyOf(deps.cwd));
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)) {
				let mtime: number;
				try {
					const file = sessionLogFileName(join(dir, name));
					if (!file) continue; // no materialized log — not resumable
					mtime = statSync(join(dir, name, file)).mtimeMs;
				} catch {
					continue;
				}
				const id = decodeSessionDirName(name);
				if (exclude.has(id)) continue;
				const title = deps.titleFor?.(id);
				rows.push({ id, createdAt: mtime, ...(title ? { title } : {}), source: "scan" });
			}
			rows.sort((a, b) => b.createdAt - a.createdAt);
			rows = rows.slice(0, limit);
		}
	}

	// Resolve titles from persistence events if not already present
	if (deps.persistence && rows.length > 0) {
		await Promise.allSettled(
			rows.map(async (row) => {
				if (row.title) return;
				if (deps.titleFor) {
					const t = deps.titleFor(row.id);
					if (t) {
						row.title = t;
						return;
					}
				}
				try {
					let events: readonly unknown[] | undefined;
					if (deps.persistence?.inspect) {
						const res = await deps.persistence.inspect(row.id);
						events = res?.events;
					} else if (deps.persistence?.load) {
						const res = await deps.persistence.load(row.id);
						events = res?.events;
					} else if (deps.persistence?.readFrom) {
						const res = await deps.persistence.readFrom(row.id, 0);
						events = res?.events;
					}
					if (events) {
						const extracted = extractTitleFromEvents(events);
						if (extracted) row.title = extracted;
					}
				} catch {
					// best-effort
				}
			}),
		);
	}

	return rows;
}



// Assistant-chunk synthesis from the llm/stream waterfall hook.
//
// dsh 0.2.x never emits `assistant/chunk` through session/event (the literal
// only survives in the legacy session-format converters), which leaves the
// CardKit streaming path permanently dark. The llm/stream waterfall hook DOES
// exist — dsh-llm wraps every model call with it — so tapping the chunk
// stream and re-emitting text deltas as bridge events restores streaming
// without touching any downstream code (forwarder/supervisor cannot tell the
// synthesized events from native ones).

import { isAgentLoopRequest, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";

/** Shape of one raw LLM stream chunk (only the fields we inspect). */
export interface LlmStreamChunkLike {
	type?: unknown;
	text?: unknown;
}

/**
 * Whether this llm/stream call should feed chunk synthesis for one bridge
 * session: same session, no native chunk events observed (those win), and a
 * main agent-loop request (title generation and other auxiliary LLM calls
 * also stream through the hook and must not leak into the reply card).
 */
export function shouldSynthesizeChunks(
	options: unknown,
	sessionId: string,
	nativeChunkSessions: ReadonlySet<string>,
): boolean {
	const opts = options as { sessionId?: unknown };
	return (
		opts.sessionId === sessionId &&
		!nativeChunkSessions.has(sessionId) &&
		isAgentLoopRequest(options as GenerateOptions)
	);
}

/**
 * Pass one LLM chunk stream through unchanged while emitting every visible
 * text delta. Reasoning deltas, tool-call deltas, empty texts and lifecycle
 * chunks flow through untouched and unannounced.
 */
export async function* synthesizeAssistantChunks<T extends LlmStreamChunkLike | null | undefined>(
	stream: AsyncIterable<T>,
	emit: (text: string) => void,
): AsyncIterable<T> {
	for await (const chunk of stream) {
		if (
			chunk?.type === "text-delta" &&
			typeof chunk.text === "string" &&
			chunk.text !== ""
		) {
			emit(chunk.text);
		}
		yield chunk;
	}
}

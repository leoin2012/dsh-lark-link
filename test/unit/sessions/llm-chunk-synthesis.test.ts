import { test } from "node:test";
import assert from "node:assert/strict";
import { markAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import {
	shouldSynthesizeChunks,
	synthesizeAssistantChunks,
} from "../../../src/sessions/llm-chunk-synthesis.ts";

// ---- shouldSynthesizeChunks --------------------------------------------------

// 测试只需让 isAgentLoopRequest 认得这个对象；sessionId 的品牌类型与单测无关。
const agentLoopReq = (sessionId: string) => markAgentLoopRequest({ sessionId } as never);

test("shouldSynthesizeChunks: same session + agent-loop request + no native chunks → true", () => {
	const options = agentLoopReq("sess-1");
	assert.equal(shouldSynthesizeChunks(options, "sess-1", new Set()), true);
});

test("shouldSynthesizeChunks: other session, non-agent-loop request, or native chunks → false", () => {
	const options = agentLoopReq("sess-1");
	assert.equal(shouldSynthesizeChunks(options, "sess-2", new Set()), false);
	assert.equal(shouldSynthesizeChunks(options, "sess-1", new Set(["sess-1"])), false);
	// 标题生成等辅助 LLM 调用没有 agent-loop 标记，必须被过滤
	assert.equal(
		shouldSynthesizeChunks({ sessionId: "sess-1" }, "sess-1", new Set()),
		false,
	);
	assert.equal(shouldSynthesizeChunks({}, "sess-1", new Set()), false);
});

// ---- synthesizeAssistantChunks -----------------------------------------------

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const chunk of stream) out.push(chunk);
	return out;
}

test("synthesizeAssistantChunks: text-delta emits and passes through in order", async () => {
	const emitted: string[] = [];
	async function* source() {
		yield { type: "text-delta", index: 0, text: "你好" };
		yield { type: "reasoning-delta", index: 1, text: "想一下" };
		yield { type: "text-delta", index: 0, text: "世界" };
		yield { type: "text-delta", index: 0, text: "" };
		yield { type: "finish", reason: { kind: "stop" } };
	}
	const chunks = await collect(synthesizeAssistantChunks(source(), (t) => emitted.push(t)));
	assert.deepEqual(emitted, ["你好", "世界"]);
	assert.equal(chunks.length, 5, "所有 chunk 原样透传");
	assert.equal((chunks[0] as { text: string }).text, "你好");
	assert.equal((chunks[4] as { type: string }).type, "finish");
});

test("synthesizeAssistantChunks: malformed chunks pass through without emitting", async () => {
	const emitted: string[] = [];
	async function* source() {
		yield { type: "text-delta" }; // 无 text 字段
		yield { type: "text-delta", text: 42 }; // 非字符串 text
		yield null;
		yield undefined;
	}
	const chunks = await collect(
		synthesizeAssistantChunks(source(), (t) => emitted.push(t)),
	);
	assert.deepEqual(emitted, []);
	assert.equal(chunks.length, 4);
});

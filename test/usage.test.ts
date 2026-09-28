import { expect, it } from "vitest";
import { UsageObserver } from "../src/usage.js";

it("observes fragmented SSE usage without inventing missing counts", () => {
  const observer = new UsageObserver(true);
  const data = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":12000,"input_tokens_details":{"cached_tokens":11000},"output_tokens":20}}}\r\n\r\n';
  for (const char of data) observer.push(Buffer.from(char));
  observer.finish();
  expect(observer.usage).toEqual({ input_tokens: 12000, cached_input_tokens: 11000, output_tokens: 20 });
  const missing = new UsageObserver(false);
  missing.push(Buffer.from('{"usage":{"input_tokens":3}}')); missing.finish();
  expect(missing.usage).toEqual({ input_tokens: 3, cached_input_tokens: null, output_tokens: null });
});

it("recognizes terminal completion across multiline SSE data without completing truncated events", () => {
  const complete = new UsageObserver(true);
  complete.push(Buffer.from('data: {"type":\ndata: "response.completed"}\n\n'));
  complete.finish();
  expect(complete.completed).toBe(true);
  const truncated = new UsageObserver(true);
  truncated.push(Buffer.from('data: {"type":"response.completed"}'));
  truncated.finish();
  expect(truncated.completed).toBe(false);
  expect(truncated.usage).toEqual({ input_tokens: null, cached_input_tokens: null, output_tokens: null });
});

it("merges Anthropic SSE usage across split lines, CRLF, and cumulative deltas", () => {
  const observer = new UsageObserver(true, "anthropic");
  const sse = [
    'event: ignored\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":3,"output_tokens":1}}}\r\n\r\n',
    'event: message_stop\r\ndata: {"type":"message_delta","usage":{"output_tokens":5,"cache_read_input_tokens":22,"input_tokens":null}}\r\n\r\n',
    'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":8,"cache_creation_input_tokens":4,"cache_read_input_tokens":null}}\r\n\r\n',
    'event: message_delta\r\ndata: {"type":"message_stop"}\r\n\r\n',
  ].join("");
  const bytes = Buffer.from(sse);
  for (let i = 0; i < bytes.length;) {
    const size = (i % 7) + 1;
    observer.push(bytes.subarray(i, i + size));
    i += size;
  }
  observer.finish();
  expect(observer.completed).toBe(true);
  expect(observer.usage).toEqual({ input_tokens: 36, cached_input_tokens: 22, cache_creation_input_tokens: 4, output_tokens: 8 });
});

it("keeps missing Anthropic usage null and does not complete on error", () => {
  const observer = new UsageObserver(true, "anthropic");
  observer.push(Buffer.from('event: message_stop\ndata: {"type":"message_start","message":{}}\n\n'));
  expect(observer.usage).toEqual({ input_tokens: null, cached_input_tokens: null, output_tokens: null });
  observer.push(Buffer.from('data: {"type":"message_delta","usage":{"cache_read_input_tokens":4,"output_tokens":2}}\n\n'));
  expect(observer.usage).toEqual({ input_tokens: null, cached_input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: null });
  observer.push(Buffer.from('data: {"type":"message_stop"}\n\ndata: {"type":"error","error":{"message":"secret"}}\n\n'));
  expect(observer.completed).toBe(false);
});

it("observes only completed Anthropic non-streaming messages", () => {
  const complete = new UsageObserver(false, "anthropic");
  complete.push(Buffer.from('{"type":"message","stop_reason":"end_turn","usage":{"input_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"output_tokens":5}}'));
  complete.finish();
  expect(complete.completed).toBe(true);
  expect(complete.usage).toEqual({ input_tokens: 9, cached_input_tokens: 3, cache_creation_input_tokens: 4, output_tokens: 5 });
  const incomplete = new UsageObserver(false, "anthropic");
  incomplete.push(Buffer.from('{"type":"message","stop_reason":null,"usage":{"input_tokens":7}}'));
  incomplete.finish();
  expect(incomplete.completed).toBe(false);
  expect(incomplete.usage).toEqual({ input_tokens: 7, cached_input_tokens: null, cache_creation_input_tokens: null, output_tokens: null });
});

it("drops oversized Anthropic events and recovers for the next event", () => {
  const observer = new UsageObserver(true, "anthropic");
  observer.push(Buffer.from(`data: {"type":"message_stop","padding":"${"x".repeat(1_048_576)}"}\n\n`));
  expect(observer.completed).toBe(false);
  observer.push(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\ndata: {"type":"message_stop"}\n\n'));
  expect(observer.usage.input_tokens).toBe(1);
  expect(observer.completed).toBe(true);
});

it("keeps OpenAI and Anthropic observation isolated", () => {
  const anthropic = new UsageObserver(true, "anthropic");
  const openai = new UsageObserver(true);
  const openaiEvent = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}\n\n';
  const anthropicEvent = 'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\ndata: {"type":"message_stop"}\n\n';
  anthropic.push(Buffer.from(openaiEvent));
  openai.push(Buffer.from(anthropicEvent));
  expect(anthropic.completed).toBe(false);
  expect(openai.completed).toBe(false);
  expect(anthropic.usage).toEqual({ input_tokens: null, cached_input_tokens: null, output_tokens: null });
  expect(openai.usage).toEqual({ input_tokens: null, cached_input_tokens: null, output_tokens: null });
});

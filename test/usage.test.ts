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

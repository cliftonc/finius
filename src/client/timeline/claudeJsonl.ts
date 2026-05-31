import type { BaseMessage } from "./types";

// Adapter: raw Claude Code transcript NDJSON -> BaseMessage[] for the timeline renderer.
//
// Claude Code writes one JSON object per line. The lines we care about carry a
// top-level `type` plus a nested `message` in Anthropic API shape:
//   - "user"      : message.content is a string (a real prompt) OR an array of
//                   blocks that, for tool turns, contains `tool_result` blocks.
//   - "assistant" : message.content is an array of `text` / `thinking` / `tool_use` blocks.
//   - "system"    : a local system note (`content` is a string).
// Everything else (mode, permission-mode, file-history-snapshot, attachment,
// ai-title, last-prompt, …) is bookkeeping noise and is skipped.
//
// `tool_use` blocks become `tool_use` messages and the `tool_result` blocks on a
// later user line become `tool_result` messages linked by id — exactly what
// processMessages() pairs up.

type Block = Record<string, unknown>;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function blockText(blocks: Block[], type: string, field: string): string {
  return blocks
    .filter((b) => b.type === type)
    .map((b) => asString(b[field]))
    .filter(Boolean)
    .join("\n\n");
}

export function parseTranscript(ndjson: string): BaseMessage[] {
  const out: BaseMessage[] = [];

  for (const raw of ndjson.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type;
    const uuid = asString(obj.uuid) || `line-${out.length}`;
    const ts = asString(obj.timestamp) || new Date(0).toISOString();
    const message = obj.message as Record<string, unknown> | undefined;

    if (type === "user" && message) {
      const content = message.content;
      if (typeof content === "string") {
        out.push({ id: uuid, timestamp: ts, type: "user", content: { text: content } });
      } else if (Array.isArray(content)) {
        let textIdx = 0;
        for (const block of content as Block[]) {
          if (block.type === "tool_result") {
            const toolUseId = asString(block.tool_use_id);
            out.push({
              id: toolUseId ? `${toolUseId}-result` : `${uuid}-tr${textIdx++}`,
              timestamp: ts,
              type: "tool_result",
              content: {
                tool_use_id: toolUseId,
                content: block.content,
                is_error: block.is_error === true,
              },
              linkedTo: toolUseId || undefined,
            });
          } else if (block.type === "text") {
            const text = asString(block.text);
            if (text) {
              out.push({
                id: `${uuid}-t${textIdx++}`,
                timestamp: ts,
                type: "user",
                content: { text },
              });
            }
          }
        }
      }
      continue;
    }

    if (type === "assistant" && message) {
      const content = message.content;
      if (Array.isArray(content)) {
        const blocks = content as Block[];
        const text = blockText(blocks, "text", "text");
        const reasoning = blockText(blocks, "thinking", "thinking");
        if (text || reasoning) {
          out.push({
            id: `${uuid}-text`,
            timestamp: ts,
            type: "assistant",
            content: { text, reasoning },
          });
        }
        let toolIdx = 0;
        for (const block of blocks) {
          if (block.type === "tool_use") {
            const id = asString(block.id) || `${uuid}-tu${toolIdx++}`;
            out.push({
              id,
              timestamp: ts,
              type: "tool_use",
              content: {
                id,
                name: asString(block.name) || "tool",
                input: (block.input as Record<string, unknown>) ?? {},
              },
            });
          }
        }
      } else if (typeof content === "string" && content) {
        out.push({ id: `${uuid}-text`, timestamp: ts, type: "assistant", content: { text: content } });
      }
      continue;
    }

    if (type === "system") {
      const text = asString(obj.content) || asString((message as Block | undefined)?.content);
      if (text) out.push({ id: uuid, timestamp: ts, type: "system", content: { text } });
      continue;
    }
  }

  return out;
}

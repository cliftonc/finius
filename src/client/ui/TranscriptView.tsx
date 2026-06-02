import { Button, Card, CardBody, Input } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { getSession, getTranscript, getTranscriptInfo } from "../api";
import { parseTranscriptToMessages } from "../timeline/adapters";
import { processMessages } from "../timeline/processor";
import { isToolPair, type TimelineItem as TimelineItemT } from "../timeline/types";
import { TimelineItem } from "./timeline/TimelineItem";

type Order = "oldest" | "newest";

function compact(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

// Flatten a timeline item to plain text for the search filter.
function searchText(item: TimelineItemT): string {
  if (isToolPair(item)) {
    const input = (item.use.content as { input?: unknown })?.input;
    const result = (item.result?.content as { content?: unknown })?.content;
    return `${item.toolName} ${JSON.stringify(input ?? "")} ${JSON.stringify(result ?? "")}`.toLowerCase();
  }
  const c = item.message.content as { text?: string } | undefined;
  return `${item.message.type} ${c?.text ?? JSON.stringify(item.message.content)}`.toLowerCase();
}

export function TranscriptView({ id, onBack }: { id: number; onBack: () => void }) {
  const [order, setOrder] = useState<Order>("oldest");
  const [query, setQuery] = useState("");

  const session = useQuery({ queryKey: ["session", id], queryFn: ({ signal }) => getSession(id, signal) });
  const info = useQuery({ queryKey: ["transcript-info", id], queryFn: ({ signal }) => getTranscriptInfo(id, signal) });
  const transcript = useQuery({ queryKey: ["transcript", id], queryFn: ({ signal }) => getTranscript(id, signal) });

  const items = useMemo(() => {
    if (!transcript.data) return [];
    // The registry sniffs the transcript shape and parses Claude/Codex/Copilot/VS Code into one model.
    return processMessages(parseTranscriptToMessages(transcript.data));
  }, [transcript.data]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? items.filter((item) => searchText(item).includes(q)) : items;
    return order === "newest" ? [...filtered].reverse() : filtered;
  }, [items, query, order]);

  const label = session.data
    ? `${compact(session.data.sessionId)} · ${session.data.userEmail ?? session.data.userAccountId ?? session.data.userId ?? "unknown"}`
    : `Session #${id}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button isIconOnly radius="full" variant="bordered" aria-label="Back" onPress={onBack}>
            <ArrowLeft size={18} />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-default-900">{label}</h2>
            <span className="text-sm text-default-500">
              {transcript.data
                ? `${items.length} messages${info.data ? ` · ${info.data.lineCount} lines` : ""}`
                : "Transcript"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            radius="full"
            className="w-56"
            placeholder="Search transcript"
            value={query}
            onValueChange={setQuery}
            startContent={<Search size={14} className="text-default-400" />}
            isClearable
            onClear={() => setQuery("")}
          />
          <Button
            size="sm"
            radius="full"
            variant="bordered"
            onPress={() => setOrder((o) => (o === "oldest" ? "newest" : "oldest"))}
          >
            {order === "oldest" ? "Oldest first" : "Newest first"}
          </Button>
        </div>
      </div>

      <Card shadow="sm">
        <CardBody>
          {transcript.isLoading ? (
            <Centered>Loading transcript…</Centered>
          ) : transcript.data == null ? (
            <Centered>No transcript stored for this session.</Centered>
          ) : visible.length === 0 ? (
            <Centered>{query ? "No messages match your search." : "Transcript is empty."}</Centered>
          ) : (
            <div className="flex flex-col gap-2">
              {visible.map((item) => (
                <TimelineItem key={item.id} item={item} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[220px] place-items-center text-default-500">{children}</div>;
}

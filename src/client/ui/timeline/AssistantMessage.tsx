import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { BaseMessage } from "../../timeline/types";
import { MessageCard, RowIcon } from "./MessageCard";
import { Markdown } from "./Markdown";

interface Props {
  msg: BaseMessage;
  isNew?: boolean;
}

export function AssistantMessage({ msg, isNew }: Props) {
  const c = msg.content as { text?: string; reasoning?: string } | undefined;
  const text = c?.text ?? "";
  const reasoning = c?.reasoning ?? "";
  const [showReasoning, setShowReasoning] = useState(false);

  return (
    <MessageCard
      isNew={isNew}
      timestamp={msg.timestamp}
      title={
        <>
          <RowIcon Icon={Sparkles} color="text-primary" bg="bg-primary/15" />
          <span className="text-2xs font-semibold uppercase tracking-wider text-primary shrink-0">
            assistant
          </span>
        </>
      }
      headerRight={
        reasoning ? (
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="text-2xs text-secondary hover:text-secondary/80 font-mono"
          >
            {showReasoning ? "hide" : "show"} reasoning
          </button>
        ) : null
      }
    >
      {showReasoning && reasoning && (
        <div className="mb-2 p-2 border-l-2 border-secondary/40 bg-default-100 rounded text-xs text-foreground/70 italic">
          <Markdown source={reasoning} />
        </div>
      )}
      {text ? (
        <Markdown source={text} />
      ) : (
        <span className="text-2xs text-foreground/40 italic">(empty)</span>
      )}
    </MessageCard>
  );
}

import { Card, CardBody, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from "@heroui/react";
import { FileText } from "lucide-react";
import type { SessionSummary } from "../../api";
import { formatCurrency, formatNumber, formatRelativeTime } from "../../format";
import { UserCell } from "../UserCell";
import { SourceBadges, TokenDiffBadge, CostDiffBadge } from "../sessions/SourceBadges";
import { compact } from "../utils/compact";

export function SessionsTable({
  sessions,
  onOpen,
  onViewTranscript
}: {
  sessions: SessionSummary[];
  onOpen: (id: number) => void;
  onViewTranscript: (id: number) => void;
}) {
  return (
    <Card shadow="sm">
      <CardBody className="gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">Recent sessions</h2>
          <span className="text-sm text-default-500">{sessions.length} shown · click to drill in</span>
        </div>
        <Table aria-label="Recent sessions" removeWrapper selectionMode="none" onRowAction={(key) => onOpen(Number(key))}>
          <TableHeader>
            <TableColumn>SESSION</TableColumn>
            <TableColumn>USER</TableColumn>
            <TableColumn>SOURCE</TableColumn>
            <TableColumn>MODEL</TableColumn>
            <TableColumn>TOKENS</TableColumn>
            <TableColumn>COST</TableColumn>
            <TableColumn>LAST SEEN</TableColumn>
            <TableColumn>TRANSCRIPT</TableColumn>
          </TableHeader>
          <TableBody emptyContent="No sessions yet" items={sessions}>
            {(session) => (
              <TableRow key={session.id} className="cursor-pointer transition-colors hover:bg-default-100">
                <TableCell>{compact(session.sessionId)}</TableCell>
                <TableCell>
                  <UserCell
                    id={{
                      user: session.userEmail ?? session.userAccountId ?? session.userId,
                      email: session.userEmail,
                      displayName: session.displayName,
                      githubLogin: session.githubLogin
                    }}
                  />
                </TableCell>
                <TableCell>
                  <SourceBadges hasOtel={session.hasOtel} hasJsonl={session.hasJsonl} metricSource={session.metricSource} source={session.source} />
                </TableCell>
                <TableCell>{session.models.join(", ") || "unknown"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span>{formatNumber(session.totalTokens)}</span>
                    <TokenDiffBadge otel={session.otelTotalTokens} jsonl={session.jsonlTotalTokens} />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span>{formatCurrency(session.totalCost)}</span>
                    <CostDiffBadge otel={session.otelTotalCost} jsonl={session.jsonlTotalCost} />
                  </div>
                </TableCell>
                <TableCell title={new Date(session.lastSeenAt).toLocaleString()}>{formatRelativeTime(session.lastSeenAt)}</TableCell>
                <TableCell>
                  {session.hasTranscript ? (
                    <button
                      type="button"
                      aria-label="View transcript"
                      title="View transcript"
                      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        onViewTranscript(session.id);
                      }}
                    >
                      <FileText size={14} /> View
                    </button>
                  ) : (
                    <span className="text-xs text-default-400">—</span>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}

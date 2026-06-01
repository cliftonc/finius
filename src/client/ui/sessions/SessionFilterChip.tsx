import { Chip } from "@heroui/react";
import { RefreshCcw } from "lucide-react";
import { userLabel } from "../UserCell";
import { useSessionQuery, useTranscriptInfoQuery } from "../queries/dashboardQueries";
import { SourceBadges } from "./SourceBadges";
import { compact } from "../utils/compact";

// Sessions are unbounded, so the active session drill-down is shown as a removable chip rather than a
// dropdown. Resolves the numeric id to a friendly "shortId · user" label via the session detail route.
export function SessionFilterChip({ id, onClear, onView }: { id: number; onClear: () => void; onView: () => void }) {
  const session = useSessionQuery(id);
  const transcript = useTranscriptInfoQuery(id);
  const data = session.data;
  const label = data
    ? `${compact(data.sessionId)} · ${userLabel({ user: data.userEmail ?? data.userAccountId ?? data.userId, email: data.userEmail, displayName: data.displayName, githubLogin: data.githubLogin })}`
    : `Session #${id}`;
  return (
    <div className="flex items-center gap-2 self-end">
      <Chip variant="flat" color="primary" startContent={<RefreshCcw size={14} className="ml-1" />} onClose={onClear}>
        {label}
      </Chip>
      {data && <SourceBadges hasOtel={data.hasOtel} hasJsonl={data.hasJsonl} metricSource={data.metricSource} source={data.source} />}
      {transcript.data && (
        <button type="button" onClick={onView} className="text-sm text-primary hover:underline">
          View transcript
        </button>
      )}
    </div>
  );
}

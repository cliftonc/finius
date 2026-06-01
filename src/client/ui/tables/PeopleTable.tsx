import { Card, CardBody, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from "@heroui/react";
import type { PersonSummary } from "../../api";
import { formatCurrency, formatNumber, formatRelativeTime } from "../../format";
import { UserCell } from "../UserCell";

export function PeopleTable({ people, onOpen }: { people: PersonSummary[]; onOpen: (user: string) => void }) {
  return (
    <Card shadow="sm">
      <CardBody className="gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">People</h2>
          <span className="text-sm text-default-500">{people.length} senders · click to drill in</span>
        </div>
        <Table aria-label="People" removeWrapper selectionMode="none" onRowAction={(key) => onOpen(String(key))}>
          <TableHeader>
            <TableColumn>SENDER</TableColumn>
            <TableColumn>SESSIONS</TableColumn>
            <TableColumn>MODELS</TableColumn>
            <TableColumn>TOKENS</TableColumn>
            <TableColumn>COST</TableColumn>
            <TableColumn>LAST SEEN</TableColumn>
          </TableHeader>
          <TableBody emptyContent="No senders yet" items={people}>
            {(person) => (
              <TableRow key={person.user} className="cursor-pointer transition-colors hover:bg-default-100">
                <TableCell>
                  <UserCell id={person} />
                </TableCell>
                <TableCell>{formatNumber(person.sessions)}</TableCell>
                <TableCell>{person.models.join(", ") || "unknown"}</TableCell>
                <TableCell>{formatNumber(person.totalTokens)}</TableCell>
                <TableCell>{formatCurrency(person.totalCost)}</TableCell>
                <TableCell title={new Date(person.lastSeenAt).toLocaleString()}>{formatRelativeTime(person.lastSeenAt)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}

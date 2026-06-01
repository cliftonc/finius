import { Card, CardBody, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from "@heroui/react";
import type { ModelSummary } from "../../api";
import { formatCurrency, formatNumber, formatRelativeTime } from "../../format";

export function ModelsTable({ models, onOpen }: { models: ModelSummary[]; onOpen: (model: string) => void }) {
  return (
    <Card shadow="sm">
      <CardBody className="gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">Models</h2>
          <span className="text-sm text-default-500">{models.length} models · click to drill in</span>
        </div>
        <Table aria-label="Models" removeWrapper selectionMode="none" onRowAction={(key) => onOpen(String(key))}>
          <TableHeader>
            <TableColumn>MODEL</TableColumn>
            <TableColumn>SESSIONS</TableColumn>
            <TableColumn>USERS</TableColumn>
            <TableColumn>TOKENS</TableColumn>
            <TableColumn>COST</TableColumn>
            <TableColumn>LAST SEEN</TableColumn>
          </TableHeader>
          <TableBody emptyContent="No models yet" items={models}>
            {(model) => (
              <TableRow key={model.model} className="cursor-pointer transition-colors hover:bg-default-100">
                <TableCell>{model.model}</TableCell>
                <TableCell>{formatNumber(model.sessions)}</TableCell>
                <TableCell>{formatNumber(model.users)}</TableCell>
                <TableCell>{formatNumber(model.totalTokens)}</TableCell>
                <TableCell>{formatCurrency(model.totalCost)}</TableCell>
                <TableCell title={new Date(model.lastSeenAt).toLocaleString()}>{formatRelativeTime(model.lastSeenAt)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}

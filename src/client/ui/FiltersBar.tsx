import { Button, ButtonGroup, Card, CardBody, Chip, Popover, PopoverContent, PopoverTrigger, RangeCalendar, Select, SelectItem } from "@heroui/react";
import { CalendarDate, type DateValue } from "@internationalized/date";
import { CalendarDays } from "lucide-react";
import { useState } from "react";
import type { FilterOptions } from "../api";
import { PRESET_RANGES, type CustomRange, type RangeKey } from "./state/dateRange";
import type { ViewState } from "./state/urlState";
import { SessionFilterChip } from "./sessions/SessionFilterChip";

const ALL = "__all__";

export function FiltersBar({ meta, range, custom, source, user, model, mine, session, onChange }: {
  meta?: FilterOptions;
  range: RangeKey;
  custom: CustomRange;
  source: string;
  user: string;
  model: string;
  mine: string;
  session: string;
  onChange: (patch: Partial<ViewState>) => void;
}) {
  return (
    <Card className="mb-3" shadow="sm">
      <CardBody className="flex flex-row flex-wrap items-end gap-4 p-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.7rem] font-extrabold uppercase tracking-wide text-default-500">Date range</span>
          <TimeRangePicker range={range} custom={custom} onChange={onChange} />
        </div>
        <Select label="Source" labelPlacement="outside" size="sm" className="max-w-[220px]" selectedKeys={[source || ALL]} onSelectionChange={(keys) => onChange({ source: pickKey(keys) })}>
          {[{ key: ALL, label: "All sources" }, ...(meta?.sources ?? []).map((value) => ({ key: value, label: value }))].map((item) => (
            <SelectItem key={item.key}>{item.label}</SelectItem>
          ))}
        </Select>
        <Select label="User" labelPlacement="outside" size="sm" className="max-w-[260px]" selectedKeys={[user || ALL]} onSelectionChange={(keys) => onChange({ user: pickKey(keys) })}>
          {[{ key: ALL, label: "All users" }, ...(meta?.users ?? []).map((value) => ({ key: value, label: value }))].map((item) => (
            <SelectItem key={item.key}>{item.label}</SelectItem>
          ))}
        </Select>
        <Select label="Model" labelPlacement="outside" size="sm" className="max-w-[240px]" selectedKeys={[model || ALL]} onSelectionChange={(keys) => onChange({ model: pickKey(keys) })}>
          {[{ key: ALL, label: "All models" }, ...(meta?.models ?? []).map((value) => ({ key: value, label: value }))].map((item) => (
            <SelectItem key={item.key}>{item.label}</SelectItem>
          ))}
        </Select>
        {mine === "1" ? (
          <Chip className="self-end" variant="flat" color="primary" onClose={() => onChange({ mine: "" })}>
            My sessions
          </Chip>
        ) : null}
        {session && <SessionFilterChip id={Number(session)} onClear={() => onChange({ session: "" })} onView={() => onChange({ transcript: session })} />}
      </CardBody>
    </Card>
  );
}

function formatRangeDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function toCalendarDate(ms: number): CalendarDate {
  const date = new Date(ms);
  return new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function dayStartMs(value: DateValue): number {
  return new Date(value.year, value.month - 1, value.day).getTime();
}

// Header time-range control: inline presets, a custom calendar popover, and the "X to date" dropdown.
// Each surfaces the active selection and writes back through `onChange` (the URL-backed state setter).
export function TimeRangePicker({
  range,
  custom,
  onChange
}: {
  range: RangeKey;
  custom: CustomRange;
  onChange: (patch: Partial<ViewState>) => void;
}) {
  const [open, setOpen] = useState(false);
  const isCustom = range === "custom" && custom.from !== undefined;
  // `custom.to` is an exclusive next-midnight bound; the calendar/label want the inclusive last day.
  const customEndMs = (custom.to ?? Date.now()) - 1;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ButtonGroup size="sm" radius="full" variant="bordered">
        {PRESET_RANGES.map((item) => {
          const active = range === item.key;
          return (
            <Button
              key={item.key}
              className="min-w-0 px-2.5"
              color={active ? "primary" : "default"}
              variant={active ? "solid" : "bordered"}
              onPress={() => onChange({ range: item.key })}
            >
              {item.label}
            </Button>
          );
        })}
      </ButtonGroup>

      <Popover isOpen={open} onOpenChange={setOpen} placement="bottom">
        <PopoverTrigger>
          {isCustom && custom.from !== undefined ? (
            <Button
              size="sm"
              radius="full"
              color="primary"
              variant="solid"
              startContent={<CalendarDays size={15} />}
            >
              {`${formatRangeDay(custom.from)} – ${formatRangeDay(customEndMs)}`}
            </Button>
          ) : (
            <Button isIconOnly size="sm" radius="full" variant="bordered" aria-label="Custom date range">
              <CalendarDays size={15} />
            </Button>
          )}
        </PopoverTrigger>
        <PopoverContent>
          <RangeCalendar
            aria-label="Custom date range"
            maxValue={toCalendarDate(Date.now())}
            value={isCustom && custom.from !== undefined ? { start: toCalendarDate(custom.from), end: toCalendarDate(customEndMs) } : null}
            onChange={(value) => {
              if (!value) return;
              const from = dayStartMs(value.start);
              // Store the exclusive upper bound at the midnight after the selected end day.
              const to = new Date(value.end.year, value.end.month - 1, value.end.day + 1).getTime();
              onChange({ range: "custom", customFrom: String(from), customTo: String(to) });
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function pickKey(keys: "all" | Set<React.Key>): string {
  if (keys === "all") return "";
  const value = Array.from(keys)[0] as string | undefined;
  return value && value !== ALL ? value : "";
}

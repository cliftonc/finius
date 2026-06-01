import { Modal, ModalBody, ModalContent, ModalHeader, Snippet, Tab, Tabs } from "@heroui/react";

export function SetupModal({ isOpen, onOpenChange, secure }: { isOpen: boolean; onOpenChange: () => void; secure?: boolean }) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          Send Claude Code telemetry here
          <span className="text-sm font-normal text-default-500">Point Claude Code at this server, then start a session — the dashboard updates live.</span>
        </ModalHeader>
        <ModalBody className="pb-6">
          <Tabs aria-label="Setup method" variant="underlined">
            <Tab key="cli" title="Quick setup">
              <div className="flex flex-col gap-3">
                <p className="text-sm text-default-600">
                  Run this once. It saves this server&apos;s URL, exports the OTLP env vars, and installs the upload hook{secure ? ", including the auth token for Secure Mode" : ""}.
                </p>
                <Snippet hideSymbol variant="bordered" className="w-full" classNames={{ pre: "whitespace-pre-wrap" }}>
                  {"npx @cliftonc/finius setup " + window.location.origin}
                </Snippet>
                <p className="text-sm text-default-500">
                  Then launch Claude Code as you normally would. Re-run any time to reconfigure, or <code className="px-1">finius doctor</code> if telemetry isn&apos;t arriving.
                </p>
              </div>
            </Tab>
            <Tab key="manual" title="Manual" isDisabled={secure ?? false}>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-default-600">
                  Prefer not to install anything? Export these in the shell where you launch Claude Code, then run <code className="px-1">claude</code>.
                </p>
                <Snippet hideSymbol variant="bordered" className="w-full" classNames={{ pre: "whitespace-pre-wrap" }}>
                  {manualScript().map((line, index) => (
                    <span key={index}>{line}</span>
                  ))}
                </Snippet>
              </div>
            </Tab>
          </Tabs>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function manualScript(): string[] {
  const origin = window.location.origin;
  return [
    "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
    "export OTEL_METRICS_EXPORTER=otlp",
    "export OTEL_LOGS_EXPORTER=otlp",
    "export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json",
    "export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json",
    `export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=${origin}/otlp/v1/metrics`,
    `export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${origin}/otlp/v1/logs`,
    "export OTEL_METRIC_EXPORT_INTERVAL=5000",
    "export OTEL_LOGS_EXPORT_INTERVAL=2000",
    "claude"
  ];
}

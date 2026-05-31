import { Button, Card, CardBody, Input } from "@heroui/react";
import { useCallback, useState } from "react";
import { login } from "../api";
import { FiniusLogo } from "./FiniusLogo";

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!password.trim()) return;
    setBusy(true);
    setError(false);
    const ok = await login(password);
    setBusy(false);
    if (ok) onSuccess();
    else setError(true);
  }, [password, onSuccess]);

  return (
    <main className="flex min-h-screen items-center justify-center p-7 text-foreground">
      <Card className="w-full max-w-sm" shadow="sm">
        <CardBody className="flex flex-col gap-5 p-7">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <FiniusLogo size={32} />
              <h1 className="text-3xl font-bold text-default-900">Finius</h1>
            </div>
            <span className="text-sm text-default-500">This server requires a password to continue.</span>
          </div>
          <Input
            autoFocus
            type="password"
            label="Server password"
            value={password}
            isInvalid={error}
            errorMessage={error ? "That password was rejected." : undefined}
            onValueChange={(value) => {
              setPassword(value);
              setError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <Button color="primary" isLoading={busy} onPress={() => void submit()}>
            Log in
          </Button>
        </CardBody>
      </Card>
    </main>
  );
}

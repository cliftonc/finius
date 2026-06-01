import { Button, Card, CardBody, Input } from "@heroui/react";
import { Github } from "lucide-react";
import { useCallback, useState } from "react";
import { login } from "../api";
import { FiniusLogo } from "./FiniusLogo";
import { useAuthProvidersQuery } from "./queries/dashboardQueries";

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const providers = useAuthProvidersQuery();
  const passwordEnabled = providers.data?.password?.enabled !== false;
  const githubEnabled = !!providers.data?.github.enabled;
  const requiredOrg = providers.data?.github.requiredOrg;
  const cliReturnTo = cliReturnToUrl();

  const submit = useCallback(async () => {
    if (!password.trim()) return;
    setBusy(true);
    setError(false);
    const token = await login(password);
    setBusy(false);
    if (token) {
      if (cliReturnTo) redirectToCli(cliReturnTo, token);
      else onSuccess();
    } else setError(true);
  }, [password, onSuccess, cliReturnTo]);

  return (
    <main className="flex min-h-screen items-center justify-center p-7 text-foreground">
      <Card className="w-full max-w-sm" shadow="sm">
        <CardBody className="flex flex-col gap-5 p-7">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <FiniusLogo size={32} />
              <h1 className="text-3xl font-bold text-default-900">Finius</h1>
            </div>
            <span className="text-sm text-default-500">
              {passwordEnabled && githubEnabled
                ? "Sign in with GitHub or the server password to continue."
                : githubEnabled
                  ? `Sign in with GitHub to continue${requiredOrg ? ` (${requiredOrg} members only)` : ""}.`
                  : "This server requires a password to continue."}
            </span>
          </div>
          {passwordEnabled ? (
            <>
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
            </>
          ) : null}
          {providers.data?.github.enabled && providers.data.github.loginUrl ? (
            <Button as="a" href={withReturnTo(providers.data.github.loginUrl, cliReturnTo)} variant="bordered" startContent={<Github size={18} />}>
              Sign in with GitHub
            </Button>
          ) : null}
        </CardBody>
      </Card>
    </main>
  );
}

function cliReturnToUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("cli_return_to");
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port ? url.toString() : null;
  } catch {
    return null;
  }
}

function withReturnTo(loginUrl: string, returnTo: string | null): string {
  if (!returnTo) return loginUrl;
  const url = new URL(loginUrl, window.location.origin);
  url.searchParams.set("return_to", returnTo);
  return `${url.pathname}${url.search}`;
}

function redirectToCli(returnTo: string, token: string) {
  const url = new URL(returnTo);
  url.searchParams.set("token", token);
  window.location.href = url.toString();
}

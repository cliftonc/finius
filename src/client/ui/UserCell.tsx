import { Avatar } from "@heroui/react";

// The identity fields any list row carries about a person. All optional so callers can pass whatever a
// given endpoint provides (People/sessions/breakdowns). `user` is the canonical identity string (the
// filter value) used as the last-resort label.
export type UserIdentity = {
  user?: string | null;
  email?: string | null;
  displayName?: string | null;
  githubLogin?: string | null;
};

// The label we show for a person: prefer a real name, then the GitHub handle, then email, then the
// raw identity string. Exported so non-avatar contexts (chips, titles) can reuse the same precedence.
export function userLabel(id: UserIdentity): string {
  return id.displayName || id.githubLogin || id.email || id.user || "unknown";
}

// GitHub serves a public avatar at github.com/<login>.png — no API/token needed. `size` requests a
// scaled image (2× the rendered px for retina). Null when we have no GitHub login to key off.
function githubAvatarUrl(login: string | null | undefined, px: number): string | undefined {
  return login ? `https://github.com/${login}.png?size=${px * 2}` : undefined;
}

// A person rendered as an avatar + name, GitHub-login-preferred. Used wherever a list shows a user
// (People, sessions, the Users breakdown). Falls back to initials when there's no GitHub avatar.
export function UserCell({ id, px = 24 }: { id: UserIdentity; px?: number }) {
  const label = userLabel(id);
  // A secondary line only when it adds information the primary label doesn't already show.
  const handle = id.githubLogin ? `@${id.githubLogin}` : null;
  const secondary = handle && handle !== label ? handle : id.email && id.email !== label ? id.email : null;

  return (
    <div className="flex items-center gap-2">
      <Avatar
        src={githubAvatarUrl(id.githubLogin, px)}
        name={label}
        showFallback
        radius="full"
        className="flex-none"
        style={{ width: px, height: px, fontSize: Math.round(px * 0.45) }}
      />
      <div className="flex flex-col leading-tight">
        <span>{label}</span>
        {secondary && <span className="text-tiny text-default-400">{secondary}</span>}
      </div>
    </div>
  );
}

// Just the avatar (no label) — for tight rows like the Users breakdown bars.
export function UserAvatar({ id, px = 18 }: { id: UserIdentity; px?: number }) {
  return (
    <Avatar
      src={githubAvatarUrl(id.githubLogin, px)}
      name={userLabel(id)}
      showFallback
      radius="full"
      className="flex-none"
      style={{ width: px, height: px, fontSize: Math.round(px * 0.45) }}
    />
  );
}

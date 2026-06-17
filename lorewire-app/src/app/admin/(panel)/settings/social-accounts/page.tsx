// Settings / Social accounts.
//
// Connect, reconnect, and disconnect the business-owned accounts Lorewire
// publishes shorts to. Phase 1 is YouTube only; the other three platforms show
// as "coming soon" so the operator knows they exist and what gates them. The
// Connect control is a plain anchor (not a Link) so the browser does a full
// navigation through the GET /api/social/oauth/youtube/start route, which
// redirects out to Google's consent screen. Plan sections 8, 9, 12.

import { requireAdmin } from "@/lib/dal";
import SettingsShell from "@/app/admin/SettingsShell";
import {
  getActiveSocialAccountSummary,
  type SocialAccountSummary,
} from "@/lib/social-accounts";
import { disconnectSocialAccount } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  config:
    "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then try again.",
  denied: "The connection was cancelled on Google's consent screen.",
  "bad-callback": "Google's response was missing required parameters. Try again.",
  state:
    "The connection request expired or could not be verified. Start the connect again.",
  "no-channel":
    "That Google account has no YouTube channel. Connect an account that owns one.",
  exchange: "Could not finish the handshake with Google. Try again.",
};

export default async function SocialAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const connected = typeof sp.connected === "string" ? sp.connected : null;
  const errorCode = typeof sp.error === "string" ? sp.error : null;

  const youtube = await getActiveSocialAccountSummary("youtube");

  return (
    <SettingsShell
      active="social"
      title="Social accounts"
      description="Connect the business-owned accounts Lorewire publishes shorts to. Phase 1 ships YouTube; the rest unlock as platform review clears."
    >
      <div className="space-y-4">
        {connected && (
          <Banner tone="ok">Connected to {connected}. You can publish to it now.</Banner>
        )}
        {errorCode && (
          <Banner tone="error">
            {ERROR_MESSAGES[errorCode] ??
              "Something went wrong connecting the account."}
          </Banner>
        )}

        <PlatformRow
          name="YouTube"
          blurb="Publishes a finished short straight to the channel as a YouTube Short."
          account={youtube}
          connectHref="/api/social/oauth/youtube/start"
          disconnectAction={disconnectSocialAccount}
        />

        <ComingSoonRow
          name="Instagram Reels"
          note="Unlocks once Meta App Review clears (Phase 2)."
        />
        <ComingSoonRow
          name="Facebook Reels"
          note="Unlocks once Meta App Review clears (Phase 2)."
        />
        <ComingSoonRow
          name="TikTok"
          note="Unlocks once the TikTok content-posting audit clears (Phase 3)."
        />
      </div>
    </SettingsShell>
  );
}

function PlatformRow({
  name,
  blurb,
  account,
  connectHref,
  disconnectAction,
}: {
  name: string;
  blurb: string;
  account: SocialAccountSummary | null;
  connectHref: string;
  disconnectAction: (formData: FormData) => Promise<void>;
}) {
  const isConnected = account?.status === "active";
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-[15px] font-bold text-ink">{name}</h2>
            <StatusChip connected={Boolean(isConnected)} />
          </div>
          <p className="mt-0.5 text-[13px] text-muted">{blurb}</p>
          {isConnected && account && (
            <p className="mt-2 truncate text-[12px] text-muted">
              <span className="text-ink">
                {account.display_name ?? account.external_id}
              </span>
              <span> · token refreshes automatically</span>
            </p>
          )}
        </div>

        <div className="shrink-0">
          {isConnected && account ? (
            <div className="flex items-center gap-2">
              <a
                href={connectHref}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-accent hover:text-ink"
              >
                Reconnect
              </a>
              <form action={disconnectAction}>
                <input type="hidden" name="id" value={account.id} />
                <button
                  type="submit"
                  className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10"
                >
                  Disconnect
                </button>
              </form>
            </div>
          ) : (
            <a
              href={connectHref}
              className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:bg-accent/20"
            >
              Connect
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function ComingSoonRow({ name, note }: { name: string; note: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface/50 p-4 opacity-70">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-[15px] font-bold text-ink">{name}</h2>
        <span className="rounded-full bg-surface2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
          Coming soon
        </span>
      </div>
      <p className="mt-0.5 text-[13px] text-muted">{note}</p>
    </div>
  );
}

function StatusChip({ connected }: { connected: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
        connected
          ? "bg-emerald-500/15 text-emerald-400"
          : "bg-surface2 text-muted"
      }`}
    >
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "ok" | "error";
  children: React.ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : "border-red-500/30 bg-red-500/10 text-red-300";
  return (
    <div className={`rounded-lg border px-3 py-2 text-[13px] ${cls}`}>
      {children}
    </div>
  );
}

import { Link } from "react-router-dom";
import { addressUrl, deployment } from "@plumbline/shared";
import { ApiError, STATIC, useSnapshot } from "../lib/api";
import { useLive } from "../lib/liveStore";
import { fmtInt } from "../lib/format";
import { Mark } from "./Brand";
import { ErrorNote } from "./ui";

/** True when a query failed because the thing does not exist (or is not in the snapshot). */
export function isMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * A page for something that is not there, saying why and where to go instead. In static mode the
 * usual reason is that it was created after the snapshot, so it may still exist on-chain.
 */
export function Missing({
  title,
  children,
  links,
}: {
  title: string;
  children?: React.ReactNode;
  links?: { to: string; label: string }[];
}) {
  const meta = useSnapshot();
  const live = useLive();
  const head = live.status !== "error" ? live.data.views?.head : undefined;
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-3 py-12">
      <Mark size={32} />
      <h1 className="font-display text-2xl font-extrabold tracking-display">{title}</h1>
      <div className="space-y-2 text-sm leading-6">
        {children}
        {STATIC && head !== undefined && (
          <p>
            Checked against the chain at block <span className="num">#{fmtInt(head)}</span>: there is nothing by this name. If it was just created,
            it can take a few seconds to appear; you can also look it up from the{" "}
            <a href={addressUrl(deployment.contracts.campaigns)} target="_blank" rel="noreferrer" className="link">
              campaigns contract
            </a>{" "}
            or the{" "}
            <a href={addressUrl(deployment.contracts.factory)} target="_blank" rel="noreferrer" className="link">
              vault factory
            </a>{" "}
            on the explorer.
          </p>
        )}
        {STATIC && head === undefined && (
          <p>
            The chain could not be read, so this only checked the snapshot, taken at block{" "}
            <span className="num">#{meta.data ? fmtInt(meta.data.block) : "…"}</span>. Anything created after it exists only on-chain: look it up from the{" "}
            <a href={addressUrl(deployment.contracts.campaigns)} target="_blank" rel="noreferrer" className="link">
              campaigns contract
            </a>{" "}
            or the{" "}
            <a href={addressUrl(deployment.contracts.factory)} target="_blank" rel="noreferrer" className="link">
              vault factory
            </a>{" "}
            on the explorer.
          </p>
        )}
      </div>
      {links && links.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {links.map((l) => (
            <Link key={l.to} to={l.to} className="link">
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Missing-or-error: a proper page for a 404, the raw error for anything else. */
export function LoadFailed({ error, missing }: { error: unknown; missing: React.ReactNode }) {
  return isMissing(error) ? <>{missing}</> : <ErrorNote error={error} />;
}

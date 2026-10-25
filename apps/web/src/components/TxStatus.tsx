import type { TxState } from "../lib/tx";
import { STATIC } from "../lib/api";
import { TxLink } from "./ui";

export function TxStatus({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  const tone = state.status === "error" ? "text-danger-text" : state.status === "done" ? "text-success-text" : "text-ink";
  return (
    <div className={`num mt-2 text-xs ${tone}`}>
      {state.status === "signing" && <>sign {state.label} in your wallet…</>}
      {state.status === "pending" && (
        <>
          {state.label} pending <TxLink hash={state.hash} />
        </>
      )}
      {state.status === "done" && (
        <>
          {state.label} confirmed on-chain <TxLink hash={state.hash} />
          {STATIC && (
            <span className="mt-1 block font-sans text-ink">
              This page shows a snapshot and will not update. Open the transaction on the explorer to see the result.
            </span>
          )}
        </>
      )}
      {state.status === "error" && (
        <>
          {state.label} failed: {state.message}
        </>
      )}
    </div>
  );
}

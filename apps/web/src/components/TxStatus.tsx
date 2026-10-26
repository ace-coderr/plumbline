import type { TxState } from "../lib/tx";
import { STATIC } from "../lib/api";
import { useLive } from "./../lib/liveStore";
import { TxLink } from "./ui";

export function TxStatus({ state }: { state: TxState }) {
  const live = useLive();
  if (state.status === "idle") return null;
  const reading = live.status !== "error" && live.data.views !== null;
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
              {reading
                ? "This page reads the chain live and should show the result within seconds."
                : "The chain cannot be read right now, so this page cannot show the result. Open the transaction on the explorer."}
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

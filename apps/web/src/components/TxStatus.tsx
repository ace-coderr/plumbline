import type { TxState } from "../lib/tx";
import { TxLink } from "./ui";

export function TxStatus({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  const tone = state.status === "error" ? "text-danger" : state.status === "done" ? "text-success" : "text-ink";
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
          {state.label} confirmed <TxLink hash={state.hash} />
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

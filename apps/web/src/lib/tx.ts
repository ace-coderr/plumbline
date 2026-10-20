import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { waitForTransactionReceipt } from "wagmi/actions";
import { BaseError, type Hash } from "viem";
import { wagmiConfig } from "./wagmi";

export type TxState =
  | { status: "idle" }
  | { status: "signing"; label: string }
  | { status: "pending"; label: string; hash: Hash }
  | { status: "done"; label: string; hash: Hash }
  | { status: "error"; label: string; message: string };

function message(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a sequence of wallet transactions (e.g. approve then act), waiting for each receipt, and
 * expose a single status line for the UI. Refreshes all queries once the last one lands.
 */
export function useTxRunner() {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const qc = useQueryClient();

  async function run(steps: { label: string; send: () => Promise<Hash> }[]): Promise<boolean> {
    for (const step of steps) {
      try {
        setState({ status: "signing", label: step.label });
        const hash = await step.send();
        setState({ status: "pending", label: step.label, hash });
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, pollingInterval: 250 });
        if (receipt.status !== "success") throw new Error(`${step.label} reverted`);
        setState({ status: "done", label: step.label, hash });
      } catch (err) {
        setState({ status: "error", label: step.label, message: message(err) });
        return false;
      }
    }
    // Live data picks the change up; a snapshot never will, so there is nothing to refetch.
    if (import.meta.env.VITE_DATA_MODE !== "static") await qc.invalidateQueries();
    return true;
  }

  return { state, run, busy: state.status === "signing" || state.status === "pending" };
}

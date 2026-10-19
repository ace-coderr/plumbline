import { Link } from "react-router-dom";
import { Mark } from "../components/Brand";

export function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <Mark size={36} />
      <p className="font-mono text-sm text-ink">Nothing hangs here.</p>
      <Link to="/" className="link text-xs">
        Back to markets
      </Link>
    </div>
  );
}

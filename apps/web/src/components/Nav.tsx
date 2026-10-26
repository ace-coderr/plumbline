import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { cx } from "./ui";

/**
 * The site map, in one place: the header, the mobile panel and the footer all read it, so a page cannot
 * be in one and missing from another. Routes are shared links; none is renamed here.
 */
export interface NavLeaf {
  to: string;
  label: string;
  /** Extra path prefixes that make this item the active one (a campaign page belongs to Campaigns). */
  also?: string[];
  end?: boolean;
}
export type NavItem = NavLeaf | { label: string; items: NavLeaf[] };

export const NAV: NavItem[] = [
  { to: "/", label: "Markets", end: true, also: ["/market"] },
  { to: "/campaigns", label: "Campaigns", also: ["/campaign"] },
  { to: "/scorecard", label: "Scorecard" },
  { to: "/verify", label: "Verify" },
  {
    label: "Try",
    items: [
      { to: "/try", label: "Guide" },
      { to: "/faucet", label: "Faucet" },
    ],
  },
  {
    label: "More",
    items: [
      { to: "/maker", label: "Makers" },
      { to: "/economics", label: "Economics" },
      { to: "/status", label: "Status" },
      { to: "/how-it-works", label: "How it works" },
    ],
  },
];

export const isGroup = (n: NavItem): n is { label: string; items: NavLeaf[] } => "items" in n;

/** Whether `path` is on this page or one of its children (/campaigns/new and /campaign/3 belong to Campaigns). */
export function leafActive(path: string, leaf: NavLeaf): boolean {
  if (leaf.end) {
    if (path === leaf.to) return true;
  } else if (path === leaf.to || path.startsWith(leaf.to + "/")) return true;
  return (leaf.also ?? []).some((p) => path === p || path.startsWith(p + "/"));
}
export const itemActive = (path: string, item: NavItem): boolean =>
  isGroup(item) ? item.items.some((l) => leafActive(path, l)) : leafActive(path, item);

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
const topClass = (active: boolean, open = false) =>
  cx(
    "inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border-2 px-3 text-sm font-semibold",
    focus,
    active ? "border-ink bg-violet text-on-violet" : open ? "border-ink bg-paper text-ink" : "border-transparent text-ink hover:border-ink",
  );

function Caret({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={cx("transition-transform", open && "rotate-180")}>
      <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** One dropdown: a button that opens a menu of links. Click, Enter, Space and ArrowDown open it. */
function Dropdown({
  item,
  active,
  open,
  setOpen,
}: {
  item: { label: string; items: NavLeaf[] };
  active: boolean;
  open: boolean;
  setOpen: (o: boolean) => void;
}) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [alignRight, setAlignRight] = useState(false);
  const { pathname } = useLocation();

  // Open toward the side that has room, so the menu is never cut off by the screen edge.
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = menu.current?.offsetWidth ?? 224;
    setAlignRight(r.left + w > window.innerWidth - 8);
  }, [open]);

  const links = () => Array.from(menu.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? []);
  const focusAt = (i: number) => {
    const l = links();
    l[(i + l.length) % l.length]?.focus();
  };
  // Focus the first item after the menu has rendered when it was opened from the keyboard.
  const [viaKey, setViaKey] = useState(false);
  useEffect(() => {
    if (open && viaKey) {
      focusAt(0);
      setViaKey(false);
    }
  });

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setViaKey(true);
      setOpen(true);
    } else if (e.key === "Escape") setOpen(false);
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const l = links();
    const i = l.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(l.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="relative" data-nav-dropdown>
      <button
        ref={btn}
        type="button"
        className={topClass(active, open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-current={active ? "true" : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={onButtonKey}
      >
        {item.label}
        <Caret open={open} />
      </button>
      {open && (
        <div
          ref={menu}
          id={`${id}-menu`}
          role="menu"
          aria-label={item.label}
          onKeyDown={onMenuKey}
          className={cx(
            "absolute top-full z-30 mt-1.5 min-w-[11rem] max-w-[calc(100vw-1rem)] rounded-[8px] border-2 border-ink bg-paper p-1 shadow-brut",
            alignRight ? "right-0" : "left-0",
          )}
        >
          {item.items.map((l) => {
            const on = leafActive(pathname, l);
            return (
              <Link
                key={l.to}
                to={l.to}
                role="menuitem"
                tabIndex={-1}
                aria-current={on ? "page" : undefined}
                className={cx(
                  "block whitespace-nowrap rounded-[6px] border-2 px-3 py-2 text-sm font-semibold text-ink",
                  focus,
                  on ? "border-ink bg-violet text-on-violet" : "border-transparent hover:border-ink",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The inline nav, from the lg breakpoint up. */
export function DesktopNav() {
  const { pathname } = useLocation();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);

  // Close on a route change and on a click or focus outside.
  useEffect(() => setOpenKey(null), [pathname]);
  useEffect(() => {
    const away = (e: Event) => {
      if (!(e.target instanceof Node) || !root.current?.contains(e.target)) setOpenKey(null);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("focusin", away);
    };
  }, []);

  return (
    <nav ref={root} aria-label="Main" className="hidden items-center gap-1 lg:flex">
      {NAV.map((n) =>
        isGroup(n) ? (
          <Dropdown key={n.label} item={n} active={itemActive(pathname, n)} open={openKey === n.label} setOpen={(o) => setOpenKey(o ? n.label : null)} />
        ) : (
          <Link key={n.to} to={n.to} className={topClass(leafActive(pathname, n))} aria-current={leafActive(pathname, n) ? "page" : undefined}>
            {n.label}
          </Link>
        ),
      )}
    </nav>
  );
}

/** The button and full-width panel for small screens. The panel is rendered by the header, below its bar. */
export function MobileMenuButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="mobile-menu"
      aria-label={open ? "Close menu" : "Open menu"}
      onClick={onToggle}
      className={cx(
        "press inline-flex h-9 w-10 shrink-0 items-center justify-center rounded-card border-2 border-ink bg-paper text-ink lg:hidden",
        focus,
      )}
    >
      <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
        {open ? <path d="M2 1l14 12M16 1L2 13" stroke="currentColor" strokeWidth="2" /> : <path d="M0 1h18M0 7h18M0 13h18" stroke="currentColor" strokeWidth="2" />}
      </svg>
    </button>
  );
}

export function MobilePanel({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const row = (l: NavLeaf) => {
    const on = leafActive(pathname, l);
    return (
      <Link
        key={l.to}
        to={l.to}
        aria-current={on ? "page" : undefined}
        className={cx(
          "flex min-h-12 items-center rounded-[8px] border-2 px-4 text-base font-semibold",
          focus,
          on ? "border-ink bg-violet text-on-violet" : "border-transparent text-ink hover:border-ink",
        )}
      >
        {l.label}
      </Link>
    );
  };
  return (
    <nav id="mobile-menu" aria-label="Main" className="no-print max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-t-2 border-ink bg-bg px-4 pb-4 pt-2 lg:hidden">
      <div className="mx-auto max-w-[1400px] space-y-3">
        <div className="grid gap-1">{NAV.filter((n): n is NavLeaf => !isGroup(n)).map(row)}</div>
        {NAV.filter(isGroup).map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h2 className="label px-4 pb-1 pt-2 text-muted">{g.label}</h2>
            <div className="grid gap-1">{g.items.map(row)}</div>
          </section>
        ))}
      </div>
    </nav>
  );
}

/** Every page, grouped as in the header. */
export function SiteFooterLinks() {
  const { pathname } = useLocation();
  const groups: { title: string; items: NavLeaf[] }[] = [
    { title: "Explore", items: NAV.filter((n): n is NavLeaf => !isGroup(n)) },
    ...NAV.filter(isGroup).map((g) => ({ title: g.label, items: g.items })),
  ];
  return (
    <nav aria-label="Site map" className="no-print mt-10 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-5 border-t-2 border-ink pt-4 sm:grid-cols-3">
      {groups.map((g) => (
        <div key={g.title}>
          <h2 className="label text-muted">{g.title}</h2>
          <ul className="mt-1.5 space-y-1">
            {g.items.map((l) => (
              <li key={l.to}>
                <Link to={l.to} aria-current={leafActive(pathname, l) ? "page" : undefined} className={cx("inline-block py-0.5 text-sm font-semibold text-ink underline decoration-2 underline-offset-2 hover:text-violet-text", focus)}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

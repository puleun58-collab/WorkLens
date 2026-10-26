"use client";

import { useState, type ComponentType } from "react";
import { Menu } from "lucide-react";
import { WorkLensLogo } from "@/app/worklens-logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetTrigger, SheetPopup, SheetHeader, SheetTitle, SheetDescription, SheetPanel } from "@/components/ui/sheet";

export interface WorkspaceNavigationItem {
  value: string;
  label: string;
  group: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  ariaLabel?: string;
  /** Starts downloading a lazy view before activation. */
  prefetch?: () => void;
  /** Kept in the item list (search, active-state lookup) but not rendered as a top-level row. */
  hiddenFromNav?: boolean;
}

type NavButtonItem = Pick<WorkspaceNavigationItem, "value" | "label" | "Icon" | "ariaLabel" | "prefetch">;

function NavButton({ item, active, onNavigate, onClose }: { item: NavButtonItem; active: string; onNavigate: (value: string) => void; onClose: () => void }) {
  return (
    <Button variant="ghost" className={`workspace-nav-item${active === item.value ? " active" : ""}`} aria-current={active === item.value ? "page" : undefined} aria-label={item.ariaLabel ?? item.label} onPointerEnter={item.prefetch} onFocus={item.prefetch} onClick={() => { onClose(); onNavigate(item.value); }}>
      <item.Icon size={18} strokeWidth={1.75} aria-hidden={true} /><span>{item.label}</span>
    </Button>
  );
}

export function WorkspaceNavigation({ items, active, onNavigate }: { items: WorkspaceNavigationItem[]; active: string; onNavigate: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const visibleItems = items.filter((item) => !item.hiddenFromNav);
  const content = <nav aria-label="작업 공간 메뉴" className="workspace-navigation">
    {[...new Set(visibleItems.map((item) => item.group))].map((group) => <section key={group}>
      {group !== "HELP" && <h2>{group}</h2>}
      <ul>{visibleItems.filter((item) => item.group === group).map((item) =>
        <li key={item.value}><NavButton item={item} active={active} onNavigate={onNavigate} onClose={() => setOpen(false)} /></li>
      )}</ul>
    </section>)}
  </nav>;
  return <>
    <aside className="workspace-sidebar"><div className="workspace-brand"><WorkLensLogo size={40} tone="dark" /></div>{content}</aside>
    <div className="workspace-mobile-bar"><Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="작업 공간 메뉴 열기" />}><Menu /></SheetTrigger>
      <SheetPopup side="left" className="workspace-mobile-sheet" closeProps={{ "aria-label": "메뉴 닫기" }}>
        <SheetHeader><WorkLensLogo size={40} tone="dark" /><SheetTitle className="sr-only">WorkLens</SheetTitle><SheetDescription className="sr-only">작업 공간 메뉴</SheetDescription></SheetHeader>
        <SheetPanel>{content}</SheetPanel>
      </SheetPopup>
    </Sheet><WorkLensLogo size={28} tone="dark" /></div>
  </>;
}

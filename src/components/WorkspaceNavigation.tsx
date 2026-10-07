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
}

export function WorkspaceNavigation({ items, active, onNavigate }: { items: WorkspaceNavigationItem[]; active: string; onNavigate: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const content = <nav aria-label="작업 공간 메뉴" className="workspace-navigation">
    {[...new Set(items.map((item) => item.group))].map((group) => <section key={group}>
      {group !== "HELP" && <h2>{group}</h2>}
      <ul>{items.filter((item) => item.group === group).map(({ value, label, Icon, ariaLabel, prefetch }) => <li key={value}>
        <Button variant="ghost" className={`workspace-nav-item${active === value ? " active" : ""}`} aria-current={active === value ? "page" : undefined} aria-label={ariaLabel ?? label} onPointerEnter={prefetch} onFocus={prefetch} onClick={() => { setOpen(false); onNavigate(value); }}>
          <Icon size={18} strokeWidth={1.75} aria-hidden={true} /><span>{label}</span>
        </Button>
      </li>)}</ul>
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

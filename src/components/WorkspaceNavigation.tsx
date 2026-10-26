"use client";

import { useState, type ComponentType } from "react";
import { ChevronDown, ChevronUp, Menu } from "lucide-react";
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
  /** Sub-menu entries rendered under this item when it is expanded. */
  children?: WorkspaceNavigationChildItem[];
  /** Kept in the item list (search, active-state lookup) but not rendered as a top-level row. */
  hiddenFromNav?: boolean;
}

export interface WorkspaceNavigationChildItem {
  value: string;
  label: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  ariaLabel?: string;
  prefetch?: () => void;
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const visibleItems = items.filter((item) => !item.hiddenFromNav);
  // 부모 진입 시 자동 펼침: 활성 부모가 바뀔 때만 적용하므로, 같은 화면에서
  // 직접 접은 상태는 유지되고 다른 화면에서 돌아오면 다시 펼쳐진다.
  // (props에서 파생된 상태라 렌더 단계에서 조정한다 — React 문서의 권장 패턴.)
  const activeParent = visibleItems.find((item) => item.children?.length && (item.value === active || item.children.some((child) => child.value === active)));
  const activeParentValue = activeParent?.value;
  const [prevActiveParent, setPrevActiveParent] = useState<string | undefined>(activeParentValue);
  if (prevActiveParent !== activeParentValue) {
    setPrevActiveParent(activeParentValue);
    if (activeParentValue) setExpanded((current) => current[activeParentValue] ? current : { ...current, [activeParentValue]: true });
  }
  const content = <nav aria-label="작업 공간 메뉴" className="workspace-navigation">
    {[...new Set(visibleItems.map((item) => item.group))].map((group) => <section key={group}>
      {group !== "HELP" && <h2>{group}</h2>}
      <ul>{visibleItems.filter((item) => item.group === group).map((item) => {
        const children = item.children ?? [];
        const isExpanded = expanded[item.value] ?? false;
        if (!children.length) {
          return <li key={item.value}><NavButton item={item} active={active} onNavigate={onNavigate} onClose={() => setOpen(false)} /></li>;
        }
        return <li key={item.value}>
          <div className="workspace-nav-parent-row">
            <NavButton item={item} active={active} onNavigate={onNavigate} onClose={() => setOpen(false)} />
            <Button variant="ghost" size="icon" className="workspace-nav-toggle" aria-label={`${item.label} 하위 메뉴 ${isExpanded ? "접기" : "펼치기"}`} aria-expanded={isExpanded} onClick={() => setExpanded((current) => ({ ...current, [item.value]: !current[item.value] }))}>
              {isExpanded ? <ChevronUp aria-hidden={true} /> : <ChevronDown aria-hidden={true} />}
            </Button>
          </div>
          <div className="workspace-nav-children" data-open={isExpanded || undefined}>
            <ul>{children.map((child) => <li key={child.value}><NavButton item={child} active={active} onNavigate={onNavigate} onClose={() => setOpen(false)} /></li>)}</ul>
          </div>
        </li>;
      })}</ul>
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

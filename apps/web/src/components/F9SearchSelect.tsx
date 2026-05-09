// apps/web/src/components/F9SearchSelect.tsx
// ════════════════════════════════════════════════════════════════════
// F9 Searchable Popup — v2 (updated UX per user request)
//
// UX (updated):
//   • BOTH desktop and mobile: clicking the input opens the modal.
//   • Desktop also supports F9 key as a keyboard shortcut.
//   • No more readonly / F9-only-on-desktop gating — this was
//     confusing for staff on touch laptops and kiosk setups.
// ════════════════════════════════════════════════════════════════════

import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  type KeyboardEvent,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronDown, Search, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface F9Option {
  value: string;
  label: string;
  sublabel?: string;
  searchText?: string;
}

function filterOptions(options: F9Option[], search: string): F9Option[] {
  const q = search.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    o =>
      o.label.toLowerCase().includes(q) ||
      (o.sublabel?.toLowerCase().includes(q) ?? false) ||
      (o.searchText?.toLowerCase().includes(q) ?? false)
  );
}

// ══════════════════════════════════════════════════════════════════
// SINGLE-SELECT
// ══════════════════════════════════════════════════════════════════
export interface F9SearchSelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  options: F9Option[];
  label?: string;
  placeholder?: string;
  allowAll?: boolean;
  allowClear?: boolean;
  allLabel?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  modalTitle?: string;
}

export function F9SearchSelect({
  value,
  onChange,
  options,
  label,
  placeholder,
  allowAll = false,
  allLabel = "All",
  disabled,
  className,
  inputClassName,
  modalTitle,
}: F9SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const allSentinel = "__ALL__";

  const displayOptions = useMemo(
    () => (allowAll ? [{ value: allSentinel, label: allLabel }, ...options] : options),
    [options, allowAll, allLabel]
  );

  const selected = useMemo(() => {
    if (allowAll && (value === null || value === allSentinel)) {
      return { value: allSentinel, label: allLabel };
    }
    return options.find(o => o.value === value) ?? null;
  }, [options, value, allowAll, allLabel]);

  const filtered = useMemo(() => filterOptions(displayOptions, search), [displayOptions, search]);

  useEffect(() => { setHighlighted(0); }, [search, open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const commit = useCallback(
    (opt: F9Option) => {
      onChange(opt.value === allSentinel ? null : opt.value);
      setOpen(false);
      setSearch("");
    },
    [onChange]
  );

  // Open on click (all devices) and on F9 (keyboard shortcut)
  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "F9") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const handleOpen = () => {
    if (!disabled) setOpen(true);
  };

  const handleModalKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted(h => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted(h => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[highlighted];
      if (opt) commit(opt);
    }
  };

  const resolvedPlaceholder = placeholder ?? "Click to select (or F9)";

  return (
    <div className={className}>
      {label && <label className="text-sm font-medium mb-1.5 block">{label}</label>}
      <div className="relative">
        <input
          type="text"
          readOnly
          tabIndex={disabled ? -1 : 0}
          value={selected?.label ?? ""}
          placeholder={resolvedPlaceholder}
          disabled={disabled}
          onClick={handleOpen}
          onKeyDown={handleInputKeyDown}
          className={cn(
            "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "pr-9 cursor-pointer",
            disabled && "cursor-not-allowed opacity-50",
            inputClassName
          )}
        />
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg p-0 gap-0" onKeyDown={handleModalKeyDown}>
          <DialogHeader className="p-4 pb-2 border-b">
            <DialogTitle>{modalTitle ?? label ?? "Select"}</DialogTitle>
          </DialogHeader>
          <div className="p-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder="Type to search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="max-h-[60vh] md:max-h-80 overflow-y-auto rounded border">
              {filtered.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No options found
                </div>
              ) : (
                filtered.map((o, i) => {
                  const isSelected = (selected?.value ?? null) === o.value;
                  const isHighlighted = i === highlighted;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className={cn(
                        "w-full flex items-center justify-between px-3 py-2 text-left text-sm border-b last:border-b-0",
                        "hover:bg-accent",
                        isHighlighted && "bg-accent",
                        isSelected && "font-semibold"
                      )}
                      onClick={() => commit(o)}
                      onMouseEnter={() => setHighlighted(i)}
                    >
                      <span className="flex flex-col">
                        <span>{o.label}</span>
                        {o.sublabel && (
                          <span className="text-xs text-muted-foreground">{o.sublabel}</span>
                        )}
                      </span>
                      {isSelected && <Check className="h-4 w-4 shrink-0 ml-2" />}
                    </button>
                  );
                })
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              <kbd className="px-1 border rounded">↑</kbd>{" "}
              <kbd className="px-1 border rounded">↓</kbd> navigate ·{" "}
              <kbd className="px-1 border rounded">Enter</kbd> select ·{" "}
              <kbd className="px-1 border rounded">Esc</kbd> close ·{" "}
              <kbd className="px-1 border rounded">F9</kbd> reopen
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MULTI-SELECT
// ══════════════════════════════════════════════════════════════════
export interface F9SearchMultiSelectProps {
  values: string[];
  onChange: (values: string[]) => void;
  options: F9Option[];
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  modalTitle?: string;
  maxChips?: number;
}

export function F9SearchMultiSelect({
  values,
  onChange,
  options,
  label,
  placeholder,
  disabled,
  className,
  inputClassName,
  modalTitle,
  maxChips = 3,
}: F9SearchMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(values));
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) setDraft(new Set(values)); }, [open, values]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => filterOptions(options, search), [options, search]);

  const toggle = (v: string) => {
    setDraft(d => {
      const next = new Set(d);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const apply = () => {
    onChange(Array.from(draft));
    setOpen(false);
    setSearch("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "F9") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const handleOpen = () => { if (!disabled) setOpen(true); };

  const selectedOptions = useMemo(
    () => options.filter(o => values.includes(o.value)),
    [options, values]
  );

  const resolvedPlaceholder = placeholder ?? "Click to select (or F9)";
  const displayedChips = selectedOptions.slice(0, maxChips);
  const overflow = selectedOptions.length - displayedChips.length;

  return (
    <div className={className}>
      {label && <label className="text-sm font-medium mb-1.5 block">{label}</label>}
      <div className="relative">
        <div
          tabIndex={disabled ? -1 : 0}
          role="combobox"
          aria-expanded={open}
          onClick={handleOpen}
          onKeyDown={handleKeyDown as any}
          className={cn(
            "min-h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "pr-9 cursor-pointer flex items-center flex-wrap gap-1",
            disabled && "cursor-not-allowed opacity-50",
            inputClassName
          )}
        >
          {selectedOptions.length === 0 ? (
            <span className="text-muted-foreground">{resolvedPlaceholder}</span>
          ) : (
            <>
              {displayedChips.map(o => (
                <span
                  key={o.value}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground text-xs"
                >
                  {o.label}
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      onChange(values.filter(v => v !== o.value));
                    }}
                    className="hover:bg-background rounded"
                    aria-label={`Remove ${o.label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {overflow > 0 && (
                <span className="text-xs text-muted-foreground">+{overflow} more</span>
              )}
            </>
          )}
        </div>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg p-0 gap-0">
          <DialogHeader className="p-4 pb-2 border-b">
            <DialogTitle>
              {modalTitle ?? label ?? "Select"}
              {draft.size > 0 && (
                <span className="text-xs font-normal text-muted-foreground ml-2">
                  ({draft.size} selected)
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="p-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder="Type to search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="max-h-[55vh] md:max-h-80 overflow-y-auto rounded border">
              {filtered.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No options found
                </div>
              ) : (
                filtered.map(o => {
                  const checked = draft.has(o.value);
                  return (
                    <label
                      key={o.value}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 text-sm border-b last:border-b-0 cursor-pointer hover:bg-accent",
                        checked && "bg-accent/40"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(o.value)}
                        className="h-4 w-4 rounded border-input"
                      />
                      <span className="flex flex-col flex-1">
                        <span>{o.label}</span>
                        {o.sublabel && (
                          <span className="text-xs text-muted-foreground">{o.sublabel}</span>
                        )}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <div className="flex justify-between items-center">
              <button
                type="button"
                onClick={() => setDraft(new Set())}
                className="text-xs text-muted-foreground hover:underline"
                disabled={draft.size === 0}
              >
                Clear all
              </button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={apply}>
                  Done ({draft.size})
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
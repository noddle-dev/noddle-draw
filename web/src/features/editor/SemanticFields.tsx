/**
 * features/editor/SemanticFields — the shared form pieces of the "quiet
 * semantic metadata" UI:
 *   • BoardSemanticsForm — board `metadata` (summary/category/domain/tags) +
 *     the ACTIVE page's `metadata` (summary/notes). Used by the title-island
 *     SemanticPopover and the inspector's nothing-selected card.
 *   • ObjectMetaEditor  — a node's / edge's `meta` (role/description/tech/
 *     owner/url or role/protocol/notes + custom key-value rows). Used by the
 *     Properties inspector and (compact) by the left DrawStylePanel.
 *
 * Every write goes through the real stores (pagesStore.setDiagramMetadata /
 * setPageMetadata, diagramStore.updateNode / updateEdge), so autosave, collab
 * and per-object undo pick it up like any other edit. Pure clean/merge rules
 * live in editor-core/diagram/semantics.ts. Styling: the `.sem-*` block in
 * styles/tokens.css (the form reflows on its own width — popover, inspector
 * and the narrow left panel share it).
 */
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  BOARD_CATEGORIES,
  EDGE_ROLE_PRESETS,
  MAX_META_KEYS,
  MAX_META_KEY_LEN,
  NODE_ROLE_PRESETS,
  isHttpUrl,
  metaValueText,
  parseMetaValue,
  renameMetaKey,
  roleTone,
  setMetaKey,
  splitList,
  titleCase,
} from "../../editor-core/diagram/semantics";
import type { MetaValue, ObjectMeta } from "../../editor-core/diagram";
import { usePagesStore } from "../../state/pagesStore";
import { RoleGlyph, SparkMark } from "../diagram/SemanticBadge";

/**
 * A text field with a LOCAL buffer while focused: every keystroke commits
 * (so a panel unmount never drops typing), but the box shows what you typed
 * rather than the cleaned/parsed store value — a comma list or a trailing
 * space would otherwise vanish mid-typing. Re-syncs from `value` when idle.
 */
export function BufferedField({
  value,
  onCommit,
  multiline = false,
  rows = 2,
  placeholder,
  readOnly = false,
  className = "text-input sem-input",
  ariaLabel,
  list,
  maxLength,
}: {
  value: string;
  onCommit: (raw: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
  list?: string;
  maxLength?: number;
}) {
  const [buf, setBuf] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setBuf(value);
  }, [value, focused]);
  const common = {
    className,
    value: focused ? buf : value,
    placeholder,
    readOnly,
    "aria-label": ariaLabel,
    maxLength,
    onFocus: () => {
      setBuf(value);
      setFocused(true);
    },
    onBlur: () => setFocused(false),
  };
  if (multiline) {
    return (
      <textarea
        {...common}
        rows={rows}
        onChange={(e) => {
          setBuf(e.target.value);
          if (!readOnly) onCommit(e.target.value);
        }}
      />
    );
  }
  return (
    <input
      {...common}
      list={list}
      onChange={(e) => {
        setBuf(e.target.value);
        if (!readOnly) onCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Small doodle "open link" arrow (inline SVG, currentColor). */
export function LinkGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2.5 h4 v4 M13.3 2.7 L7.5 8.5 M12 9.5 v3.2 a.8.8 0 0 1 -.8.8 H3.3 a.8.8 0 0 1 -.8 -.8 V4.8 a.8.8 0 0 1 .8 -.8 h3.2" />
    </svg>
  );
}

export function openSafeUrl(url: string): void {
  if (isHttpUrl(url)) window.open(url.trim(), "_blank", "noopener,noreferrer");
}

/** 16px line glyph (currentColor) for form chrome. */
function Glyph({ children, size = 13, sw = 1.45 }: { children: ReactNode; size?: number; sw?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const CHECK = <path d="M3.6 8.4 L6.6 11.3 L12.4 4.9" />;
const CROSS = <path d="M4.4 4.4 L11.6 11.6 M11.6 4.4 L4.4 11.6" />;

/** One glyph per built-in board category. */
const CATEGORY_GLYPH: Record<string, ReactNode> = {
  architecture: <path d="M8 2 L13.6 5 L8 8 L2.4 5 Z M2.4 8.1 L8 11.1 L13.6 8.1 M2.4 11.2 L8 14.2 L13.6 11.2" />,
  flowchart: (
    <>
      <rect x="2.2" y="2.4" width="5.4" height="4" rx="1.1" />
      <rect x="8.4" y="9.6" width="5.4" height="4" rx="1.1" />
      <path d="M4.9 6.4 V9.4 a2.2 2.2 0 0 0 2.2 2.2 H8.4" />
    </>
  ),
  data: (
    <>
      <ellipse cx="8" cy="4.2" rx="4.8" ry="1.9" />
      <path d="M3.2 4.2 V11.8 C3.2 12.9 5.3 13.7 8 13.7 S12.8 12.9 12.8 11.8 V4.2 M3.2 8 C3.2 9.1 5.3 9.9 8 9.9 S12.8 9.1 12.8 8" />
    </>
  ),
  org: (
    <>
      <rect x="5.8" y="2.2" width="4.4" height="3.2" rx="1" />
      <rect x="1.8" y="10.6" width="4.4" height="3.2" rx="1" />
      <rect x="9.8" y="10.6" width="4.4" height="3.2" rx="1" />
      <path d="M8 5.4 V8 M4 10.6 V8 H12 V10.6" />
    </>
  ),
  timeline: (
    <>
      <path d="M1.8 8 H14.2 M4.6 8 V4.6 M8 8 V11.4 M11.4 8 V4.6" />
      <circle cx="4.6" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="11.4" cy="8" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
};

/** A labelled row: label (+ quiet aside on the right) above the field. */
function Field({ label, children, hint, aside }: { label: string; children: ReactNode; hint?: string; aside?: ReactNode }) {
  return (
    <div className="sem-field">
      <div className="sem-label" title={hint}>
        <span>{label}</span>
        {aside != null && <span className="sem-aside">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

/** A field with a small leading mark inside the box. */
function Affix({ icon, tone, children }: { icon: ReactNode; tone?: string; children: ReactNode }) {
  return (
    <div className="sem-affix">
      <span className={`sem-affix-ic${tone ? ` toned t-${tone}` : ""}`} aria-hidden="true">{icon}</span>
      {children}
    </div>
  );
}

/** Titled group inside a form ("Board", "This page", …). */
function FormSection({ icon, title, note }: { icon: ReactNode; title: string; note?: string }) {
  return (
    <div className="sem-sec">
      <span className="sem-sec-ic" aria-hidden="true">{icon}</span>
      <span className="sem-sec-t">{title}</span>
      {note && <span className="sem-sec-d">{note}</span>}
    </div>
  );
}

/** Preset pills. The active one carries a check; picking it again clears it. */
function ChipRow({
  options,
  value,
  onPick,
  readOnly,
  label,
  glyph,
  small = false,
  raw = false,
}: {
  options: readonly string[];
  value: string;
  onPick: (v: string | undefined) => void;
  readOnly: boolean;
  label: string;
  /** Leading mark per option (shown while it isn't the active one). */
  glyph?: (option: string) => ReactNode;
  small?: boolean;
  /** Show the option as stored (role presets) instead of Title-cased. */
  raw?: boolean;
}) {
  const v = value.toLowerCase();
  const custom = value && !options.includes(v);
  const check = <span className="sem-chip-mark" aria-hidden="true"><Glyph size={11} sw={1.9}>{CHECK}</Glyph></span>;
  return (
    <div className={`sem-chips${small ? " sem-chips-sm" : ""}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = v === o;
        const mark = glyph?.(o);
        return (
          <button
            key={o}
            type="button"
            className={`sem-chip${on ? " active" : ""}`}
            aria-pressed={on}
            disabled={readOnly && !on}
            onClick={() => !readOnly && onPick(on ? undefined : o)}
          >
            {on ? check : mark != null && <span className="sem-chip-mark" aria-hidden="true">{mark}</span>}
            {raw ? o : titleCase(o)}
          </button>
        );
      })}
      {custom && <span className="sem-chip active">{check}{value}</span>}
      {value && !readOnly && (
        <button type="button" className="sem-chip sem-chip-clear" title={`Clear ${label.toLowerCase()}`} aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onPick(undefined)}>
          <Glyph size={10} sw={1.8}>{CROSS}</Glyph>
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Board + active page                                                       */
/* ------------------------------------------------------------------------ */

export function BoardSemanticsForm({ readOnly }: { readOnly: boolean }) {
  const meta = usePagesStore((s) => s.metadata);
  const activeId = usePagesStore((s) => s.activeId);
  const page = usePagesStore((s) => s.pages.find((p) => p.id === s.activeId));
  const pageCount = usePagesStore((s) => s.pages.length);
  const setBoard = usePagesStore((s) => s.setDiagramMetadata);
  const setPage = usePagesStore((s) => s.setPageMetadata);
  const pid = activeId ?? "p1";
  const empty = !meta && !page?.metadata;

  if (readOnly && empty) {
    return (
      <div className="sem-empty">
        <span className="sem-empty-ic" aria-hidden="true"><SparkMark size={15} /></span>
        <div>
          <b>No board summary yet</b>
          <span>An editor can describe what this board explains.</span>
        </div>
      </div>
    );
  }

  const summaryLen = (meta?.summary ?? "").length;
  const links = (meta?.links ?? []).filter((l) => isHttpUrl(l.url));
  return (
    <div className="sem-form">
      <FormSection
        icon={<Glyph><rect x="2.4" y="2.8" width="11.2" height="10.4" rx="2.2" /><path d="M5.2 6.2 H10.8 M5.2 9.2 H8.8" /></Glyph>}
        title="Board"
        note={pageCount > 1 ? "shared by every page" : undefined}
      />
      <Field label="Summary" aside={summaryLen > 0 ? `${summaryLen} / 1000` : undefined}>
        <BufferedField
          multiline
          rows={3}
          value={meta?.summary ?? ""}
          readOnly={readOnly}
          ariaLabel="Board summary"
          maxLength={1000}
          placeholder="1–2 sentences describing what this board explains…"
          onCommit={(raw) => setBoard({ summary: raw })}
        />
      </Field>
      <Field label="Category">
        <ChipRow
          label="Category"
          options={BOARD_CATEGORIES}
          value={meta?.category ?? ""}
          readOnly={readOnly}
          glyph={(o) => (CATEGORY_GLYPH[o] ? <Glyph size={12} sw={1.35}>{CATEGORY_GLYPH[o]}</Glyph> : null)}
          onPick={(v) => setBoard({ category: v })}
        />
      </Field>
      <div className="sem-split">
        <Field label="Domain">
          <Affix icon={<Glyph size={12}><circle cx="8" cy="8" r="5.6" /><path d="M2.4 8 H13.6 M8 2.4 C5.6 4.6 5.6 11.4 8 13.6 C10.4 11.4 10.4 4.6 8 2.4" /></Glyph>}>
            <BufferedField
              value={meta?.domain ?? ""}
              readOnly={readOnly}
              ariaLabel="Domain"
              maxLength={64}
              placeholder="payments, fraud, infra…"
              onCommit={(raw) => setBoard({ domain: raw })}
            />
          </Affix>
        </Field>
        <Field label="Tags" hint="Comma-separated" aside="comma-separated">
          <Affix icon={<Glyph size={12}><path d="M6.4 2.6 L5 13.4 M11 2.6 L9.6 13.4 M2.8 6 H13.6 M2.4 10 H13.2" /></Glyph>}>
            <BufferedField
              value={(meta?.tags ?? []).join(", ")}
              readOnly={readOnly}
              ariaLabel="Tags (comma-separated)"
              placeholder="kafka, pci, v2"
              onCommit={(raw) => setBoard({ tags: splitList(raw) })}
            />
          </Affix>
        </Field>
      </div>
      {links.length > 0 && (
        <Field label="Links">
          <div className="sem-links">
            {links.map((l) => (
              <button key={l.url} type="button" className="sem-chip sem-link" title={l.url} onClick={() => openSafeUrl(l.url)}>
                <LinkGlyph size={11} /> {l.label}
              </button>
            ))}
          </div>
        </Field>
      )}
      {(pageCount > 0 || !readOnly) && (
        <>
          <FormSection
            icon={<Glyph><path d="M4.4 2.4 H9.4 L12.4 5.4 V12.4 a1.2 1.2 0 0 1 -1.2 1.2 H4.4 a1.2 1.2 0 0 1 -1.2 -1.2 V3.6 a1.2 1.2 0 0 1 1.2 -1.2 Z M9.2 2.6 V5.6 H12.2" /></Glyph>}
            title={pageCount > 1 && page ? page.name : "This page"}
            note={pageCount > 1 && page ? "this page only" : undefined}
          />
          <Field label="Page summary">
            <BufferedField
              value={page?.metadata?.summary ?? ""}
              readOnly={readOnly}
              ariaLabel="Page summary"
              maxLength={1000}
              placeholder="What this page shows…"
              onCommit={(raw) => setPage(pid, { summary: raw })}
            />
          </Field>
          <Field label="Notes">
            <BufferedField
              multiline
              rows={2}
              value={page?.metadata?.notes ?? ""}
              readOnly={readOnly}
              ariaLabel="Page notes"
              maxLength={4000}
              placeholder="Assumptions, open questions, context…"
              onCommit={(raw) => setPage(pid, { notes: raw })}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Node / edge meta                                                          */
/* ------------------------------------------------------------------------ */

type DedicatedField = { key: string; label: string; placeholder: string; multiline?: boolean; url?: boolean };

/** The dedicated (non-custom) fields for an object, in display order. A node
 * that only carries `notes` edits it in the Description slot. */
function dedicatedFields(kind: "node" | "edge", meta: ObjectMeta | undefined, compact: boolean): DedicatedField[] {
  if (kind === "edge") {
    return [
      { key: "protocol", label: "Protocol", placeholder: "HTTPS, gRPC, Kafka…" },
      { key: "notes", label: "Notes", placeholder: "What flows here…", multiline: true },
    ];
  }
  const descKey = meta?.description == null && meta?.notes != null ? "notes" : "description";
  const all: DedicatedField[] = [
    { key: descKey, label: "Description", placeholder: "What this shape stands for…", multiline: true },
    { key: "tech", label: "Tech / stack", placeholder: "Postgres 16, Kafka, FastAPI…" },
    { key: "owner", label: "Owner", placeholder: "team or person" },
    { key: "url", label: "URL", placeholder: "https://…", url: true },
  ];
  return compact ? all.filter((f) => f.key !== "owner") : all;
}

export function ObjectMetaEditor({
  kind,
  meta,
  onChange,
  readOnly,
  compact = false,
  onMore,
}: {
  kind: "node" | "edge";
  meta: ObjectMeta | undefined;
  /** Receives the CLEANED next meta (`undefined` when empty). */
  onChange: (next: ObjectMeta | undefined) => void;
  readOnly: boolean;
  /** Left style panel variant: role + the core fields, no custom rows. */
  compact?: boolean;
  /** Compact only: open the full editor (right Properties panel). */
  onMore?: () => void;
}) {
  const listId = useId();
  const fields = dedicatedFields(kind, meta, compact);
  const dedicated = new Set(["role", ...fields.map((f) => f.key)]);
  const customKeys = Object.keys(meta ?? {}).filter((k) => !dedicated.has(k));
  const keyCount = Object.keys(meta ?? {}).length;
  const presets = kind === "node" ? NODE_ROLE_PRESETS : EDGE_ROLE_PRESETS;
  const role = metaValueText(meta?.role);
  const tone = roleTone(role);
  const set = (key: string, value: MetaValue | MetaValue[] | undefined) => {
    if (readOnly) return;
    // A brand-new key past the backend's 20-key bound would be stripped on save.
    if (!(key in (meta ?? {})) && keyCount >= MAX_META_KEYS) return;
    onChange(setMetaKey(meta, key, value));
  };
  const roleInput = (
    <BufferedField
      value={role}
      readOnly={readOnly}
      ariaLabel="Role"
      list={`${listId}-roles`}
      maxLength={64}
      placeholder={kind === "node" ? "service, database, step…" : "request, event…"}
      onCommit={(raw) => set("role", raw)}
    />
  );

  return (
    <div className={`sem-form${compact ? " compact" : ""}`}>
      <Field label="Role">
        {kind === "node" ? <Affix tone={tone} icon={<RoleGlyph tone={tone} />}>{roleInput}</Affix> : roleInput}
        <datalist id={`${listId}-roles`}>
          {presets.map((p) => <option key={p} value={p} />)}
        </datalist>
        {!compact && !readOnly && (
          <ChipRow
            small
            raw
            label="Role presets"
            options={presets}
            value={(presets as readonly string[]).includes(role) ? role : ""}
            readOnly={false}
            glyph={kind === "node" ? (p) => {
              const t = roleTone(p);
              return t === "plain" ? null : <span className={`sem-tone t-${t}`}><RoleGlyph tone={t} size={11} /></span>;
            } : undefined}
            onPick={(v) => set("role", v)}
          />
        )}
      </Field>
      {fields.map((f) => {
        const v = metaValueText(meta?.[f.key]);
        return (
          <Field key={f.key} label={f.label}>
            <div className={f.url ? "sem-url" : undefined}>
              <BufferedField
                multiline={f.multiline}
                rows={2}
                value={v}
                readOnly={readOnly}
                ariaLabel={f.label}
                maxLength={500}
                placeholder={f.placeholder}
                onCommit={(raw) => set(f.key, parseMetaValue(raw, meta?.[f.key]))}
              />
              {f.url && isHttpUrl(v) && (
                <button type="button" className="sem-open" title={`Open ${v}`} aria-label="Open link in a new tab" onClick={() => openSafeUrl(v)}>
                  <LinkGlyph />
                </button>
              )}
            </div>
            {f.url && v.trim() && !isHttpUrl(v) && <div className="sem-warn">Only http(s):// links open.</div>}
          </Field>
        );
      })}
      {compact ? (
        (customKeys.length > 0 || onMore) && (
          <button type="button" className="sem-more" onClick={onMore}>
            {customKeys.length > 0 ? `+${customKeys.length} more field${customKeys.length === 1 ? "" : "s"} · ` : ""}All semantics
            <Glyph size={11} sw={1.7}><path d="M3.4 8 H12.2 M8.8 4.6 L12.2 8 L8.8 11.4" /></Glyph>
          </button>
        )
      ) : (
        <CustomRows
          meta={meta}
          keys={customKeys}
          readOnly={readOnly}
          full={keyCount >= MAX_META_KEYS}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/** Custom `key: value` attributes as one bordered table + "+ Add attribute". */
function CustomRows({
  meta,
  keys,
  readOnly,
  full,
  onChange,
}: {
  meta: ObjectMeta | undefined;
  keys: string[];
  readOnly: boolean;
  full: boolean;
  onChange: (next: ObjectMeta | undefined) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const commitNew = () => {
    const k = newKey.trim().slice(0, MAX_META_KEY_LEN);
    if (!k || !newVal.trim() || (meta && k in meta) || full) return;
    onChange(setMetaKey(meta, k, newVal));
    setNewKey("");
    setNewVal("");
    setAdding(false);
  };
  const dup = !!newKey.trim() && !!meta && newKey.trim() in meta;
  const showAdd = !readOnly && adding;
  if (readOnly && keys.length === 0) return null;

  return (
    <div className="sem-custom">
      {(keys.length > 0 || showAdd) && (
        <div className="sem-label">
          <span>Custom attributes</span>
          <span className="sem-aside">{keys.length}{full ? " · limit reached" : ""}</span>
        </div>
      )}
      {(keys.length > 0 || showAdd) && (
        <div className="sem-kv-table">
          {keys.map((k) => (
            <div className="sem-kv" key={k}>
              <KeyInput value={k} readOnly={readOnly} onRename={(to) => onChange(renameMetaKey(meta, k, to))} />
              <BufferedField
                value={metaValueText(meta?.[k])}
                readOnly={readOnly}
                ariaLabel={`Value of ${k}`}
                maxLength={500}
                className="text-input sem-input sem-kv-val"
                onCommit={(raw) => onChange(setMetaKey(meta, k, parseMetaValue(raw, meta?.[k])))}
              />
              {!readOnly && (
                <button type="button" className="sem-x" title={`Remove ${k}`} aria-label={`Remove field ${k}`} onClick={() => onChange(setMetaKey(meta, k, undefined))}>
                  <Glyph size={11} sw={1.7}>{CROSS}</Glyph>
                </button>
              )}
            </div>
          ))}
          {showAdd && (
            <div className="sem-kv sem-kv-new">
              <input
                className="text-input sem-input sem-kv-key"
                placeholder="key"
                aria-label="New field key"
                maxLength={MAX_META_KEY_LEN}
                value={newKey}
                autoFocus
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setAdding(false);
                }}
              />
              <input
                className="text-input sem-input sem-kv-val"
                placeholder="value"
                aria-label="New field value"
                maxLength={500}
                value={newVal}
                onChange={(e) => setNewVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitNew();
                  else if (e.key === "Escape") setAdding(false);
                }}
              />
              <button type="button" className="sem-x sem-ok" title="Add attribute (Enter)" aria-label="Add field" disabled={!newKey.trim() || !newVal.trim() || dup} onClick={commitNew}>
                <Glyph size={12} sw={1.9}>{CHECK}</Glyph>
              </button>
            </div>
          )}
        </div>
      )}
      {dup && adding && <div className="sem-warn">That key already exists.</div>}
      {!readOnly && !adding && (
        <button type="button" className="sem-add" disabled={full} title={full ? "Up to 20 fields per object" : "Add a custom key: value"} onClick={() => setAdding(true)}>
          <Glyph size={11} sw={1.8}><path d="M8 3.4 V12.6 M3.4 8 H12.6" /></Glyph>
          Add attribute
        </button>
      )}
    </div>
  );
}

/** Key cell: renames on blur/Enter only (a per-keystroke rename would
 * collide with sibling keys mid-typing). */
function KeyInput({ value, readOnly, onRename }: { value: string; readOnly: boolean; onRename: (to: string) => void }) {
  const [buf, setBuf] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setBuf(value), [value]);
  return (
    <input
      className="text-input sem-input sem-kv-key"
      value={buf}
      readOnly={readOnly}
      aria-label={`Field key ${value}`}
      maxLength={MAX_META_KEY_LEN}
      onChange={(e) => setBuf(e.target.value)}
      onBlur={() => {
        const skip = cancelled.current;
        cancelled.current = false;
        if (!skip && buf.trim() && buf.trim() !== value) onRename(buf);
        else setBuf(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

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
 * live in editor-core/diagram/semantics.ts.
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
  setMetaKey,
  splitList,
  titleCase,
} from "../../editor-core/diagram/semantics";
import type { MetaValue, ObjectMeta } from "../../editor-core/diagram";
import { usePagesStore } from "../../state/pagesStore";

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

/** A small labelled row (label above the field). */
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="sem-field">
      <div className="sem-label" title={hint}>{label}</div>
      {children}
    </div>
  );
}

/** Pill chips with an optional "clear" (✕) chip. */
function ChipRow({
  options,
  value,
  onPick,
  readOnly,
  label,
}: {
  options: readonly string[];
  value: string;
  onPick: (v: string | undefined) => void;
  readOnly: boolean;
  label: string;
}) {
  const v = value.toLowerCase();
  const custom = value && !options.includes(v);
  return (
    <div className="sem-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={`sem-chip${v === o ? " active" : ""}`}
          aria-pressed={v === o}
          disabled={readOnly && v !== o}
          onClick={() => !readOnly && onPick(v === o ? undefined : o)}
        >
          {titleCase(o)}
        </button>
      ))}
      {custom && <span className="sem-chip active">{value}</span>}
      {value && !readOnly && (
        <button type="button" className="sem-chip sem-chip-clear" title={`Clear ${label.toLowerCase()}`} aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onPick(undefined)}>
          ✕
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
    return <div className="sem-empty">No board summary yet — an editor can add one.</div>;
  }

  return (
    <div className="sem-form">
      <Field label="Board summary">
        <BufferedField
          multiline
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
          onPick={(v) => setBoard({ category: v })}
        />
      </Field>
      <div className="sem-split">
        <Field label="Domain">
          <BufferedField
            value={meta?.domain ?? ""}
            readOnly={readOnly}
            ariaLabel="Domain"
            maxLength={64}
            placeholder="payments, fraud, infra…"
            onCommit={(raw) => setBoard({ domain: raw })}
          />
        </Field>
        <Field label="Tags" hint="Comma-separated">
          <BufferedField
            value={(meta?.tags ?? []).join(", ")}
            readOnly={readOnly}
            ariaLabel="Tags (comma-separated)"
            placeholder="kafka, pci, v2"
            onCommit={(raw) => setBoard({ tags: splitList(raw) })}
          />
        </Field>
      </div>
      {(meta?.links?.length ?? 0) > 0 && (
        <div className="sem-links">
          {meta!.links!.filter((l) => isHttpUrl(l.url)).map((l) => (
            <button key={l.url} type="button" className="sem-chip sem-link" title={l.url} onClick={() => openSafeUrl(l.url)}>
              <LinkGlyph size={11} /> {l.label}
            </button>
          ))}
        </div>
      )}
      {(pageCount > 0 || !readOnly) && (
        <>
          <div className="sem-divider">
            <span>{pageCount > 1 && page ? `Page · ${page.name}` : "This page"}</span>
          </div>
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
  const set = (key: string, value: MetaValue | MetaValue[] | undefined) => {
    if (readOnly) return;
    // A brand-new key past the backend's 20-key bound would be stripped on save.
    if (!(key in (meta ?? {})) && keyCount >= MAX_META_KEYS) return;
    onChange(setMetaKey(meta, key, value));
  };

  return (
    <div className={`sem-form${compact ? " compact" : ""}`}>
      <Field label="Role">
        <BufferedField
          value={role}
          readOnly={readOnly}
          ariaLabel="Role"
          list={`${listId}-roles`}
          maxLength={64}
          placeholder={kind === "node" ? "service, database, step…" : "request, event…"}
          onCommit={(raw) => set("role", raw)}
        />
        <datalist id={`${listId}-roles`}>
          {presets.map((p) => <option key={p} value={p} />)}
        </datalist>
        {!compact && !readOnly && (
          <div className="sem-chips sem-chips-sm" role="group" aria-label="Role presets">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                className={`sem-chip${role === p ? " active" : ""}`}
                aria-pressed={role === p}
                onClick={() => set("role", role === p ? undefined : p)}
              >
                {p}
              </button>
            ))}
          </div>
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
            {customKeys.length > 0 ? `+${customKeys.length} more field${customKeys.length === 1 ? "" : "s"} · ` : ""}All semantics →
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

/** Custom `key: value` rows + "+ Add field". */
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

  return (
    <div className="sem-custom">
      {keys.length > 0 && <div className="sem-label">Custom fields</div>}
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
              ×
            </button>
          )}
        </div>
      ))}
      {!readOnly && adding && (
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
          <button type="button" className="sem-x sem-ok" title="Add field" aria-label="Add field" disabled={!newKey.trim() || !newVal.trim() || dup} onClick={commitNew}>
            ✓
          </button>
        </div>
      )}
      {dup && adding && <div className="sem-warn">That key already exists.</div>}
      {!readOnly && !adding && (
        <button type="button" className="sem-add" disabled={full} title={full ? "Up to 20 fields per object" : "Add a custom key: value"} onClick={() => setAdding(true)}>
          + Add field
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

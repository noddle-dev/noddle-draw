"""Three-way diagram merge: only changed object fields are writes.

Concurrent changes to different fields/objects/pages survive. For the same
field the last arriving edit wins, matching live collaboration. Absence in an
old full-state payload is not deletion unless the object existed in its base.
"""
from __future__ import annotations

from copy import deepcopy

_MISSING = object()


def _fields(base: dict, desired: dict, current: dict) -> dict:
    result = deepcopy(current)
    for key in base.keys() | desired.keys():
        old, new = base.get(key, _MISSING), desired.get(key, _MISSING)
        if old == new:
            continue
        if new is _MISSING:
            result.pop(key, None)
        else:
            result[key] = deepcopy(new)
    return result


def _objects(base: list, desired: list, current: list, page: bool = False) -> list:
    before = {v['id']: v for v in base}
    wanted = {v['id']: v for v in desired}
    now = {v['id']: deepcopy(v) for v in current}
    for oid, original in before.items():
        if oid not in wanted:
            now.pop(oid, None)
    for oid, item in wanted.items():
        original = before.get(oid)
        if original == item:
            continue
        latest = now.get(oid)
        if original is not None and latest is None:
            # A stale drag/style edit must not resurrect a peer's deleted node.
            continue
        if page and latest is not None:
            original = original or {}
            merged = _fields(original, item, latest)
            for key in ('nodes', 'edges'):
                merged[key] = _objects(original.get(key, []), item.get(key, []), latest.get(key, []))
            now[oid] = merged
        else:
            now[oid] = _fields(original or {}, item, latest or {})
    return list(now.values())


# Diagram-ROOT keys that are not page content (a legacy ``{nodes,edges}``
# sidecar may carry them too — they must never be wrapped into "Page 1").
_ROOT_KEYS = ('metadata',)


def pages_of(diagram: dict | None) -> list[dict]:
    if not diagram:
        return []
    if 'pages' in diagram:
        return deepcopy(diagram['pages'])
    return [{'id': 'p1', 'name': 'Page 1',
             **{k: deepcopy(v) for k, v in diagram.items() if k not in _ROOT_KEYS}}]


def _root_metadata(diagram: dict | None) -> dict:
    meta = diagram.get('metadata') if isinstance(diagram, dict) else None
    return meta if isinstance(meta, dict) else {}


def merge_diagrams(base: dict | None, desired: dict | None, current: dict | None) -> dict | None:
    if desired is None:
        return None
    pages = _objects(pages_of(base), pages_of(desired), pages_of(current), page=True)
    for page in pages:
        ids = {n['id'] for n in page.get('nodes', [])}
        page['edges'] = [e for e in page.get('edges', []) if all(
            not isinstance(e.get(end), dict) or not e[end].get('nodeId') or e[end]['nodeId'] in ids
            for end in ('source', 'target')
        )]
    # Diagram-level metadata merges key-by-key, three-way, exactly like an
    # object's fields: a writer that never touched it keeps a peer's update.
    metadata = _fields(_root_metadata(base), _root_metadata(desired), _root_metadata(current))
    root = {'metadata': metadata} if metadata else {}
    if any(d and 'pages' in d for d in (base, desired, current)):
        return {**root, 'pages': pages}
    return {**root, **{k: v for k, v in (pages[0] if pages else {}).items() if k not in ('id', 'name')}}

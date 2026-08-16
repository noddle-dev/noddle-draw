"""Guards for contracts/ — spec vs. code.

Every test here compares a claim in the YAML against the thing that actually
enforces it (a route table, a Pydantic model, a constant, the TypeScript
entity model). No test asserts the spec against itself.

This file is the CANONICAL guard module. CI executes it through
backend/tests/test_contract_spec.py (the deploy workflow runs
`python -m pytest backend/tests -q`); it also runs standalone via
`python -m pytest tests/test_spec.py -q`.

Requires: pytest, PyYAML (jsonschema optional — that one test skips without it).
"""
from __future__ import annotations

import re
import sys
import typing
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
CONTRACTS = REPO / "contracts"

# Make the backend package importable no matter which entry point ran us.
if str(REPO / "backend") not in sys.path:
    sys.path.insert(0, str(REPO / "backend"))


def covers(ac_id: str) -> str:
    """Marker tying a test to an acceptance criterion (scanned by
    contract_audit.py and test_acceptance_criteria_are_covered)."""
    return ac_id


class StrictLoader(yaml.SafeLoader):
    """SafeLoader that refuses duplicate mapping keys.

    PyYAML silently keeps the last duplicate; pasting a matrix row twice would
    then delete the original with no error anywhere.
    """


def _no_duplicate_keys(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key {key!r} in mapping", key_node.start_mark
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicate_keys
)


def load(name):
    return yaml.load((CONTRACTS / name).read_text(encoding="utf-8"), Loader=StrictLoader)


@pytest.fixture(scope="session")
def spec():
    return load("business-spec.yaml")


@pytest.fixture(scope="session")
def architecture():
    return load("architecture.yaml")


@pytest.fixture(scope="session")
def contract():
    return load("openapi.yaml")


@pytest.fixture()
def app(tmp_path):
    from app.config import Settings
    from app.main import create_app

    return create_app(Settings(storage_dir=tmp_path))


SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'


# ---------------------------------------------------------------------------
# Bundle integrity
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["business-spec", "architecture"])
def test_spec_files_match_their_schema(name):
    jsonschema = pytest.importorskip("jsonschema")
    import json

    doc = load(f"{name}.yaml")
    schema = json.loads((CONTRACTS / "schemas" / f"{name}.schema.json").read_text())
    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.path))
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_artifacts_cross_reference_real_paths(spec, architecture):
    for doc in (spec, architecture):
        for ref in doc["meta"].get("related_artifacts", []):
            assert (CONTRACTS / ref).resolve().exists(), f"dangling related_artifact: {ref}"


def test_open_decisions_have_not_been_pre_empted(architecture):
    for adr in architecture["decisions"]:
        if adr["status"] == "decided":
            assert adr.get("date") and adr.get("rationale") and adr.get("choice"), (
                f"{adr['id']}: decided ADRs need date + rationale + choice"
            )
            continue
        if adr["status"] != "open":
            continue
        assert adr.get("resolution_criteria"), f"{adr['id']}: open with no resolution_criteria"
        assert adr.get("default_if_unresolved"), f"{adr['id']}: open with no default_if_unresolved"
        for target in adr.get("affects", []):
            assert not (REPO / target).exists(), (
                f"{adr['id']} is still open but {target} exists — decide first, code second"
            )


def test_blocked_by_points_at_a_real_blocker(architecture):
    ids = {b["id"] for b in architecture["blockers"]}
    for adr in architecture["decisions"]:
        ref = adr.get("blocked_by")
        if ref:
            assert ref in ids, f"{adr['id']}: blocked_by {ref} is not a declared blocker"


def test_ownership_points_at_real_files(architecture):
    for row in architecture["ownership"]:
        assert (REPO / row["file"]).exists(), f"ownership: {row['file']} does not exist"


def test_acceptance_criteria_are_covered(spec):
    """Bidirectional: every AC has a covers() marker, every marker names a real AC."""
    declared = {ac["id"] for ac in spec["acceptance_criteria"]}
    covered = set()
    for folder in (REPO / "tests", REPO / "backend" / "tests"):
        for path in folder.rglob("*.py"):
            covered |= set(
                re.findall(
                    r'covers\(\s*["\']?(AC-[A-Z0-9]+-\d+)["\']?\s*\)',
                    path.read_text(encoding="utf-8", errors="replace"),
                )
            )
    assert not declared - covered, f"acceptance criteria with no test: {sorted(declared - covered)}"
    assert not covered - declared, f"covers() naming unknown criteria: {sorted(covered - declared)}"


# ---------------------------------------------------------------------------
# HTTP surface — every contract operation is a real route, and vice versa
# ---------------------------------------------------------------------------

_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


def test_contract_paths_match_live_routes_both_ways(app, contract):
    from fastapi.routing import APIRoute

    live = {
        (r.path, m)
        for r in app.routes
        if isinstance(r, APIRoute) and r.path.startswith("/api/")
        for m in r.methods - {"HEAD", "OPTIONS"}
    }
    declared = {
        (path, method.upper())
        for path, ops in contract["paths"].items()
        for method in ops
        if method in _HTTP_METHODS
    }
    assert declared - live == set(), (
        f"in the contract but not routed: {sorted(declared - live)}"
    )
    assert live - declared == set(), (
        f"routed but missing from contracts/openapi.yaml: {sorted(live - declared)}"
    )


# covers(AC-LINK-02)
def test_no_listing_delete_or_policy_toggle_route(app):
    """Link access is not discovery: no board listing, no delete, and the only
    mutable metadata is the name."""
    from fastapi.routing import APIRoute

    from app.api.schemas import PatchDocBody

    live = {
        (r.path, m)
        for r in app.routes
        if isinstance(r, APIRoute)
        for m in r.methods
    }
    assert ("/api/documents", "GET") not in live, "a board-listing route appeared"
    assert ("/api/documents/{doc_id}", "DELETE") not in live, "a board-delete route appeared"
    assert set(PatchDocBody.model_fields) == {"name"}, (
        "PATCH grew beyond rename — a policy toggle needs a contract change first"
    )


# ---------------------------------------------------------------------------
# Permission model — the matrix in the spec IS services/auth.py
# ---------------------------------------------------------------------------


# covers(AC-LINK-01)
def test_link_policy_matrix_matches_auth_can(spec, contract):
    from app.domain.models import DocumentMeta
    from app.services.auth import can

    def meta_with(policy):
        return DocumentMeta(
            id="a" * 12, name="t", created_at=0.0, updated_at=0.0, link_policy=policy
        )

    matrix = {row["policy"]: set(row["grants"]) for row in spec["link_policy"]["matrix"]}
    assert set(matrix) == set(spec["link_policy"]["values"])
    for policy, grants in matrix.items():
        for action in ("view", "edit"):
            assert can(action, meta_with(policy)) == (action in grants), (
                f"can({action!r}, link_policy={policy!r}) disagrees with the spec matrix"
            )
    # An unknown/legacy value denies everything (the "anything else" clause).
    assert not can("view", meta_with("something-else"))
    # No orphan enum: the OpenAPI DocMeta.link_policy enum equals the spec values.
    api_enum = contract["components"]["schemas"]["DocMeta"]["properties"]["link_policy"]["enum"]
    assert set(api_enum) == set(spec["link_policy"]["values"])
    assert spec["link_policy"]["default_on_create"] == "edit"


# covers(AC-ID-01)
def test_document_ids_are_twelve_hex_and_validated(contract):
    from app.domain.ids import ID_RE, is_valid_id, new_id

    assert ID_RE.pattern == "^[0-9a-f]{12}$"
    minted = new_id()
    assert is_valid_id(minted) and len(minted) == 12
    assert not is_valid_id("../../etc/pwd")
    assert not is_valid_id("A" * 12)  # uppercase is not minted, so not valid
    api_pattern = contract["components"]["parameters"]["DocId"]["schema"]["pattern"]
    assert api_pattern == ID_RE.pattern


# ---------------------------------------------------------------------------
# Board lifecycle — sanitize-before-store, versions, restore
# ---------------------------------------------------------------------------


# covers(AC-SAN-01)
def test_svg_is_sanitized_before_storage(app):
    from fastapi.testclient import TestClient

    client = TestClient(app)
    dirty = (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<script>alert(1)</script><rect width="5" height="5" onclick="steal()"/></svg>'
    )
    doc_id = client.post("/api/documents/new", json={"name": "b", "svg": dirty}).json()["id"]
    stored = client.get(f"/api/documents/{doc_id}").json()["svg"]
    assert "<script" not in stored and "onclick" not in stored
    exported = client.get(f"/api/documents/{doc_id}/export.svg").text
    assert "<script" not in exported and "onclick" not in exported


# covers(AC-VER-01)
def test_version_coalescing_and_cap_match_the_spec(app):
    from fastapi.testclient import TestClient

    from app.services import documents as documents_service

    # The numbers the spec states in flows.save_and_versions.
    assert documents_service._VERSION_COALESCE_S == 60.0
    assert documents_service._MAX_VERSIONS == 50

    client = TestClient(app)
    doc_id = client.post("/api/documents/new", json={"name": "b", "svg": SVG}).json()["id"]
    # Two rapid saves by the same author coalesce into ONE snapshot …
    client.put(f"/api/documents/{doc_id}", json={"svg": SVG, "author_name": "alice"})
    client.put(f"/api/documents/{doc_id}", json={"svg": SVG, "author_name": "alice"})
    assert len(client.get(f"/api/documents/{doc_id}/versions").json()) == 1
    # … while a different author starts a new one even inside the window.
    client.put(f"/api/documents/{doc_id}", json={"svg": SVG, "author_name": "bob"})
    assert len(client.get(f"/api/documents/{doc_id}/versions").json()) == 2


# covers(AC-VER-02)
def test_restore_is_a_client_driven_save(app):
    from fastapi.testclient import TestClient

    client = TestClient(app)
    svg_v1 = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
    svg_v2 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>'
    doc_id = client.post("/api/documents/new", json={"name": "b", "svg": SVG}).json()["id"]
    client.put(f"/api/documents/{doc_id}", json={"svg": svg_v1, "author_name": "alice"})
    client.put(f"/api/documents/{doc_id}", json={"svg": svg_v2, "author_name": "bob"})
    versions = client.get(f"/api/documents/{doc_id}/versions").json()
    oldest = versions[-1]  # newest first — the alice snapshot is last
    snapshot = client.get(f"/api/documents/{doc_id}/versions/{oldest['id']}").json()
    # Restore = PUT the snapshot back as a NORMAL save (no restore endpoint).
    r = client.put(
        f"/api/documents/{doc_id}",
        json={"svg": snapshot["svg"], "diagram": snapshot["diagram"], "author_name": "carol"},
    )
    assert r.status_code == 200
    assert client.get(f"/api/documents/{doc_id}").json()["svg"] == snapshot["svg"]
    newest = client.get(f"/api/documents/{doc_id}/versions").json()[0]
    assert newest["author_name"] == "carol"  # the restore became the newest version


# ---------------------------------------------------------------------------
# Copy — messages exist once in the spec, and the code repeats them exactly
# ---------------------------------------------------------------------------


def test_error_copy_matches_code(spec):
    from app.api import ai as ai_api
    from app.api import comments as comments_api
    from app.api import documents as documents_api

    copy = spec["copy"]
    # The board-access strings are duplicated across two routers on purpose —
    # both must equal the single spec value.
    assert documents_api._NOT_FOUND == comments_api._NOT_FOUND == copy["not_found"]
    assert documents_api._NO_VIEW == comments_api._NO_VIEW == copy["view_denied"]
    assert documents_api._NO_EDIT == comments_api._NO_EDIT == copy["edit_view_only"]
    assert ai_api._NO_BACKEND == copy["ai_no_backend"]


# ---------------------------------------------------------------------------
# AI — mode enum, fallback chain, and the field round-trip guard
# ---------------------------------------------------------------------------


# covers(AC-AI-01)
def test_edit_mode_enum_matches_spec_contract_and_code(spec, contract):
    from app.api.ai_schemas import EditDiagramBody

    literal = set(typing.get_args(EditDiagramBody.model_fields["mode"].annotation))
    spec_enum = set(spec["enums"]["ai_edit_mode"])
    api_enum = set(
        contract["components"]["schemas"]["EditDiagramBody"]["properties"]["mode"]["enum"]
    )
    assert literal == spec_enum == api_enum, (
        f"mode enum drifted: code={sorted(literal)} spec={sorted(spec_enum)} "
        f"openapi={sorted(api_enum)}"
    )
    assert EditDiagramBody.model_fields["mode"].default == "edit"


# covers(AC-AI-01)
def test_ask_mode_never_returns_a_diagram(monkeypatch):
    """Consultant mode is context-only: nodes/edges are null in the envelope."""
    from app.services.ai import AIService

    service = AIService()
    monkeypatch.setattr(
        AIService,
        "_chat_json",
        lambda self, messages, max_tokens, settings=None, endpoint=None: (
            {"message": "an answer"},
            "raw",
        ),
    )
    monkeypatch.setattr(AIService, "last_call_usage", lambda self: None)
    out = service.edit_diagram({"nodes": [], "edges": []}, "is this right?", mode="ask")
    assert out["nodes"] is None and out["edges"] is None
    assert out["message"] == "an answer"


# covers(AC-AI-02)
def test_no_key_no_pool_ends_in_503_with_spec_copy(spec, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    for var in (
        "DATABRICKS_HOST",
        "DATABRICKS_TOKEN",
        "DATABRICKS_CONFIG_PROFILE",
        "OPENROUTER_POOL_KEY",
    ):
        monkeypatch.delenv(var, raising=False)
    bare = create_app(Settings(storage_dir=tmp_path))
    client = TestClient(bare)
    r = client.post(
        "/api/ai/edit-diagram",
        json={"instruction": "add a node", "diagram": {"nodes": [], "edges": []}},
    )
    assert r.status_code == 503
    assert r.json()["detail"] == spec["copy"]["ai_no_backend"]
    assert client.get("/api/config").json()["pool_ai"] is False


# ---- the field round-trip guard -------------------------------------------
# web/src/editor-core/diagram/types.ts is the authority on the diagram entity
# model (ADR-008). Parse its interfaces and assert (a) the OpenAPI mirror
# lists exactly the same fields, and (b) _normalize_full_diagram round-trips
# every optional field. When a new field lands in types.ts, BOTH sample maps
# below and the normalizer must learn it — this test fails until they do,
# which is exactly the bug (silently stripped fields) that shipped before.

TYPES_TS = REPO / "web" / "src" / "editor-core" / "diagram" / "types.ts"


def _interface_fields(name: str) -> dict[str, bool]:
    """{field_name: is_optional} parsed from `export interface <name> {...}`."""
    src = TYPES_TS.read_text(encoding="utf-8")
    m = re.search(rf"export interface {name} \{{(.*?)\n\}}", src, re.S)
    assert m, f"interface {name} not found in {TYPES_TS}"
    fields: dict[str, bool] = {}
    for fm in re.finditer(r"^\s{2}(\w+)(\??):", m.group(1), re.M):
        fields[fm.group(1)] = fm.group(2) == "?"
    assert fields, f"no fields parsed from interface {name}"
    return fields


def _node_kind_values() -> set[str]:
    src = TYPES_TS.read_text(encoding="utf-8")
    m = re.search(r"export type NodeKind =(.*?);", src, re.S)
    assert m, "NodeKind union not found"
    return set(re.findall(r'"([A-Za-z]+)"', m.group(1)))


# Sample values proving each OPTIONAL field survives normalization. A field
# missing here (i.e. newly added to types.ts) fails the guard with an
# actionable message.
NODE_FIELD_SAMPLES = {
    "rotation": 45,
    "anim": "pulse",
    "animSpeed": 2,
    "sketch": True,
    "fontSize": 18,
    "bold": True,
    "italic": True,
    "underline": True,
    "textColor": "#112233",
    "textAlign": "left",
    "wrap": True,
    "opacity": 0.5,
    "cornerRadius": 8,
    "strokeDash": "dashed",
    "iconKey": "aws-s3",
    "imageHref": "data:image/png;base64,AAAA",
    "groupId": "g1",
    "z": 7,
}
EDGE_FIELD_SAMPLES = {
    "endHead": "circle",
    "startHead": "diamond",
    "dash": "dotted",
    "label": "legacy label",
    "labels": [{"id": "l1", "t": 0.25, "text": "on the arrow"}],
    "flowStyle": "beam",
    "flowSpeed": 1.5,
    "flowIntensity": "strong",
    "waypoints": [{"x": 10, "y": 20}],
    "z": 3,
}


def test_openapi_mirrors_types_ts_fields(contract):
    schemas = contract["components"]["schemas"]
    for iface, schema_name in (("DiagramNode", "DiagramNode"), ("DiagramEdge", "DiagramEdge")):
        ts = _interface_fields(iface)
        api = schemas[schema_name]
        api_props = set(api["properties"])
        assert api_props == set(ts), (
            f"{schema_name}: openapi.yaml and types.ts disagree — "
            f"only in types.ts: {sorted(set(ts) - api_props)}, "
            f"only in openapi: {sorted(api_props - set(ts))}"
        )
        ts_required = {f for f, optional in ts.items() if not optional}
        assert set(api["required"]) == ts_required, (
            f"{schema_name}: required list drifted from types.ts"
        )
    assert set(schemas["NodeKind"]["enum"]) == _node_kind_values(), (
        "NodeKind enum drifted between openapi.yaml and types.ts"
    )


# covers(AC-AI-03)
def test_normalizer_round_trips_every_types_ts_field():
    from app.services.ai import AIService

    node_fields = _interface_fields("DiagramNode")
    edge_fields = _interface_fields("DiagramEdge")

    node = {
        "id": "n1", "kind": "cylinder", "x": 60, "y": 60, "w": 150, "h": 70,
        "text": "db", "fill": "#eef4ff", "stroke": "#2563eb", "strokeWidth": 2,
    }
    node2 = {**node, "id": "n2", "x": 300}
    edge = {
        "id": "e1",
        "source": {"kind": "port", "nodeId": "n1", "rel": {"x": 1, "y": 0.5}},
        "target": {"kind": "floating", "nodeId": "n2"},
        "routing": "elbow", "stroke": "#475569", "strokeWidth": 2,
        "endArrow": True, "startArrow": False, "animated": True,
    }
    for field, optional in node_fields.items():
        if not optional:
            continue
        assert field in NODE_FIELD_SAMPLES, (
            f"types.ts grew DiagramNode.{field} — teach NODE_FIELD_SAMPLES, "
            f"_normalize_full_diagram (backend/app/services/ai.py) AND "
            f"contracts/openapi.yaml"
        )
        node[field] = NODE_FIELD_SAMPLES[field]
    for field, optional in edge_fields.items():
        if not optional:
            continue
        assert field in EDGE_FIELD_SAMPLES, (
            f"types.ts grew DiagramEdge.{field} — teach EDGE_FIELD_SAMPLES, "
            f"_normalize_full_diagram (backend/app/services/ai.py) AND "
            f"contracts/openapi.yaml"
        )
        edge[field] = EDGE_FIELD_SAMPLES[field]

    nodes, edges = AIService._normalize_full_diagram(
        {"nodes": [node, node2], "edges": [edge]}
    )
    out_node, out_edge = nodes[0], edges[0]

    for field, optional in node_fields.items():
        if optional:
            assert field in out_node, (
                f"_normalize_full_diagram STRIPPED DiagramNode.{field} — every "
                f"AI edit would silently destroy it (this exact bug shipped "
                f"for labels/z before)"
            )
    for field, optional in edge_fields.items():
        if optional:
            assert field in out_edge, (
                f"_normalize_full_diagram STRIPPED DiagramEdge.{field} — every "
                f"AI edit would silently destroy it"
            )
    # Spot-check values, not just presence.
    assert out_edge["labels"][0]["text"] == "on the arrow"
    assert out_edge["flowSpeed"] == 1.5
    assert out_node["z"] == 7 and out_edge["z"] == 3
    assert out_edge["source"]["kind"] == "port"


# ---------------------------------------------------------------------------
# Collaboration — full-state LWW, clientId eviction
# ---------------------------------------------------------------------------


def _next_frame(ws, frame_type):
    """Drain frames (presence/bye/cursor interleave freely) until `frame_type`."""
    for _ in range(20):
        frame = ws.receive_json()
        if frame["t"] == frame_type:
            return frame
    raise AssertionError(f"no {frame_type!r} frame arrived")


# covers(AC-COLLAB-01)
def test_collab_room_is_full_state_lww_and_evicts_duplicate_client_ids(app):
    from fastapi.testclient import TestClient

    from app.api import collab

    client = TestClient(app)
    doc_id = client.post("/api/documents/new", json={"name": "b", "svg": SVG}).json()["id"]
    ws_url = f"/ws/documents/{doc_id}"
    state_1 = {"nodes": [{"id": "n1"}], "edges": []}
    state_2 = {"nodes": [{"id": "n2"}], "edges": []}

    with client.websocket_connect(ws_url) as a, client.websocket_connect(ws_url) as o:
        a.send_json({"t": "hello", "name": "A", "color": "#111111", "clientId": "ca"})
        assert _next_frame(a, "init")["t"] == "init"
        o.send_json({"t": "hello", "name": "O", "color": "#333333", "clientId": "co"})
        assert _next_frame(o, "init")["t"] == "init"
        a.send_json({"t": "state", "diagram": state_1})
        a.send_json({"t": "state", "diagram": state_2})  # the LAST write wins
        # The observer sees both broadcasts; after the second, the room's
        # authoritative state is state_2 (assigned before the broadcast).
        assert _next_frame(o, "state")["diagram"] == state_1
        assert _next_frame(o, "state")["diagram"] == state_2
        # A late joiner inits with the newest FULL state — no merge, no ops.
        with client.websocket_connect(ws_url) as b:
            b.send_json({"t": "hello", "name": "B", "color": "#222222", "clientId": "cb"})
            init = _next_frame(b, "init")
            assert init["diagram"] == state_2
            # A reconnect with B's clientId evicts the old socket (one browser
            # = one presence entry).
            with client.websocket_connect(ws_url) as b2:
                b2.send_json(
                    {"t": "hello", "name": "B", "color": "#222222", "clientId": "cb"}
                )
                assert _next_frame(b2, "init")["t"] == "init"
                room = collab.manager.peek(doc_id)
                assert room is not None
                cids = [u.get("client_id") for u in room.users.values()]
                assert cids.count("cb") == 1, "duplicate clientId was not evicted"


# ---------------------------------------------------------------------------
# Framing — only /embed/{id} may be iframed (ADR-006)
# ---------------------------------------------------------------------------


def test_only_embed_routes_are_frameable(app):
    from fastapi.testclient import TestClient

    client = TestClient(app)
    embed = client.get("/embed/abcdefabcdef")
    assert embed.headers.get("content-security-policy") == "frame-ancestors *"
    root = client.get("/")
    if "text/html" in root.headers.get("content-type", ""):
        assert root.headers.get("content-security-policy") == "frame-ancestors 'self'"
        assert root.headers.get("x-frame-options") == "SAMEORIGIN"

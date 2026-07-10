"""Sanitizer regressions: xlink tolerance + the core strip guarantees."""
from __future__ import annotations

import pytest

from app.security.svg_sanitizer import sanitize_svg


def test_unbound_xlink_prefix_is_tolerated():
    # Client-serialized boards embed uploaded fragments that use xlink:href;
    # older wrappers didn't declare the namespace — must not reject the save.
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<image xlink:href="data:image/png;base64,AAAA" width="10" height="10"/></svg>'
    )
    out = sanitize_svg(svg)
    assert "data:image/png" in out


def test_declared_xlink_still_works():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">'
        '<image xlink:href="data:image/png;base64,AAAA"/></svg>'
    )
    assert "data:image/png" in sanitize_svg(svg)


def test_external_href_is_stripped_scripts_rejected():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
        '<image xlink:href="https://evil.example/x.png"/>'
        "<script>alert(1)</script><rect width=\"5\" height=\"5\"/></svg>"
    )
    out = sanitize_svg(svg)
    assert "evil.example" not in out and "script" not in out and "rect" in out


def test_garbage_still_rejected():
    with pytest.raises(ValueError):
        sanitize_svg("this is not svg")


def test_entity_expansion_bomb_is_rejected():
    # A "billion laughs" DOCTYPE must be refused at parse time (defusedxml),
    # never expanded — otherwise an upload can exhaust memory.
    bomb = (
        '<?xml version="1.0"?>'
        '<!DOCTYPE svg [<!ENTITY a "AAAAAAAAAA">'
        '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
        '<svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>'
    )
    with pytest.raises(ValueError):
        sanitize_svg(bomb)

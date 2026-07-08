"""noddle backend — modular FastAPI package.

Layers (dependency rule: api → services → domain; infrastructure implements
the domain port; domain imports nothing outward):

    api             inbound HTTP adapter (routers + Pydantic DTOs)
    services        application use-cases (orchestration)
    domain          pure core (dataclasses, ids, repository port)
    infrastructure  outbound adapter (file-backed repository)
    security        SVG sanitizer
"""

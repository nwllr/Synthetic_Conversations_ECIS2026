#!/usr/bin/env python3
"""Compute UMAP layout using umap-learn.

This script expects a JSON payload via stdin with the following keys:
    vectors: list[list[float]]
    n_neighbors: int (optional)
    min_dist: float (optional)
    metric: str (optional, defaults to 'cosine')

It writes a JSON object to stdout with:
    coords: list[list[float]]

Errors are written to stderr with a JSON payload so the caller can surface
meaningful error messages in the UI.
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from dataclasses import dataclass
from typing import List, Sequence, NoReturn


@dataclass
class Payload:
    vectors: List[List[float]]
    n_neighbors: int = 10
    min_dist: float = 0.1
    metric: str = "cosine"


def _fail(message: str, *, code: str = "umap_error") -> "NoReturn":
    error = {"error": message, "code": code}
    sys.stderr.write(json.dumps(error) + "\n")
    sys.exit(1)


def _parse_payload() -> Payload:
    try:
        raw = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        _fail(f"Failed to decode JSON payload: {exc}", code="invalid_json")

    vectors = raw.get("vectors")
    if not isinstance(vectors, list) or not vectors:
        _fail("'vectors' must be a non-empty list", code="missing_vectors")

    normalized: List[List[float]] = []
    for index, row in enumerate(vectors):
        if not isinstance(row, Sequence):
            _fail(f"Vector at index {index} is not a sequence", code="invalid_vector")
        try:
            normalized.append([float(value) for value in row])
        except (TypeError, ValueError):
            _fail(f"Vector at index {index} contains non-numeric values", code="invalid_value")

    n_neighbors = int(raw.get("n_neighbors", 10))
    min_dist = float(raw.get("min_dist", 0.1))
    metric = raw.get("metric", "cosine")
    if not isinstance(metric, str):
        _fail("'metric' must be a string", code="invalid_metric")

    return Payload(normalized, n_neighbors, min_dist, metric)


def main() -> None:
    try:
        import numpy as np
    except Exception as exc:  # pragma: no cover - import guard
        _fail(f"Failed to import numpy: {exc}", code="missing_numpy")

    try:
        import umap  # type: ignore
    except Exception as exc:  # pragma: no cover - import guard
        _fail(f"Failed to import umap-learn: {exc}", code="missing_umap")

    payload = _parse_payload()

    # Reduce threading noise on systems with older TBB/OMP stacks.
    os.environ.setdefault("OMP_NUM_THREADS", "1")

    # UMAP can emit numerous warnings that clutter stderr but are non-fatal; suppress the noisy ones.
    warnings.filterwarnings("ignore", message="n_neighbors is larger than the dataset size", module="umap")
    warnings.filterwarnings("ignore", message=".*disconnected.*", module="umap")
    warnings.filterwarnings("ignore", message="n_jobs value 1 overridden", module="umap")
    try:  # pragma: no cover - optional dependency
        from numba.core.errors import NumbaWarning

        warnings.filterwarnings("ignore", category=NumbaWarning)
    except Exception:
        pass

    if len(payload.vectors) == 1:
        coords = [[0.0 for _ in range(2)]]
        json.dump({"coords": coords}, sys.stdout)
        return

    matrix = np.asarray(payload.vectors, dtype=float)

    reducer = umap.UMAP(
        n_neighbors=max(2, payload.n_neighbors),
        min_dist=max(1e-4, payload.min_dist),
        metric=payload.metric,
        n_components=2,
        random_state=42,
    )

    try:
        embedding = reducer.fit_transform(matrix)
    except Exception as exc:
        # Fall back to a lightweight PCA projection to keep the UI functional.
        try:
            coords = _fallback_pca(matrix)
        except Exception as pca_exc:  # pragma: no cover - best effort fallback
            _fail(f"UMAP failed: {exc}; PCA fallback also failed: {pca_exc}", code="umap_failure")
        else:
            json.dump({"coords": coords, "fallback": "pca"}, sys.stdout)
            return

    coords = embedding.tolist()
    json.dump({"coords": coords}, sys.stdout)


if __name__ == "__main__":  # pragma: no cover - script entry point
    main()


def _fallback_pca(matrix):
    import numpy as np  # local import to avoid global dependency when unused

    if matrix.ndim != 2:
        raise ValueError("matrix must be 2D")

    if matrix.shape[0] <= 1:
        return np.zeros((matrix.shape[0], 2)).tolist()

    centered = matrix - matrix.mean(axis=0, keepdims=True)
    u, s, vh = np.linalg.svd(centered, full_matrices=False)
    components = vh[:2]
    projected = centered @ components.T
    # If there is only one component, pad with zeros.
    if projected.shape[1] == 1:
        projected = np.hstack([projected, np.zeros((projected.shape[0], 1))])
    return projected.tolist()

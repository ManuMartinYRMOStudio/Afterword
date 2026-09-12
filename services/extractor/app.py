"""FastAPI application boundary interface."""

from fastapi import FastAPI

from .pipeline import run_extraction as run_extraction


def create_app() -> FastAPI:
    """Create the extractor HTTP application in the later API wave."""

    raise NotImplementedError("FastAPI endpoint implementation belongs to a later wave")

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class PhotoIn(BaseModel):
    """One photo. Either a public URL or a base64 data URL. `kind` is the guided-shot label."""
    url: str
    kind: Literal["front", "back", "underside", "marks", "detail", "damage", "other"] = "other"


class AppraiseRequest(BaseModel):
    photos: list[PhotoIn] = Field(min_length=1)
    description: str = ""          # dealer's brief description
    markings: str = ""             # dealer-transcribed writing / stamps / labels
    item_id: str | None = None     # Bottle Tree item id (echoed back)
    currency: str = "USD"


class PhotoFindings(BaseModel):
    kind: str
    object_type: str = ""
    materials: list[str] = []
    construction: list[str] = []
    condition: list[str] = []
    transcribed_text: list[str] = []
    notable_features: list[str] = []
    raw: dict[str, Any] = {}
    error: str | None = None


class PriceRange(BaseModel):
    low: float
    high: float
    suggested_retail: float
    floor: float
    currency: str = "USD"
    basis: str = ""


class Identification(BaseModel):
    name: str
    category: str = ""
    maker: str = ""
    origin: str = ""
    period: str = ""
    style: str = ""


class Comparable(BaseModel):
    title: str
    price: float | None = None
    url: str = ""
    source: str = ""
    note: str = ""


class Listing(BaseModel):
    title: str
    description: str
    tags: list[str] = []
    condition_grade: str = ""


class Appraisal(BaseModel):
    item_id: str | None = None
    identification: Identification
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = []
    transcribed_text: list[str] = []
    price_range: PriceRange
    comparables: list[Comparable] = []
    listing: Listing
    questions_for_dealer: list[str] = []
    photo_findings: list[PhotoFindings] = []
    models: dict[str, str] = {}
    warnings: list[str] = []

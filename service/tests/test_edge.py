"""Edge mode: brain selection + offline outbox."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app import brains as brains_mod
from app import outbox as outbox_mod
from app.schemas import PhotoIn


class _Client:
    def __init__(self, ok: bool):
        self.ok = ok
        self.models = self

    async def list(self):
        if not self.ok:
            raise httpx.ConnectError("down")
        return type("R", (), {"data": []})()


def _brain(kind, ok):
    b = brains_mod.Nebius.__new__(brains_mod.Nebius)
    b.kind, b.client, b.reachable, b.available = kind, _Client(ok), ok, []
    b.text_model, b.vision_model = "m", "v"
    return b


def test_auto_prefers_cloud_and_falls_back(monkeypatch):
    monkeypatch.setattr(brains_mod.settings, "mode", "auto")
    monkeypatch.setattr(brains_mod.settings, "nebius_api_key", "k")
    monkeypatch.setattr(brains_mod.Nebius, "edge", classmethod(lambda cls: _brain("edge", True)))
    monkeypatch.setattr(brains_mod, "Nebius", brains_mod.Nebius)
    b = brains_mod.Brains()
    b.cloud, b.edge = _brain("cloud", True), _brain("edge", True)
    assert asyncio.run(b.pick()).kind == "cloud"
    b.cloud.client.ok = False
    b._cloud_ok_until = 0
    assert asyncio.run(b.pick()).kind == "edge"
    b.cloud.client.ok = True
    assert asyncio.run(b.pick()).kind == "cloud"   # recovers when the network is back


def test_edge_mode_never_touches_cloud(monkeypatch):
    monkeypatch.setattr(brains_mod.settings, "mode", "edge")
    monkeypatch.setattr(brains_mod.settings, "nebius_api_key", "")
    monkeypatch.setattr(brains_mod.Nebius, "edge", classmethod(lambda cls: _brain("edge", True)))
    b = brains_mod.Brains()
    assert b.cloud is None and asyncio.run(b.pick()).kind == "edge"


def test_cloud_mode_without_key_is_503ish(monkeypatch):
    monkeypatch.setattr(brains_mod.settings, "mode", "cloud")
    monkeypatch.setattr(brains_mod.settings, "nebius_api_key", "")
    b = brains_mod.Brains()
    with pytest.raises(RuntimeError):
        asyncio.run(b.pick())


def test_outbox_queues_and_syncs(tmp_path, monkeypatch):
    ob = outbox_mod.Outbox(str(tmp_path / "ob"))
    photos = [PhotoIn(url="data:image/jpeg;base64,/9j/AAAA", kind="front"), PhotoIn(url="data:image/png;base64,iVBORw0KGgo=", kind="marks")]
    eid = ob.add(photos, description="chair", markings="STICKLEY", appraisal=json.dumps({"x": 1}), title="T", price="12")
    assert ob.pending() == 1
    meta = json.loads((tmp_path / "ob" / eid / "meta.json").read_text())
    assert [f["kind"] for f in meta["files"]] == ["front", "marks"] and meta["markings"] == "STICKLEY"

    # not configured -> no-op
    monkeypatch.setattr(outbox_mod.settings, "bottletree_url", "")
    assert asyncio.run(ob.sync()) == 0 and ob.pending() == 1

    # configured, offline -> stays queued
    monkeypatch.setattr(outbox_mod.settings, "bottletree_url", "https://bt.example")
    monkeypatch.setattr(outbox_mod.settings, "bottletree_device_key", "dk")
    calls = []

    class FakeResp:
        def __init__(self, code, body): self.status_code, self._b, self.text = code, body, json.dumps(body)
        def json(self): return self._b

    class FakeClient:
        mode = "offline"
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, files=None, data=None, headers=None):
            calls.append((url, data["kinds"], headers["x-device-key"], len(files)))
            if FakeClient.mode == "offline":
                raise httpx.ConnectError("no wifi")
            return FakeResp(200, {"item_id": "it-1"})

    monkeypatch.setattr(outbox_mod.httpx, "AsyncClient", FakeClient)
    assert asyncio.run(ob.sync()) == 0 and ob.pending() == 1
    FakeClient.mode = "online"
    assert asyncio.run(ob.sync()) == 1 and ob.pending() == 0
    assert calls[-1] == ("https://bt.example/api/device/intake", "front,marks", "dk", 2)
